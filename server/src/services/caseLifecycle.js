// server/src/services/caseLifecycle.js
// ─────────────────────────────────────────────────────────────────────────────
//  Manages case status transitions and the time-aware urgency decay model.
//
//  Decay schedule (see architecture docs Section 5):
//    0–6h:   urgency stays 10
//    6–24h:  decay 1 step every 6h
//    24–72h: decay 1 step every 12h
//    72h+:   decay 1 step every 24h, floor = 2
// ─────────────────────────────────────────────────────────────────────────────

const db     = require('../db/connection');
const logger = require('../utils/logger');

const PURGE_DELAY_DAYS = 30;

/**
 * Calculate current urgency from opened_at timestamp.
 * @param {Date} openedAt
 * @returns {number} urgency 1-10
 */
function calculateUrgency(openedAt) {
  const hoursElapsed = (Date.now() - openedAt.getTime()) / 3_600_000;

  if (hoursElapsed <= 6)  return 10;
  if (hoursElapsed <= 24) return Math.max(7, 10 - Math.floor((hoursElapsed - 6) / 6));
  if (hoursElapsed <= 72) return Math.max(4, 7 - Math.floor((hoursElapsed - 24) / 12));
  return Math.max(2, 4 - Math.floor((hoursElapsed - 72) / 24));
}

/**
 * Schedule the urgency decay cron (uses setInterval in-process).
 * In production, prefer a dedicated cron service or BullMQ.
 */
async function scheduleUrgencyDecay(caseId) {
  // Check every hour; let calculateUrgency do the real math
  const interval = setInterval(async () => {
    try {
      const [[row]] = await db.execute(
        `SELECT opened_at, status FROM cases WHERE id = ?`, [caseId]
      );
      if (!row || row.status !== 'active') {
        clearInterval(interval);
        return;
      }
      const newUrgency = calculateUrgency(new Date(row.opened_at));
      await db.execute(
        `UPDATE cases SET urgency_level = ? WHERE id = ? AND status = 'active'`,
        [newUrgency, caseId]
      );
    } catch (err) {
      logger.error(`[Lifecycle] Urgency decay error for ${caseId}:`, err.message);
      clearInterval(interval);
    }
  }, 60 * 60 * 1000); // every hour
}

/**
 * Transition a case to 'found' or 'closed'.
 * Sets resolved_at and schedules_purge.
 */
async function resolveCase(caseId, actorId, newStatus = 'found') {
  const now = new Date();
  const purgeDate = new Date(now.getTime() + PURGE_DELAY_DAYS * 86_400_000);

  await db.execute(
    `UPDATE cases
       SET status = ?, resolved_at = ?, scheduled_purge = ?
     WHERE id = ? AND status = 'active'`,
    [newStatus, now, purgeDate, caseId]
  );

  await db.execute(
    `INSERT INTO case_activity_log (case_id, actor_id, action, payload, occurred_at)
     VALUES (?, ?, 'status_changed', ?, NOW())`,
    [caseId, actorId, JSON.stringify({ from: 'active', to: newStatus, scheduledPurge: purgeDate })]
  );

  logger.info(`[Lifecycle] Case ${caseId} → ${newStatus}. Purge scheduled: ${purgeDate.toISOString()}`);
}

/**
 * Run by the scheduledDeletion cron: purge PII from resolved cases past purge date.
 */
async function purgeResolvedCases() {
  const [cases] = await db.execute(
    `SELECT id, case_number FROM cases
     WHERE status IN ('found','closed') AND scheduled_purge <= NOW()
     LIMIT 50`
  );

  for (const c of cases) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Nullify PII fields on missing_persons
      await conn.execute(
        `UPDATE missing_persons SET
           photo_url = NULL, photo_hash = NULL,
           full_name = '[purged]', nickname = NULL,
           distinguishing = NULL, last_seen_notes = NULL
         WHERE case_id = ?`,
        [c.id]
      );

      // Remove AI score rows (contain photo hashes)
      await conn.execute(`DELETE FROM ai_facial_scores WHERE case_id = ?`, [c.id]);

      // Close case
      await conn.execute(
        `UPDATE cases SET status = 'closed', closed_at = NOW(), scheduled_purge = NULL WHERE id = ?`,
        [c.id]
      );

      await conn.execute(
        `INSERT INTO case_activity_log (case_id, actor_id, action, occurred_at)
         VALUES (?, NULL, 'pii_purged', NOW())`,
        [c.id]
      );

      await conn.commit();
      logger.info(`[Purge] Case ${c.case_number} PII purged.`);
    } catch (err) {
      await conn.rollback();
      logger.error(`[Purge] Failed for ${c.case_number}:`, err.message);
    } finally {
      conn.release();
    }
  }
}

module.exports = { calculateUrgency, scheduleUrgencyDecay, resolveCase, purgeResolvedCases };
