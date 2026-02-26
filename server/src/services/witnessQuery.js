// server/src/services/witnessQuery.js
// ─────────────────────────────────────────────────────────────────────────────
//  Temporal + Spatial Witness Finder
//
//  Core problem: "Who was near [lat, lng] at approximately [time]?"
//
//  Strategy:
//    1. BOUNDING BOX pre-filter  — cheap, uses the composite index on
//       (recorded_at, lat, lng) to eliminate >99% of rows instantly.
//    2. HAVERSINE distance calc  — exact great-circle distance, applied only
//       to the small bounding-box survivors.
//    3. TIME WINDOW filter       — ± TIME_WINDOW_MINUTES around last_seen_at.
//    4. DEDUP per user           — if a user had multiple pings in the window,
//       keep only the one closest to the event location.
//    5. RELEVANCE SCORING        — composite score from distance + temporal
//       proximity, used to rank and optionally cap alerts.
//
//  MySQL Haversine formula (no PostGIS required):
//    d = 6371 × ACOS(
//          COS(RADIANS(lat1)) × COS(RADIANS(lat2))
//          × COS(RADIANS(lng2) - RADIANS(lng1))
//          + SIN(RADIANS(lat1)) × SIN(RADIANS(lat2))
//        )
//
//  Bounding box math:
//    1° latitude  ≈ 111.0 km  (constant)
//    1° longitude ≈ 111.0 × COS(RADIANS(lat)) km  (varies)
//    lat_delta  = radius_km / 111.0
//    lng_delta  = radius_km / (111.0 × COS(RADIANS(center_lat)))
// ─────────────────────────────────────────────────────────────────────────────

const db     = require('../db/connection');
const logger = require('../utils/logger');

// ── Tuning constants ──────────────────────────────────────────────────────────

/** How many minutes either side of last_seen_at to search for witnesses. */
const TIME_WINDOW_MINUTES = 30;

/** Fixed 5km radius as specified in the feature requirement. */
const BASE_RADIUS_KM = 5;

/** Urgency multiplies the radius (from architecture spec Section 5). */
const URGENCY_MULTIPLIER = {
  high:   1.5,  // urgency 8–10 → 7.5km
  medium: 1.0,  // urgency 4–7  → 5.0km
  low:    0.5,  // urgency 1–3  → 2.5km
};

/** Cap: never alert more than this many users per case (avoids spam). */
const MAX_ALERTS_PER_CASE = 500;

/**
 * @typedef {Object} WitnessCandidate
 * @property {string}  userId
 * @property {string}  pushToken          - JSON-stringified PushSubscription
 * @property {number}  distanceKm         - Distance from event to closest ping
 * @property {number}  minutesFromEvent   - Temporal distance of closest ping
 * @property {number}  relevanceScore     - 0.000–1.000 composite score
 * @property {string}  targetingReason    - Human-readable audit string
 * @property {number}  effectiveRadiusKm  - The radius used for this candidate
 * @property {string}  locale
 */

/**
 * Find users who were near a location at a specific time.
 *
 * @param {object} params
 * @param {number} params.lat            Last-seen latitude
 * @param {number} params.lng            Last-seen longitude
 * @param {Date}   params.lastSeenAt     Exact time child was last seen
 * @param {number} [params.urgency=10]   Case urgency level (1–10)
 * @param {number} [params.radiusKm]     Override radius (default BASE_RADIUS_KM)
 * @returns {Promise<WitnessCandidate[]>}
 */
