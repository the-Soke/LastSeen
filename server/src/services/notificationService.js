const webpush = require('web-push');
const https = require('https');
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const db = require('../db/connection');

let vapidReady = false;

function ensureVapid() {
  if (vapidReady) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@lastseen.app'}`,
    publicKey,
    privateKey
  );
  vapidReady = true;
  return true;
}

async function sendPushToSubscription(subscription, payload) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh) {
    throw new Error('Invalid subscription object - missing endpoint or keys.');
  }
  if (!ensureVapid()) {
    throw new Error('VAPID keys are missing. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
  }

  await webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 3600,
    urgency: 'high',
    topic: payload.tag || 'lastseen-alert',
  });
}

async function sendPush(pushToken, payload) {
  let subscription;
  try {
    subscription = JSON.parse(pushToken);
  } catch {
    throw new Error('Invalid push token - expected JSON string.');
  }

  const notificationPayload = {
    title: payload.title,
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: payload.caseId,
    data: { caseId: payload.caseId, url: payload.caseUrl },
    requireInteraction: true,
  };

  await sendPushToSubscription(subscription, notificationPayload);
}

async function saveSubscription(userId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Incomplete subscription object.');
  }

  await db.execute(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh_key, auth_key, created_at)
     VALUES (UUID(), ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       endpoint = VALUES(endpoint),
       p256dh_key = VALUES(p256dh_key),
       auth_key = VALUES(auth_key)`,
    [userId, endpoint, keys.p256dh, keys.auth]
  );
}

async function sendSMS(phoneE164, message) {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME || 'sandbox';

  if (!phoneE164) throw new Error('Missing destination phone number');
  if (!apiKey) {
    logger.info(`[SMS SIMULATED] -> ${phoneE164}: ${message}`);
    return;
  }

  const body = new URLSearchParams({
    username,
    to: phoneE164,
    message,
  }).toString();

  await new Promise((resolve, reject) => {
    const req = https.request(
      'https://api.africastalking.com/version1/messaging',
      {
        method: 'POST',
        headers: {
          apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(text);
          return reject(new Error(`SMS provider error ${res.statusCode}: ${text}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendEmail(to, subject, text) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@lastseen.app';
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  if (!to) throw new Error('Missing destination email');
  if (!host || !port || !user || !pass) {
    logger.info(`[EMAIL SIMULATED] -> ${to} | ${subject} | ${text}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });
}

async function notifyReporterHighScore({
  userId,
  caseNumber,
  score,
  fullName,
  email,
  phoneE164,
}) {
  const sent = [];
  const failed = [];
  const smsMessage = `LastSeen Alert: AI found ${score}% similarity for case ${caseNumber} (${fullName || 'child'}). Review immediately.`;
  const emailSubject = `LastSeen AI Alert: ${caseNumber} score ${score}%`;
  const emailBody = `A new AI facial comparison scored ${score}% for case ${caseNumber}. Please review in the app.`;

  if (phoneE164) {
    try {
      await sendSMS(phoneE164, smsMessage);
      sent.push('sms');
      await logNotification({
        userId,
        type: 'case_update',
        channel: 'sms',
        payloadSummary: `AI score ${score}% for ${caseNumber}`,
        status: 'sent',
      });
    } catch (err) {
      failed.push(`sms: ${err.message}`);
      await logNotification({
        userId,
        type: 'case_update',
        channel: 'sms',
        payloadSummary: `AI score ${score}% for ${caseNumber}`,
        status: 'failed',
      });
    }
  }

  if (email) {
    try {
      await sendEmail(email, emailSubject, emailBody);
      sent.push('email');
      await logNotification({
        userId,
        type: 'case_update',
        channel: 'email',
        payloadSummary: `AI score ${score}% for ${caseNumber} (email)`,
        status: 'sent',
      });
    } catch (err) {
      failed.push(`email: ${err.message}`);
      await logNotification({
        userId,
        type: 'case_update',
        channel: 'email',
        payloadSummary: `AI score ${score}% for ${caseNumber} (email)`,
        status: 'failed',
      });
    }
  }

  return { sent, failed };
}

async function logNotification({ userId, alertId, type, channel, payloadSummary, status = 'sent' }) {
  try {
    await db.execute(
      `INSERT INTO notification_log (alert_id, user_id, type, channel, payload_summary, status, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [alertId || null, userId || 'system', type, channel, payloadSummary?.substring(0, 200) || null, status]
    );
  } catch (err) {
    logger.warn('[NotificationSvc] Log insert failed:', err.message);
  }
}

module.exports = {
  sendPushToSubscription,
  sendPush,
  saveSubscription,
  sendSMS,
  sendEmail,
  notifyReporterHighScore,
  logNotification,
};
