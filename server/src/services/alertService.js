// server/src/services/alertService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Targeted Witness Alert Dispatcher
//
//  Flow:
//    1. findWitnessesNearEvent()  → temporal+spatial SQL query
//    2. Filter already-alerted users (dedup via DB unique key)
//    3. Batch INSERT witness_alerts rows
//    4. sendPushBatch()           → parallel Web Push with error handling
//    5. Mark sent / failed / expired in DB
//    6. Log everything in case_activity_log
// ─────────────────────────────────────────────────────────────────────────────

const { v4: uuidv4 }              = require('uuid');
const db                          = require('../db/connection');
const { findWitnessesNearEvent }  = require('./witnessQuery');
const notificationSvc             = require('./notificationService');
const logger                      = require('../utils/logger');

// ── Push concurrency cap — avoids hammering the push service ──────────────────
const PUSH_CONCURRENCY = 25;

/**
 * Main entry point called from reports.js after a new case is created.
 *
 * @param {object} params
 * @param {string} params.caseId
 * @param {string} params.caseNumber       e.g. "LS-2025-00042"
 * @param {number} params.lat              Last-seen latitude
 * @param {number} params.lng              Last-seen longitude
 * @param {Date}   params.lastSeenAt       Exact timestamp child was last seen
 * @param {number} params.urgency          1–10
 * @param {object} params.childDetails     { name, age, gender, clothing, photoUrl }
 */
async function dispatchAlertsForCase({
  caseId, caseNumber,
  lat, lng, lastSeenAt,
  urgency = 10,
  childDetails,
}) {
  const startedAt = Date.now();
  const eventTime = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt || Date.now());

  // ── 1. Find witnesses near the event (temporal + spatial) ─────────────────
  let witnesses;
  try {
    witnesses = await findWitnessesNearEvent({ lat, lng, lastSeenAt: eventTime, urgency });
  } catch (err) {
    logger.error(`[AlertService] Witness query failed for ${caseNumber}:`, err);
    return { dispatched: 0, failed: 0, error: err.message };
  }

  if (!witnesses.length) {
    logger.info(`[AlertService] No witnesses found for ${caseNumber}`);
    await logActivityEntry(caseId, 'alerts_dispatched', {
      caseNumber, witnessesFound: 0, sent: 0, durationMs: Date.now() - startedAt
    });
    return { dispatched: 0, failed: 0 };
  }

  logger.info(`[AlertService] ${witnesses.length} witnesses for ${caseNumber}`);

  // ── 2. Build alert rows + notification payload ────────────────────────────
  const alertRows  = [];
  const sendQueue  = [];  // { alertId, witness }

  for (const w of witnesses) {
    const alertId = uuidv4();

    alertRows.push([
      alertId,
      caseId,
      w.userId,
      lat,
      lng,
      w.effectiveRadiusKm,
      'push',
      w.relevanceScore,
      w.targetingReason,
      'pending',
      new Date(),
    ]);

    sendQueue.push({ alertId, witness: w });
  }

  // ── 3. Batch INSERT witness_alerts (INSERT IGNORE handles dedup constraint) -
  let insertedCount = 0;
  try {
    const [result] = await db.query(
      `INSERT IGNORE INTO witness_alerts
         (id, case_id, user_id, alert_lat, alert_lng, radius_km, channel,
          ai_relevance_score, targeting_reason, status, created_at)
       VALUES ?`,
      [alertRows]
    );
    insertedCount = result.affectedRows;
    logger.info(`[AlertService] Inserted ${insertedCount} alert rows (${alertRows.length - insertedCount} dupes skipped)`);
  } catch (err) {
    logger.error(`[AlertService] Batch insert failed for ${caseNumber}:`, err);
    return { dispatched: 0, failed: witnesses.length, error: err.message };
  }

  // ── 4. Send pushes in controlled-concurrency batches ──────────────────────
  const notificationPayload = buildNotificationPayload(caseId, caseNumber, childDetails, lat, lng);

  let sentCount   = 0;
  let failedCount = 0;
  const expiredTokens = [];

  // Process in chunks of PUSH_CONCURRENCY
  for (let i = 0; i < sendQueue.length; i += PUSH_CONCURRENCY) {
    const chunk = sendQueue.slice(i, i + PUSH_CONCURRENCY);

    const results = await Promise.allSettled(
      chunk.map(({ alertId, witness }) =>
        notificationSvc.sendPushToSubscription(witness.pushSubscription, notificationPayload)
          .then(() => ({ alertId, userId: witness.userId, success: true }))
          .catch(err => ({ alertId, userId: witness.userId, success: false, err }))
      )
    );

    // ── 5. Mark each alert sent / failed in DB ──────────────────────────────
    const sentIds   = [];
    const failedIds = [];

    for (const result of results) {
      const { alertId, userId, success, err } = result.value;
      if (success) {
        sentIds.push(alertId);
        sentCount++;
      } else {
        failedIds.push(alertId);
        failedCount++;

        // 410 Gone = subscription expired → clean up
        if (err?.statusCode === 410) {
          expiredTokens.push(userId);
          logger.info(`[AlertService] Expired subscription for user ${userId}, queuing cleanup`);
        } else {
          logger.warn(`[AlertService] Push failed user ${userId}:`, err?.message);
        }
      }
    }

    if (sentIds.length) {
      await db.query(
        `UPDATE witness_alerts SET status='sent', sent_at=NOW() WHERE id IN (?)`,
        [sentIds]
      ).catch(e => logger.warn('[AlertService] sent_at update failed:', e.message));
    }

    if (failedIds.length) {
      await db.query(
        `UPDATE witness_alerts SET status='dismissed', suppressed=1,
         suppression_reason='push_delivery_failed' WHERE id IN (?)`,
        [failedIds]
      ).catch(e => logger.warn('[AlertService] failed update failed:', e.message));
    }
  }

  // ── 6. Clean up expired subscriptions (async, non-blocking) ──────────────
  if (expiredTokens.length) {
    setImmediate(() => purgeExpiredSubscriptions(expiredTokens));
  }

  // ── 7. Audit log ──────────────────────────────────────────────────────────
  const durationMs = Date.now() - startedAt;
  await logActivityEntry(caseId, 'alerts_dispatched', {
    caseNumber, witnessesFound: witnesses.length,
    inserted: insertedCount, sent: sentCount, failed: failedCount,
    expiredCleaned: expiredTokens.length, durationMs,
  });

  logger.info(
    `[AlertService] ${caseNumber}: ✓ ${sentCount} sent, ✗ ${failedCount} failed in ${durationMs}ms`
  );

  return { dispatched: sentCount, failed: failedCount };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Re-alert: called by urgencyDecay job to send follow-up alerts at lower
