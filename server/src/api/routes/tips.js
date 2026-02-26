const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');

const db = require('../../db/connection');
const { uploadPhoto } = require('../middlewares/uploadHandler');
const { encryptText, decryptText } = require('../../utils/cryptoStore');
const { requireAuth } = require('../middlewares/auth');
const logger = require('../../utils/logger');

const router = express.Router();

const tipValidation = [
  body('caseId').optional().isUUID(),
  body('childId').optional().isUUID(),
  body('sightingAt').isISO8601().withMessage('sightingAt must be ISO 8601.'),
  body('sightingLat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude.'),
  body('sightingLng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude.'),
  body('description').trim().isLength({ min: 5, max: 5000 }).withMessage('Description must be 5-5000 characters.'),
  body('confidence').optional().isIn(['certain', 'likely', 'unsure']),
  body('sightingPlace').optional().trim().isLength({ max: 200 }),
  body('photoBase64').optional({ nullable: true }).isString(),
];

router.post('/', tipValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const {
    caseId: bodyCaseId,
    childId,
    sightingAt,
    sightingLat,
    sightingLng,
    sightingPlace,
    description,
    confidence = 'unsure',
    photoBase64,
  } = req.body;
  const caseId = bodyCaseId || childId;

  if (!caseId) {
    return res.status(422).json({ error: 'A valid caseId or childId is required.' });
  }

  try {
    const [[activeCase]] = await db.execute(
      `SELECT c.id, mp.last_seen_at, mp.last_seen_lat, mp.last_seen_lng
       FROM cases c
       JOIN missing_persons mp ON mp.case_id = c.id
       WHERE c.id = ? AND c.status = 'active'`,
      [caseId]
    );
    if (!activeCase) {
      return res.status(404).json({ error: 'Active case not found.' });
    }

    let photoUrl = null;
    if (photoBase64) {
      try {
        const uploaded = await uploadPhoto(photoBase64, `tips/${uuidv4()}`);
        photoUrl = uploaded.url;
      } catch (err) {
        logger.warn('Tip photo upload failed, continuing without photo:', err.message);
      }
    }

    const tipId = uuidv4();
    const secretKey = crypto.randomBytes(18).toString('base64url');
    const submitterToken = crypto.createHash('sha256').update(secretKey).digest('hex');
    const encryptedDescription = encryptText(description);
    await db.execute(
      `INSERT INTO anonymous_tips
       (id, case_id, submitter_token, sighting_at, sighting_lat, sighting_lng,
        sighting_place, description, confidence, photo_url, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [
        tipId,
        caseId,
        submitterToken,
        new Date(sightingAt),
        sightingLat,
        sightingLng,
        sightingPlace || null,
        encryptedDescription,
        confidence,
        photoUrl,
      ]
    );

    return res.status(201).json({
      success: true,
      tipId,
      secretKey,
      priority: scoreTipPriority({
        caseLastSeenAt: activeCase.last_seen_at,
        caseLat: Number(activeCase.last_seen_lat),
        caseLng: Number(activeCase.last_seen_lng),
        tipAt: new Date(sightingAt),
        tipLat: Number(sightingLat),
        tipLng: Number(sightingLng),
        confidence,
      }),
      message: 'Tip received. Thank you.',
    });
  } catch (err) {
    logger.error('Tip submission failed:', err);
    return res.status(500).json({ error: 'Could not submit tip.' });
  }
});

router.get(
  '/status/:tipId',
  [
    param('tipId').isUUID().withMessage('tipId must be a valid UUID.'),
    body('secretKey').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }

    const { tipId } = req.params;
    const secretKey = (req.query.secretKey || req.body?.secretKey || '').toString().trim();
    if (!secretKey) {
      return res.status(422).json({ error: 'secretKey is required.' });
    }

    try {
      const token = crypto.createHash('sha256').update(secretKey).digest('hex');
      const [[tip]] = await db.execute(
        `SELECT id, case_id, review_status, reviewed_at, review_notes, description, created_at
         FROM anonymous_tips
         WHERE id = ? AND submitter_token = ?`,
        [tipId, token]
      );

      if (!tip) {
        return res.status(404).json({ error: 'Tip not found for this TipID + Secret Key.' });
      }

      const helped = tip.review_status === 'verified' || tip.review_status === 'escalated';
      return res.json({
        tipId: tip.id,
        caseId: tip.case_id,
        reviewStatus: tip.review_status,
        helped,
        reviewedAt: tip.reviewed_at,
        reviewNotes: decryptText(tip.review_notes),
        description: decryptText(tip.description),
        submittedAt: tip.created_at,
      });
    } catch (err) {
      logger.error('Tip status fetch failed:', err);
      return res.status(500).json({ error: 'Could not fetch tip status.' });
    }
  }
);

router.get('/queue', requireAuth, async (req, res) => {
  if (!['coordinator', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Coordinator access required.' });
  }

  const caseId = String(req.query.caseId || '').trim() || null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

  try {
    const params = [];
    let whereCase = '';
    if (caseId) {
      whereCase = 'AND t.case_id = ?';
      params.push(caseId);
    }
    params.push(limit);

    const [rows] = await db.execute(
      `SELECT
         t.id,
         t.case_id,
         t.sighting_at,
         t.sighting_lat,
         t.sighting_lng,
         t.sighting_place,
         t.description,
         t.confidence,
         t.photo_url,
         t.review_status,
         t.created_at,
         c.case_number,
         mp.full_name,
         mp.last_seen_at,
         mp.last_seen_lat,
         mp.last_seen_lng
       FROM anonymous_tips t
       JOIN cases c ON c.id = t.case_id
       JOIN missing_persons mp ON mp.case_id = t.case_id
       WHERE c.status = 'active' AND t.review_status = 'pending' ${whereCase}
       ORDER BY t.created_at DESC
       LIMIT ?`,
      params
    );

    const tips = rows
      .map((row) => ({
        id: row.id,
        caseId: row.case_id,
        caseNumber: row.case_number,
        fullName: row.full_name,
        sightingAt: row.sighting_at,
        sightingPlace: row.sighting_place,
        description: decryptText(row.description),
        confidence: row.confidence,
        photoUrl: row.photo_url,
        createdAt: row.created_at,
        priority: scoreTipPriority({
          caseLastSeenAt: row.last_seen_at,
          caseLat: Number(row.last_seen_lat),
          caseLng: Number(row.last_seen_lng),
          tipAt: new Date(row.sighting_at),
          tipLat: Number(row.sighting_lat),
          tipLng: Number(row.sighting_lng),
          confidence: row.confidence,
        }),
      }))
      .sort((a, b) => b.priority.score - a.priority.score);

    return res.json({ tips, count: tips.length });
  } catch (err) {
    logger.error('Tip queue fetch failed:', err);
    return res.status(500).json({ error: 'Could not load tip queue.' });
  }
});

module.exports = router;

function scoreTipPriority({ caseLastSeenAt, caseLat, caseLng, tipAt, tipLat, tipLng, confidence }) {
  const distanceKm = haversineKm(caseLat, caseLng, tipLat, tipLng);
  const hoursGap = Math.abs(tipAt.getTime() - new Date(caseLastSeenAt).getTime()) / 3_600_000;
  const confidenceBonus = confidence === 'certain' ? 15 : confidence === 'likely' ? 8 : 2;

  const raw = 100 - (distanceKm * 10) - (hoursGap * 1.5) + confidenceBonus;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const tier = score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low';

  return {
    score,
    tier,
    distanceKm: Number(distanceKm.toFixed(2)),
    hoursFromEvent: Number(hoursGap.toFixed(2)),
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
