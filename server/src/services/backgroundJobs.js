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

function schedule(fn, everyMs, label) {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      logger.error(`[Jobs] ${label} failed:`, err.message);
    }
  };
  run().catch(() => {});
  timers.push(setInterval(run, everyMs));
}

function startBackgroundJobs() {
  if (started) return;
  started = true;

  schedule(runUrgencySweep, HOUR_MS, 'urgency sweep');
  schedule(runReAlertSweep, HOUR_MS, 're-alert sweep');
  schedule(() => caseLifecycle.purgeResolvedCases(), DAY_MS, 'case PII purge');
  schedule(purgeOldLocationHistory, DAY_MS, 'location purge');

  logger.info('[Jobs] Background jobs started');
}

function stopBackgroundJobs() {
  for (const t of timers) clearInterval(t);
  timers = [];
  started = false;
}

module.exports = {
  startBackgroundJobs,
  stopBackgroundJobs,
};

