// server/src/api/routes/reports.js
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/reports   â€” Create a new missing child report
//  GET  /api/reports   â€” List active cases (coordinators only)
//  GET  /api/reports/:caseId â€” Single case detail
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 }   = require('uuid');
const { body, param, validationResult } = require('express-validator');

const db               = require('../../db/connection');
const { uploadPhoto }  = require('../middlewares/uploadHandler');
const { generateCaseNumber } = require('../../utils/caseNumber');
const alertService     = require('../../services/alertService');
const caseLifecycle    = require('../../services/caseLifecycle');
const caseUpdateNotifier = require('../../services/caseUpdateNotifier');
const logger           = require('../../utils/logger');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  Validation rules
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const reportValidation = [
  body('fullName')
    .trim().notEmpty().withMessage('Full name is required.')
    .isLength({ max: 120 }),
  body('age')
    .isInt({ min: 0, max: 17 }).withMessage('Age must be between 0 and 17.'),
  body('gender')
    .isIn(['male','female','other','unknown']).withMessage('Invalid gender value.'),
  body('lastSeenAt')
    .isISO8601().withMessage('Last seen date/time is required and must be ISO 8601.'),
  body('lastSeenLat')
    .isFloat({ min: -90,  max: 90  }).withMessage('Invalid latitude.'),
  body('lastSeenLng')
    .isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude.'),
  body('clothing')
    .trim().notEmpty().withMessage('Clothing description is required.'),
  // Optional fields
  body('nickname').optional().trim().isLength({ max: 60 }),
  body('heightCm').optional({ nullable: true }).isInt({ min: 50, max: 220 }),
  body('weightKg').optional({ nullable: true }).isInt({ min: 5,  max: 150 }),
  body('skinTone').optional({ nullable: true })
    .isIn(['very_light','light','medium','dark','very_dark','']),
  body('hairColor').optional().trim().isLength({ max: 40 }),
  body('hairStyle').optional().trim().isLength({ max: 60 }),
  body('eyeColor').optional().trim().isLength({ max: 40 }),
  body('distinguishing').optional().trim(),
  body('lastSeenPlace').optional().trim().isLength({ max: 200 }),
  body('lastSeenNotes').optional().trim(),
  body('photoBase64').optional({ nullable: true }).isString(),
];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/reports
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/', reportValidation, async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Please log in before filing a report.' });
  }

  // 1. Validate input
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const {
    fullName, nickname, age, gender,
    lastSeenAt, lastSeenLat, lastSeenLng, lastSeenPlace, lastSeenNotes,
    heightCm, weightKg, skinTone,
    hairColor, hairStyle, eyeColor,
    clothing, distinguishing,
    photoBase64,
  } = req.body;

  // 2. Handle optional photo upload (base64 â†’ buffer â†’ storage)
  let photoUrl  = null;
  let photoHash = null;
  if (photoBase64) {
    try {
      const result = await uploadPhoto(photoBase64, `reports/${uuidv4()}`);
      photoUrl  = result.url;
      photoHash = result.hash;
    } catch (err) {
      logger.warn('Photo upload failed:', err.message);
      return res.status(422).json({
        error: `Photo upload failed: ${err.message}`,
      });
    }
  }

  // 3. Begin transaction
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 3a. Insert case record
    const caseId     = uuidv4();
    const caseNumber  = generateCaseNumber();
    const creatorId = req.user.id;

    await conn.execute(
      `INSERT INTO cases
         (id, case_number, status, urgency_level, opened_at, created_by)
       VALUES (?, ?, 'active', 10, NOW(), ?)`,
      [caseId, caseNumber, creatorId]
    );

    // 3b. Insert missing_persons record
    const personId = uuidv4();

    await conn.execute(
      `INSERT INTO missing_persons (
         id, case_id,
         full_name, nickname, age_at_report, gender,
         height_cm, weight_kg, skin_tone,
         hair_color, hair_style, eye_color,
         clothing_desc, distinguishing,
         last_seen_at, last_seen_lat, last_seen_lng,
         last_seen_place, last_seen_notes,
         photo_url, photo_hash,
         created_at
       ) VALUES (
         ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?,
         NOW()
       )`,
      [
        personId, caseId,
        fullName, nickname || null, age, gender,
        heightCm || null, weightKg || null, skinTone || null,
        hairColor || null, hairStyle || null, eyeColor || null,
        clothing, distinguishing || null,
        new Date(lastSeenAt), lastSeenLat, lastSeenLng,
        lastSeenPlace || null, lastSeenNotes || null,
        photoUrl, photoHash,
      ]
    );

    // 3c. Audit log
    await conn.execute(
      `INSERT INTO case_activity_log (case_id, actor_id, action, payload, occurred_at)
       VALUES (?, ?, 'case_opened', ?, NOW())`,
      [caseId, req.user?.id || null, JSON.stringify({ caseNumber, source: 'web_report' })]
    );

    await conn.commit();

    logger.info(`Case ${caseNumber} created (ID: ${caseId})`);

    // 4. Trigger alert dispatch (async â€” don't block the HTTP response)
    setImmediate(() => {
      alertService.dispatchAlertsForCase({
        caseId,
        caseNumber,
        lastSeenAt: new Date(lastSeenAt),
        lat: lastSeenLat,
        lng: lastSeenLng,
        urgency: 10,
        childDetails: {
          name: fullName,
          age,
          gender,
          clothing,
          photoUrl,
        },
      }).catch(err => logger.error('Alert dispatch error:', err));
    });

    return res.status(201).json({
      success:    true,
      caseId,
      caseNumber,
      message:    'Report filed. Alerts are being dispatched.',
    });

  } catch (err) {
    await conn.rollback();
    logger.error('Report creation failed:', err);
    return res.status(500).json({ error: 'Report could not be saved. Please try again.' });
  } finally {
    conn.release();
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GET /api/reports  (active cases â€” coordinators)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/', async (req, res) => {
  try {
    const { status = 'active', limit = 20, offset = 0 } = req.query;
    const safeLimit = clampInt(limit, 1, 200, 20);
    const safeOffset = clampInt(offset, 0, 10000, 0);

    const [rows] = await db.query(
      `SELECT
         c.id, c.case_number, c.status, c.urgency_level, c.opened_at, c.resolved_at, c.closed_at,
         mp.full_name, mp.nickname, mp.age_at_report, mp.gender,
         mp.last_seen_at, mp.last_seen_lat, mp.last_seen_lng, mp.last_seen_place,
         mp.clothing_desc, mp.photo_url,
         mp.skin_tone, mp.hair_color, mp.hair_style
       FROM cases c
       JOIN missing_persons mp ON mp.case_id = c.id
       WHERE c.status = ?
       ORDER BY c.urgency_level DESC, c.opened_at DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      [String(status)]
    );

    return res.json({ cases: rows, count: rows.length });
  } catch (err) {
    logger.error('Cases fetch error:', err);
    return res.status(500).json({ error: 'Could not fetch cases.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /api/reports/:caseId/status
//  Body: { status: 'found' | 'closed', notes? }
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:caseId/status',
  [
    param('caseId').isUUID().withMessage('caseId must be a valid UUID.'),
    body('status').isIn(['found', 'closed']).withMessage('status must be found or closed.'),
    body('notes').optional().trim().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { caseId } = req.params;
    const { status, notes } = req.body;
    const actorId = req.user?.id || null;

    try {
      const [[caseRow]] = await db.execute(
        `SELECT c.id, c.case_number, c.status, c.created_by, mp.full_name
         FROM cases c
         JOIN missing_persons mp ON mp.case_id = c.id
         WHERE c.id = ?`,
        [caseId]
      );

      if (!caseRow) return res.status(404).json({ error: 'Case not found.' });
      if (caseRow.status !== 'active') {
        return res.status(409).json({ error: `Only active cases can be updated. Current status: ${caseRow.status}.` });
      }

      await caseLifecycle.resolveCase(caseId, actorId, status);

      if (notes) {
        await db.execute(
          `INSERT INTO case_activity_log (case_id, actor_id, action, payload, occurred_at)
           VALUES (?, ?, 'status_note', ?, NOW())`,
          [caseId, actorId, JSON.stringify({ status, notes })]
        );
      }

      const coordinatorIds = await caseUpdateNotifier.fetchCoordinatorIds();
      const alertedUserIds = await caseUpdateNotifier.fetchAlertedUserIds(caseId);
      const stakeholderIds = [
        ...coordinatorIds,
        ...alertedUserIds,
        looksLikeUuid(caseRow.created_by) ? caseRow.created_by : null,
      ];
      const payload = caseUpdateNotifier.buildCaseResolvedPayload(
        caseId,
        caseRow.case_number,
        caseRow.full_name,
        status
      );
      const notifyStats = await caseUpdateNotifier.notifyUsers(stakeholderIds, payload, {
        type: 'case_update',
        summary: `Case ${caseRow.case_number} marked ${status}`,
      });

      return res.json({
        success: true,
        caseId,
        status,
        caseNumber: caseRow.case_number,
        notifications: notifyStats,
      });
    } catch (err) {
      logger.error('Case status update failed:', err);
      return res.status(500).json({ error: 'Could not update case status.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /api/reports/:caseId/resolve
//  Reporter flow: requires login and ownership
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:caseId/resolve',
  [
    param('caseId').isUUID().withMessage('caseId must be a valid UUID.'),
    body('notes').optional().trim().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required.' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { caseId } = req.params;
    const { notes } = req.body;

    try {
      const [[caseRow]] = await db.execute(
        `SELECT c.id, c.case_number, c.status, c.created_by, mp.full_name
         FROM cases c
         JOIN missing_persons mp ON mp.case_id = c.id
         WHERE c.id = ?`,
        [caseId]
      );
      if (!caseRow) return res.status(404).json({ error: 'Case not found.' });
      if (caseRow.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Only the reporter who created this case can resolve it.' });
      }
      if (caseRow.status !== 'active') {
        return res.status(409).json({ error: `Case is already ${caseRow.status}.` });
      }

      await caseLifecycle.resolveCase(caseId, req.user.id, 'found');
      await db.execute(
        `INSERT INTO case_activity_log (case_id, actor_id, action, payload, occurred_at)
         VALUES (?, ?, 'reporter_marked_found', ?, NOW())`,
        [caseId, req.user.id, JSON.stringify({ notes: notes || null })]
      );

      const coordinatorIds = await caseUpdateNotifier.fetchCoordinatorIds();
      const alertedUserIds = await caseUpdateNotifier.fetchAlertedUserIds(caseId);
      const stakeholderIds = [
        ...coordinatorIds,
        ...alertedUserIds,
        looksLikeUuid(caseRow.created_by) ? caseRow.created_by : null,
      ];
      const payload = caseUpdateNotifier.buildCaseResolvedPayload(
        caseId,
        caseRow.case_number,
        caseRow.full_name,
        'found'
      );
      const notifyStats = await caseUpdateNotifier.notifyUsers(stakeholderIds, payload, {
        type: 'case_update',
        summary: `Reporter marked ${caseRow.case_number} as found`,
      });

      return res.json({
        success: true,
        caseId,
        caseNumber: caseRow.case_number,
        status: 'found',
        notifications: notifyStats,
      });
    } catch (err) {
      logger.error('Reporter resolve failed:', err);
      return res.status(500).json({ error: 'Could not resolve case.' });
    }
  }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GET /api/reports/:caseId
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/:caseId', async (req, res) => {
  try {
    const { caseId } = req.params;

    const [[caseRow]] = await db.execute(
      `SELECT c.*, mp.*
       FROM cases c
       JOIN missing_persons mp ON mp.case_id = c.id
       WHERE c.id = ?`,
      [caseId]
    );

    if (!caseRow) return res.status(404).json({ error: 'Case not found.' });

    // Fetch recent tips count (without exposing tip content to public)
    const [[{ tipCount }]] = await db.execute(
      `SELECT COUNT(*) AS tipCount FROM anonymous_tips WHERE case_id = ? AND review_status != 'rejected'`,
      [caseId]
    );

    // Fetch recent activity log
    const [activity] = await db.execute(
      `SELECT action, payload, occurred_at
       FROM case_activity_log WHERE case_id = ?
       ORDER BY occurred_at DESC LIMIT 10`,
      [caseId]
    );

    return res.json({ case: caseRow, tipCount, recentActivity: activity });
  } catch (err) {
    logger.error('Case fetch error:', err);
    return res.status(500).json({ error: 'Could not fetch case.' });
  }
});

function looksLikeUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

module.exports = router;

