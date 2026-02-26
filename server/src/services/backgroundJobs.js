const db = require('../db/connection');
const logger = require('../utils/logger');
const caseLifecycle = require('./caseLifecycle');
const alertService = require('./alertService');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let started = false;
let timers = [];

async function runUrgencySweep() {
  const [rows] = await db.execute(
    `SELECT id, opened_at, urgency_level
     FROM cases
     WHERE status = 'active'
     LIMIT 500`
  );

  for (const row of rows) {
    const nextUrgency = caseLifecycle.calculateUrgency(new Date(row.opened_at));
    if (Number(row.urgency_level) !== Number(nextUrgency)) {
      await db.execute(
        `UPDATE cases SET urgency_level = ? WHERE id = ? AND status = 'active'`,
        [nextUrgency, row.id]
      );
    }
  }
}

async function runReAlertSweep() {
  const [rows] = await db.execute(
    `SELECT id, opened_at, urgency_level
     FROM cases
     WHERE status = 'active'
       AND opened_at <= NOW() - INTERVAL 1 HOUR
     LIMIT 100`
  );

  for (const row of rows) {
    const recalculated = caseLifecycle.calculateUrgency(new Date(row.opened_at));
    if (Number(recalculated) < Number(row.urgency_level)) {
      await alertService.reAlertForCase(row.id);
    }
  }
}

async function purgeOldLocationHistory() {
  const [result] = await db.execute(
    `DELETE FROM location_history
     WHERE recorded_at < NOW() - INTERVAL 72 HOUR
     LIMIT 5000`
  );
  if (result.affectedRows) {
    logger.info(`[Jobs] Purged ${result.affectedRows} location ping rows older than 72h`);
  }
}

function schedule(fn, everyMs, label, initialDelayMs = everyMs) {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      logger.error(`[Jobs] ${label} failed:`, err.message);
    }
  };
  const timeout = setTimeout(() => {
    run().catch(() => {});
    timers.push(setInterval(run, everyMs));
  }, initialDelayMs);
  timers.push(timeout);
}

function startBackgroundJobs() {
  if (started) return;
  started = true;

  if (String(process.env.ENABLE_BACKGROUND_JOBS || 'true').toLowerCase() === 'false') {
    logger.info('[Jobs] Background jobs disabled by ENABLE_BACKGROUND_JOBS=false');
    return;
  }

  // Stagger first runs to avoid opening too many DB connections at startup.
  schedule(runUrgencySweep, HOUR_MS, 'urgency sweep', 2 * 60 * 1000);
  schedule(runReAlertSweep, HOUR_MS, 're-alert sweep', 4 * 60 * 1000);
  schedule(() => caseLifecycle.purgeResolvedCases(), DAY_MS, 'case PII purge', 10 * 60 * 1000);
  schedule(purgeOldLocationHistory, DAY_MS, 'location purge', 12 * 60 * 1000);

  logger.info('[Jobs] Background jobs started');
}

function stopBackgroundJobs() {
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers = [];
  started = false;
}

module.exports = {
  startBackgroundJobs,
  stopBackgroundJobs,
};
