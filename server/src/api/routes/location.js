// server/src/api/routes/location.js
// ─────────────────────────────────────────────────────────────────────────────
//  Location ping endpoints.
//
//  POST /api/location/ping   — Store a location ping from the PWA
//  DELETE /api/location/me   — User requests immediate deletion of their history
//
//  Privacy design:
//   • Pings are stored for max 72h (MySQL event purges them nightly).
//   • accuracy_m is stored so queries can optionally filter poor GPS fixes.
//   • We never reconstruct a movement trail — only point-in-time lookups.
//   • The endpoint requires authentication (req.user set by authenticate middleware).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');

const db     = require('../../db/connection');
const logger = require('../../utils/logger');

const pingValidation = [
  body('lat').isFloat({ min: -90,  max: 90  }).withMessage('Invalid latitude.'),
  body('lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude.'),
  body('recordedAt').isISO8601().withMessage('recordedAt must be ISO 8601.'),
  body('accuracyM').optional({ nullable: true }).isInt({ min: 0, max: 50000 }),
];

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/location/ping
//  Body: { lat, lng, recordedAt, accuracyM? }
//  The PWA sends this on a background timer (every ~5 min when app is open).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ping', pingValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });

  const { lat, lng, recordedAt, accuracyM } = req.body;

  // Reject pings with poor accuracy (>200m) — they add noise to witness queries
  if (accuracyM !== undefined && accuracyM !== null && accuracyM > 200) {
    return res.status(200).json({ accepted: false, reason: 'accuracy_too_low' });
  }

  try {
    await db.execute(
      `INSERT INTO location_history (user_id, lat, lng, accuracy_m, recorded_at, synced_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, lat, lng, accuracyM || null, new Date(recordedAt)]
    );

    // Also update users.last_known_lat/lng for the simple radius query fallback
    await db.execute(
      `UPDATE users SET last_known_lat=?, last_known_lng=?, location_updated_at=NOW()
       WHERE id=?`,
      [lat, lng, userId]
    );

    return res.status(201).json({ accepted: true });
  } catch (err) {
    logger.error('[Location] Ping insert failed:', err.message);
    return res.status(500).json({ error: 'Could not save location ping.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/location/ping/batch
//  Body: { pings: [{ lat, lng, recordedAt, accuracyM? }, …] }
//  Used by the SW offline queue — flushes accumulated pings on reconnect.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ping/batch', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });

  const pings = req.body?.pings;
  if (!Array.isArray(pings) || !pings.length) {
    return res.status(422).json({ error: 'pings must be a non-empty array.' });
  }

  // Validate and filter
  const valid = pings
    .filter(p =>
      p.lat >= -90 && p.lat <= 90 &&
      p.lng >= -180 && p.lng <= 180 &&
      p.recordedAt &&
      (!p.accuracyM || p.accuracyM <= 200)
    )
    .slice(0, 100); // max 100 per batch

  if (!valid.length) {
    return res.status(200).json({ inserted: 0, reason: 'no_valid_pings' });
  }

  const rows = valid.map(p => [
    userId, p.lat, p.lng, p.accuracyM || null, new Date(p.recordedAt), new Date()
  ]);

  try {
    await db.query(
      `INSERT INTO location_history (user_id, lat, lng, accuracy_m, recorded_at, synced_at)
       VALUES ?`,
      [rows]
    );

    // Update last_known from the most recent ping
    const latest = valid.reduce((a, b) =>
      new Date(a.recordedAt) > new Date(b.recordedAt) ? a : b
    );
    await db.execute(
      `UPDATE users SET last_known_lat=?, last_known_lng=?, location_updated_at=NOW()
       WHERE id=?`,
      [latest.lat, latest.lng, userId]
    );

    return res.status(201).json({ inserted: rows.length });
  } catch (err) {
    logger.error('[Location] Batch ping failed:', err.message);
    return res.status(500).json({ error: 'Could not save location batch.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/location/me
//  Immediately purges ALL location history for the authenticated user.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/me', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const [result] = await db.execute(
      `DELETE FROM location_history WHERE user_id = ?`,
      [userId]
    );
    await db.execute(
      `UPDATE users SET last_known_lat=NULL, last_known_lng=NULL,
       location_updated_at=NULL WHERE id=?`,
      [userId]
    );
    return res.json({ deleted: result.affectedRows });
  } catch (err) {
    logger.error('[Location] Delete failed:', err.message);
    return res.status(500).json({ error: 'Could not delete location history.' });
  }
});

module.exports = router;
