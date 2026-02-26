const db = require('../db/connection');
const notificationSvc = require('./notificationService');
const logger = require('../utils/logger');

function uniqueIds(ids) {
  return [...new Set((ids || []).filter(Boolean))];
}

function toSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh_key,
      auth: row.auth_key,
    },
  };
}

async function fetchCoordinatorIds() {
  const [rows] = await db.execute(
    `SELECT id
     FROM users
     WHERE is_active = 1
       AND role IN ('coordinator', 'admin')`
  );
  return rows.map((r) => r.id);
}

async function fetchAlertedUserIds(caseId) {
  const [rows] = await db.execute(
    `SELECT DISTINCT user_id
     FROM witness_alerts
     WHERE case_id = ?`,
    [caseId]
  );
  return rows.map((r) => r.user_id);
}

async function notifyUsers(userIds, payload, opts = {}) {
  const ids = uniqueIds(userIds);
  if (!ids.length) return { sent: 0, failed: 0 };

  const [subs] = await db.query(
    `SELECT user_id, endpoint, p256dh_key, auth_key
     FROM push_subscriptions
     WHERE user_id IN (?)`,
    [ids]
  );

  if (!subs.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    subs.map(async (row) => {
      const userId = row.user_id;
      const subscription = toSubscription(row);
      try {
        await notificationSvc.sendPushToSubscription(subscription, payload);
        sent += 1;
        await notificationSvc.logNotification({
          userId,
          alertId: null,
          type: opts.type || 'case_update',
          channel: 'push',
          payloadSummary: opts.summary || payload.title,
          status: 'sent',
        });
      } catch (err) {
        failed += 1;
        await notificationSvc.logNotification({
          userId,
          alertId: null,
          type: opts.type || 'case_update',
          channel: 'push',
          payloadSummary: opts.summary || payload.title,
          status: 'failed',
        });
        logger.warn(`[CaseUpdateNotifier] Push failed for user ${userId}: ${err.message}`);
      }
    })
  );

  return { sent, failed };
}

function buildMatchConfirmedPayload(caseId, caseNumber, fullName) {
  return {
    title: `Match confirmed: ${caseNumber}`,
    body: `A coordinator confirmed an AI facial match for ${fullName || 'this case'}.`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `case-update-${caseId}`,
    data: {
      caseId,
      caseNumber,
      url: `/ai`,
    },
    requireInteraction: true,
    timestamp: Date.now(),
  };
}

function buildCaseResolvedPayload(caseId, caseNumber, fullName, status) {
  const label = status === 'found' ? 'found' : 'closed';
  return {
    title: `Case ${label}: ${caseNumber}`,
    body: `${fullName || 'The child'} has been marked as ${label}.`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `case-status-${caseId}`,
    data: {
      caseId,
      caseNumber,
      status,
      url: `/feed`,
    },
    requireInteraction: false,
    timestamp: Date.now(),
  };
}

module.exports = {
  fetchCoordinatorIds,
  fetchAlertedUserIds,
  notifyUsers,
  buildMatchConfirmedPayload,
  buildCaseResolvedPayload,
};