//  urgency to NEW users who weren't in range the first time.
// ─────────────────────────────────────────────────────────────────────────────
async function reAlertForCase(caseId) {
  const [[caseRow]] = await db.execute(
    `SELECT c.id, c.case_number, c.urgency_level, c.opened_at,
            mp.last_seen_lat, mp.last_seen_lng, mp.last_seen_at,
            mp.full_name, mp.age_at_report, mp.gender, mp.clothing_desc, mp.photo_url
     FROM cases c JOIN missing_persons mp ON mp.case_id = c.id
     WHERE c.id = ? AND c.status = 'active'`,
    [caseId]
  );

  if (!caseRow) return;

  await dispatchAlertsForCase({
    caseId,
    caseNumber:  caseRow.case_number,
    lat:         caseRow.last_seen_lat,
    lng:         caseRow.last_seen_lng,
    lastSeenAt:  new Date(caseRow.last_seen_at),
    urgency:     caseRow.urgency_level,
    childDetails: {
      name:     caseRow.full_name,
      age:      caseRow.age_at_report,
      gender:   caseRow.gender,
      clothing: caseRow.clothing_desc,
      photoUrl: caseRow.photo_url,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Web Push notification payload object.
 * Localisation hook: extend with i18n lookup on childDetails.locale.
 */
function buildNotificationPayload(caseId, caseNumber, childDetails, lat, lng) {
  const { name, age, gender, clothing, photoUrl } = childDetails;
  const genderLabel = gender === 'male' ? 'boy' : gender === 'female' ? 'girl' : 'child';
  const clothingSnippet = (clothing || '').substring(0, 80);

  return {
    title:   `🚨 Missing ${genderLabel} — ${caseNumber}`,
    body:    `${name}, ${age} years old. Last seen near you. Wearing: ${clothingSnippet}`,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/badge-72.png',
    image:   photoUrl || undefined,    // Rich notification image on Android
    tag:     caseId,                   // Replaces previous alert for same case
    data: {
      caseId,
      caseNumber,
      url:  `/cases/${caseId}`,
      lat, lng,
    },
    actions: [
      { action: 'view',   title: 'View Case'    },
      { action: 'tip',    title: 'I saw them'   },
      { action: 'dismiss',title: 'Not relevant' },
    ],
    requireInteraction: true,
    vibrate:  [200, 100, 200, 100, 400],
    timestamp: Date.now(),
  };
}

async function purgeExpiredSubscriptions(userIds) {
  if (!userIds.length) return;
  try {
    await db.query(
      `DELETE FROM push_subscriptions WHERE user_id IN (?)`,
      [userIds]
    );
    logger.info(`[AlertService] Purged ${userIds.length} expired push subscriptions`);
  } catch (err) {
    logger.warn('[AlertService] Subscription purge failed:', err.message);
  }
}

async function logActivityEntry(caseId, action, payload) {
  try {
    await db.execute(
      `INSERT INTO case_activity_log (case_id, actor_id, action, payload, occurred_at)
       VALUES (?, NULL, ?, ?, NOW())`,
      [caseId, action, JSON.stringify(payload)]
    );
  } catch (err) {
    logger.warn('[AlertService] Activity log write failed:', err.message);
  }
}

module.exports = { dispatchAlertsForCase, reAlertForCase };
