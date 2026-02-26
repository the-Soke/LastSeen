// server/src/api/routes/push.js
// ─────────────────────────────────────────────────────────────────────────────
//  Web Push subscription management endpoints.
//
//  POST   /api/push/subscribe     — Register or update a push subscription
//  DELETE /api/push/unsubscribe   — Opt out of push alerts
//  GET    /api/push/vapid-key     — Serve the public VAPID key to the PWA
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');

const { saveSubscription } = require('../../services/notificationService');
const db     = require('../../db/connection');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/push/vapid-key
//  Returns the public VAPID key so the PWA can call
//  serviceWorkerRegistration.pushManager.subscribe({ applicationServerKey })
// ─────────────────────────────────────────────────────────────────────────────
router.get('/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push not configured.' });
  res.json({ publicKey: key });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/push/subscribe
//  Body: { subscription: { endpoint, keys: { p256dh, auth } }, radiusKm? }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/subscribe',
  [
    body('subscription.endpoint').isURL().withMessage('Invalid endpoint URL.'),
    body('subscription.keys.p256dh').notEmpty(),
    body('subscription.keys.auth').notEmpty(),
    body('radiusKm').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    const { subscription, radiusKm } = req.body;

    try {
      await saveSubscription(userId, subscription);

      if (radiusKm) {
        await db.execute(
          `UPDATE push_subscriptions SET radius_override_km=? WHERE user_id=?`,
          [radiusKm, userId]
        );
      }

      logger.info(`[Push] Subscription saved for user ${userId}`);
      return res.status(201).json({ subscribed: true });
    } catch (err) {
      logger.error('[Push] Subscribe failed:', err.message);
      return res.status(500).json({ error: 'Could not save subscription.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/push/unsubscribe
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/unsubscribe', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });

  try {
    // Soft opt-out: keeps the row but sets alerts_enabled=0
    // so subscription can be re-enabled without re-registration
    await db.execute(
      `UPDATE push_subscriptions SET alerts_enabled=0 WHERE user_id=?`,
      [userId]
    );
    return res.json({ unsubscribed: true });
  } catch (err) {
    logger.error('[Push] Unsubscribe failed:', err.message);
    return res.status(500).json({ error: 'Could not unsubscribe.' });
  }
});

module.exports = router;
