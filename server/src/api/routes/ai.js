// server/src/api/routes/ai.js
// ─────────────────────────────────────────────────────────────────────────────
//  AI Assistive Analysis Endpoints
//
//  POST /api/ai/facial-compare      Compare a tip photo against a case photo
//  POST /api/ai/memory-match        Score a text description against active cases
//  POST /api/ai/verify/:scoreId     Human confirms/rejects an AI result
//  GET  /api/ai/queue               List AI results awaiting human review
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const db                = require('../../db/connection');
const facialSimilarity  = require('../../services/ai/facialSimilarity');
const memoryMatcher     = require('../../services/ai/memoryMatcher');
const caseUpdateNotifier = require('../../services/caseUpdateNotifier');
const notificationSvc   = require('../../services/notificationService');
const logger            = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/facial-compare
//  Body: { caseId, queryPhotoBase64, sourceType?, sourceRefId? }
//
//  Compares the query photo against the case's reference photo.
//  Saves result in ai_facial_scores with requires_review=1.
//  Returns the score + label immediately so the UI can display it.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/facial-compare',
  [
    body('caseId').isUUID().withMessage('Valid caseId required.'),
    body('queryPhotoBase64').notEmpty().withMessage('queryPhotoBase64 required.'),
    body('sourceType').optional().isIn(['tip_photo','new_upload','system']),
    body('sourceRefId').optional().isUUID(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { caseId, queryPhotoBase64, sourceType = 'new_upload', sourceRefId } = req.body;

    try {
      // 1. Fetch reference photo for this case
      const [[caseRow]] = await db.execute(
        `SELECT mp.photo_url, mp.photo_hash, mp.full_name, c.case_number, c.created_by
         FROM cases c JOIN missing_persons mp ON mp.case_id = c.id
         WHERE c.id = ? AND c.status = 'active'`,
        [caseId]
      );

      if (!caseRow) return res.status(404).json({ error: 'Active case not found.' });
      if (!caseRow.photo_url) {
        return res.status(409).json({ error: 'No reference photo on file for this case.' });
      }

      // 2. Run facial comparison
      const result = await facialSimilarity.compareFaces(
        caseRow.photo_url,      // reference: path or URL resolved by loadImage
        queryPhotoBase64        // query: base64 from witness/tip
      );

      if (result.similarityScore === null || Number.isNaN(Number(result.similarityScore))) {
        return res.status(422).json({
          error: result.error || 'FACE_COMPARE_NO_SCORE',
          referenceDetected: result.referenceDetected,
          queryDetected: result.queryDetected,
          requiresHumanReview: true,
        });
      }

      // 3. Compute query photo hash for dedup
      const crypto = require('crypto');
      const queryHash = crypto
        .createHash('sha256')
        .update(queryPhotoBase64.split(',')[1] || queryPhotoBase64)
        .digest('hex');

      // 4. Persist score to DB
      const scoreId = uuidv4();
      await db.execute(
        `INSERT INTO ai_facial_scores
           (id, case_id, source_type, source_ref_id, source_photo_hash,
            similarity_score, model_version, computed_at, requires_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 1)`,
        [
          scoreId, caseId, sourceType, sourceRefId || null, queryHash,
          result.similarityScore !== null ? result.similarityScore / 100 : null,
          result.modelVersion,
        ]
      );

      // 4b. If score > 50, notify reporter by email/SMS contact.
      if (Number(result.similarityScore) > 50 && looksLikeUuid(caseRow.created_by)) {
        const [[reporter]] = await db.execute(
          `SELECT id, email, phone_e164
           FROM users
           WHERE id = ? AND is_active = 1`,
          [caseRow.created_by]
        );
        if (reporter && (reporter.email || reporter.phone_e164)) {
          await notificationSvc.notifyReporterHighScore({
            userId: reporter.id,
            caseNumber: caseRow.case_number,
            score: result.similarityScore,
            fullName: caseRow.full_name,
            email: reporter.email,
            phoneE164: reporter.phone_e164,
          });
        }
      }

      // 5. Return result with label
      const label = result.similarityScore !== null
        ? facialSimilarity.scoreToLabel(result.similarityScore)
        : null;

      return res.status(201).json({
        scoreId,
        similarityScore:     result.similarityScore,
        similarityRaw:       result.similarityRaw,
        referenceDetected:   result.referenceDetected,
        queryDetected:       result.queryDetected,
        label,
        requiresHumanReview: true,
        error:               result.error || null,
      });

    } catch (err) {
      logger.error('[AI] facial-compare error:', err);
      return res.status(500).json({ error: 'Facial comparison failed.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/memory-match
//  Body: { description, caseId? }
//
//  If caseId is provided: score the description against that one case.
//  If not: score against all active cases and return ranked results.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/memory-match',
  [
    body('description')
      .trim().notEmpty().isLength({ min: 10, max: 2000 })
      .withMessage('Description must be 10–2000 characters.'),
    body('caseId').optional().isUUID(),
    body('tipId').optional().isUUID(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { description, caseId, tipId } = req.body;

    try {
      // Fetch active case(s)
      let cases;
      if (caseId) {
        const [rows] = await db.execute(
          `SELECT c.id AS caseId, c.case_number AS caseNumber,
                  mp.gender, mp.age_at_report AS ageAtReport,
                  mp.skin_tone AS skinTone, mp.hair_color AS hairColor,
                  mp.hair_style AS hairStyle, mp.clothing_desc AS clothingDesc,
                  mp.last_seen_place AS lastSeenPlace, mp.full_name AS fullName
           FROM cases c JOIN missing_persons mp ON mp.case_id = c.id
           WHERE c.id = ? AND c.status = 'active'`,
          [caseId]
        );
        cases = rows;
      } else {
        const [rows] = await db.execute(
          `SELECT c.id AS caseId, c.case_number AS caseNumber,
                  mp.gender, mp.age_at_report AS ageAtReport,
                  mp.skin_tone AS skinTone, mp.hair_color AS hairColor,
                  mp.hair_style AS hairStyle, mp.clothing_desc AS clothingDesc,
                  mp.last_seen_place AS lastSeenPlace, mp.full_name AS fullName
           FROM cases c JOIN missing_persons mp ON mp.case_id = c.id
           WHERE c.status = 'active'
           ORDER BY c.urgency_level DESC LIMIT 50`
        );
        cases = rows;
      }

      if (!cases.length) {
        return res.json({ results: [], message: 'No active cases to match against.' });
      }

      // Run memory matching
      const ranked = memoryMatcher.rankCasesFromDescription(description, cases);

      // Persist the top result (score >= 30) to ai_memory_matches
      const savedIds = {};
      for (const match of ranked.filter(m => m.matchScore >= 30)) {
        const matchId = uuidv4();
        await db.execute(
          `INSERT INTO ai_memory_matches
             (id, case_id, tip_id, raw_description,
              parsed_age, parsed_gender, parsed_skin_tone, parsed_hair, parsed_clothing, parsed_location,
              match_score, matched_fields, model_version, computed_at, requires_review)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 1)`,
          [
            matchId,
            match.caseId,
            tipId || null,
            description,
            match.parsedFeatures.age,
            match.parsedFeatures.gender,
            match.parsedFeatures.skinTone,
            match.parsedFeatures.hair ? match.parsedFeatures.hair.join(', ') : null,
            match.parsedFeatures.clothing.length
              ? match.parsedFeatures.clothing.map(c => `${c.colour ? c.colour + ' ' : ''}${c.item}`).join(', ')
              : null,
            match.parsedFeatures.location ? match.parsedFeatures.location.join(', ') : null,
            match.matchScore / 100,
            JSON.stringify(match.matchedFields),
            match.modelVersion,
          ]
        );
        savedIds[match.caseId] = matchId;
      }

      // Return results with labels
      const results = ranked.map(m => ({
        caseId:     m.caseId,
        caseNumber: m.caseNumber,
        matchId:    savedIds[m.caseId] || null,
        matchScore: m.matchScore,
        label:      memoryMatcher.scoreToLabel(m.matchScore),
        parsedFeatures: m.parsedFeatures,
        fieldScores:    m.fieldScores,
        matchedFields:  m.matchedFields,
        requiresHumanReview: true,
      }));

      return res.json({ results, totalCasesEvaluated: cases.length });

    } catch (err) {
      logger.error('[AI] memory-match error:', err);
      return res.status(500).json({ error: 'Memory matching failed.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/verify/:type/:scoreId
//  type: 'facial' | 'memory'
//  Body: { outcome, notes }
//
//  Human coordinator marks an AI result as confirmed/rejected/inconclusive.
//  This is the mandatory human-in-the-loop gate.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/verify/:type/:scoreId',
  [
    param('type').isIn(['facial', 'memory']),
    param('scoreId').isUUID(),
    body('outcome').isIn(['confirmed_match','rejected','inconclusive']),
    body('notes').optional().trim().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const verifierId = req.user?.id || null;

    const { type, scoreId } = req.params;
    const { outcome, notes } = req.body;

    const table = type === 'facial' ? 'ai_facial_scores' : 'ai_memory_matches';
    const outcomeCol = type === 'facial' ? 'verification_outcome' : 'review_outcome';
    const notesCol   = type === 'facial' ? 'verification_notes'   : null;
    const normalisedOutcome = type === 'memory'
      ? ({
          confirmed_match: 'useful',
          rejected: 'misleading',
          inconclusive: 'inconclusive',
        }[outcome] || 'inconclusive')
      : outcome;

    try {
      const setClause = notesCol
        ? `requires_review=0, verified_by=?, verified_at=NOW(), ${outcomeCol}=?, ${notesCol}=?`
        : `requires_review=0, reviewed_by=?, reviewed_at=NOW(), ${outcomeCol}=?`;

      const params = notesCol
        ? [verifierId, normalisedOutcome, notes || null, scoreId]
        : [verifierId, normalisedOutcome, scoreId];

      const [result] = await db.execute(
        `UPDATE ${table} SET ${setClause} WHERE id=? AND requires_review=1`,
        params
      );

      if (!result.affectedRows) {
        return res.status(404).json({ error: 'Score not found or already reviewed.' });
      }

      // If a confirmed facial match → log to case activity
      if (type === 'facial' && outcome === 'confirmed_match') {
        const [[score]] = await db.execute(
          `SELECT afs.case_id, c.case_number, c.created_by, mp.full_name
           FROM ai_facial_scores afs
           JOIN cases c ON c.id = afs.case_id
           JOIN missing_persons mp ON mp.case_id = c.id
           WHERE afs.id=?`,
          [scoreId]
        );
        if (score) {
          await db.execute(
            `INSERT INTO case_activity_log (case_id, actor_id, action, payload, occurred_at)
             VALUES (?, ?, 'facial_match_confirmed', ?, NOW())`,
            [score.case_id, verifierId, JSON.stringify({ scoreId, outcome, notes })]
          );

          const coordinatorIds = await caseUpdateNotifier.fetchCoordinatorIds();
          const stakeholderIds = [
            ...coordinatorIds,
            looksLikeUuid(score.created_by) ? score.created_by : null,
          ];
          const payload = caseUpdateNotifier.buildMatchConfirmedPayload(
            score.case_id,
            score.case_number,
            score.full_name
          );
          await caseUpdateNotifier.notifyUsers(stakeholderIds, payload, {
            type: 'case_update',
            summary: `AI match confirmed for ${score.case_number}`,
          });
        }
      }

      return res.json({ verified: true, scoreId, outcome: normalisedOutcome });

    } catch (err) {
      logger.error('[AI] verify error:', err);
      return res.status(500).json({ error: 'Verification update failed.' });
    }
  }
);

function looksLikeUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/ai/queue
//  Returns all unreviewed AI scores for the coordinator dashboard.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/queue', async (req, res) => {
  try {
    const [facial] = await db.execute(
      `SELECT afs.id, afs.case_id, afs.similarity_score, afs.model_version,
              afs.computed_at, afs.source_type,
              c.case_number, mp.full_name, mp.photo_url
       FROM ai_facial_scores afs
       JOIN cases c ON c.id = afs.case_id
       JOIN missing_persons mp ON mp.case_id = c.id
       WHERE afs.requires_review = 1 AND c.status = 'active'
       ORDER BY afs.similarity_score DESC
       LIMIT 50`
    );

    const [memory] = await db.execute(
      `SELECT amm.id, amm.case_id, amm.match_score, amm.model_version,
              amm.computed_at, amm.raw_description, amm.matched_fields,
              c.case_number, mp.full_name
       FROM ai_memory_matches amm
       JOIN cases c ON c.id = amm.case_id
       JOIN missing_persons mp ON mp.case_id = c.id
       WHERE amm.requires_review = 1 AND c.status = 'active'
       ORDER BY amm.match_score DESC
       LIMIT 50`
    );

    // Normalise scores to 0–100 for the UI (DB stores 0–1)
    const normalisedFacial = facial.map(f => ({
      ...f,
      similarity_score: Math.round((f.similarity_score || 0) * 100),
      type: 'facial',
    }));

    const normalisedMemory = memory.map(m => ({
      ...m,
      match_score: Math.round((m.match_score || 0) * 100),
      type: 'memory',
    }));

    return res.json({
      facial: normalisedFacial,
      memory: normalisedMemory,
      totalPending: facial.length + memory.length,
    });

  } catch (err) {
    logger.error('[AI] queue fetch error:', err);
    return res.status(500).json({ error: 'Could not fetch review queue.' });
  }
});

module.exports = router;