async function findWitnessesNearEvent({ lat, lng, lastSeenAt, urgency = 10, radiusKm }) {
  if (!(lastSeenAt instanceof Date) || Number.isNaN(lastSeenAt.getTime())) {
    throw new Error('Invalid lastSeenAt timestamp.');
  }

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new Error('Invalid event coordinates.');
  }

  const multiplier = urgency >= 8 ? URGENCY_MULTIPLIER.high
    : urgency >= 4               ? URGENCY_MULTIPLIER.medium
    : URGENCY_MULTIPLIER.low;

  const effectiveRadius = (radiusKm ?? BASE_RADIUS_KM) * multiplier;

  // ── 1. Bounding box deltas ────────────────────────────────────────────────
  const latDelta = effectiveRadius / 111.0;
  const lngDelta = effectiveRadius / (111.0 * Math.cos(toRad(latNum)));

  const windowStart = new Date(lastSeenAt.getTime() - TIME_WINDOW_MINUTES * 60_000);
  const windowEnd   = new Date(lastSeenAt.getTime() + TIME_WINDOW_MINUTES * 60_000);

  logger.debug(
    `[WitnessQuery] Searching r=${effectiveRadius}km, ` +
    `window ${windowStart.toISOString()} → ${windowEnd.toISOString()}`
  );

  // ── 2. Main query ─────────────────────────────────────────────────────────
  //  Subquery: find every ping inside the bounding box + time window,
  //            compute exact Haversine distance.
  //  Outer query: per-user, keep only the closest ping (MIN distance),
  //               join push subscription and filter opt-outs.
  const [rows] = await db.query(
    `
    SELECT
      u.id                                     AS userId,
      u.locale,
      ps.endpoint                              AS pushEndpoint,
      ps.p256dh_key                            AS p256dhKey,
      ps.auth_key                              AS authKey,
      u.preferred_radius_km,
      ps.radius_override_km,

      -- Closest ping distance (km)
      MIN(pings.distance_km)                   AS distanceKm,

      -- Temporal gap of the closest ping (minutes from event)
      ABS(
        TIMESTAMPDIFF(SECOND, pings.recorded_at, ?)
      ) / 60.0                                 AS minutesFromEvent

    FROM (
      -- ── Inner: bounding box + Haversine + time window ──────────────────
      SELECT
        lh.user_id,
        lh.recorded_at,
        (6371 * ACOS(
          LEAST(1.0,                            -- guard against float errors > 1
            COS(RADIANS(?)) * COS(RADIANS(lh.lat))
            * COS(RADIANS(lh.lng) - RADIANS(?))
            + SIN(RADIANS(?)) * SIN(RADIANS(lh.lat))
          )
        )) AS distance_km

      FROM location_history lh

      WHERE
        -- Bounding box pre-filter (uses composite index idx_lh_time_geo)
        lh.recorded_at BETWEEN ? AND ?
        AND lh.lat     BETWEEN ? AND ?
        AND lh.lng     BETWEEN ? AND ?

    ) AS pings

    JOIN users u
      ON u.id = pings.user_id
      AND u.is_active = 1

    JOIN push_subscriptions ps
      ON ps.user_id = u.id
      AND ps.alerts_enabled = 1       -- respect opt-out

    -- Exact radius filter: use override if set, else preferred, capped at effectiveRadius
    WHERE pings.distance_km <= LEAST(
      ?,
      COALESCE(ps.radius_override_km, u.preferred_radius_km, ?)
    )

    GROUP BY
      u.id, u.locale, ps.endpoint, ps.p256dh_key, ps.auth_key,
      u.preferred_radius_km, ps.radius_override_km

    ORDER BY distanceKm ASC

    LIMIT ${MAX_ALERTS_PER_CASE}
    `,
    [
      // minutesFromEvent TIMESTAMPDIFF ref
      lastSeenAt,
      // Haversine params (lat, lng, lat, lat)
      latNum, lngNum, latNum,
      // Time window
      windowStart, windowEnd,
      // Bounding box
      latNum - latDelta, latNum + latDelta,
      lngNum - lngDelta, lngNum + lngDelta,
      // Radius caps
      effectiveRadius, effectiveRadius,
    ]
  );

  logger.info(`[WitnessQuery] Found ${rows.length} witness candidates within ${effectiveRadius}km`);

  // ── 3. Build result objects with relevance scoring ────────────────────────
  return rows.map(row => {
    // Spatial score: 1.0 at distance=0, 0.0 at distance=effectiveRadius
    const spatialScore   = 1 - (row.distanceKm / effectiveRadius);

    // Temporal score: 1.0 at time=0, 0.0 at time=TIME_WINDOW_MINUTES
    const temporalScore  = 1 - Math.min(1, row.minutesFromEvent / TIME_WINDOW_MINUTES);

    // Weighted composite (spatial matters more than temporal)
    const relevanceScore = Math.max(0, Math.min(1,
      (spatialScore * 0.65) + (temporalScore * 0.35)
    ));

    const effectiveUserRadius = row.radius_override_km ?? row.preferred_radius_km ?? effectiveRadius;

    return {
      userId:           row.userId,
      locale:           row.locale || 'en',
      pushSubscription: {
        endpoint: row.pushEndpoint,
        keys: {
          p256dh: row.p256dhKey,
          auth:   row.authKey,
        }
      },
      distanceKm:        parseFloat(row.distanceKm.toFixed(3)),
      minutesFromEvent:  parseFloat(row.minutesFromEvent.toFixed(1)),
      relevanceScore:    parseFloat(relevanceScore.toFixed(4)),
      effectiveRadiusKm: effectiveRadius,
      targetingReason:   buildTargetingReason(row.distanceKm, row.minutesFromEvent, effectiveUserRadius),
    };
  });
}

/**
 * Build a human-readable targeting audit string.
 * Stored in witness_alerts.targeting_reason for coordinator review.
 */
function buildTargetingReason(distanceKm, minutesFromEvent, radiusKm) {
  const dist = distanceKm < 1
    ? `${Math.round(distanceKm * 1000)}m`
    : `${distanceKm.toFixed(1)}km`;
  const time = minutesFromEvent < 1
    ? 'at the exact time'
    : `${Math.round(minutesFromEvent)} min from event time`;
  return `Location ping: ${dist} from site, ${time} (radius ${radiusKm}km)`;
}

function toRad(deg) { return deg * (Math.PI / 180); }

module.exports = { findWitnessesNearEvent, BASE_RADIUS_KM, TIME_WINDOW_MINUTES };
