-- ─────────────────────────────────────────────────────────────────────────────
--  LastSeen — Migration 002: Location History + Alert Indexes
--  Adds the location_history table required for temporal witness queries.
--  Users passively log location pings here (from the PWA background sync).
--  Run: mysql -u root -p lastseen < 002_location_history.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
--  location_history
--  Each row = one GPS ping from a user's device.
--  Retention policy: rows older than 72 hours are purged nightly (job below).
--  We never store a continuous movement trail — only periodic check-ins.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_history (
  id          BIGINT UNSIGNED  AUTO_INCREMENT NOT NULL,
  user_id     CHAR(36)         NOT NULL,
  lat         DECIMAL(9,6)     NOT NULL,
  lng         DECIMAL(9,6)     NOT NULL,
  accuracy_m  SMALLINT UNSIGNED    NULL  COMMENT 'GPS accuracy in metres',
  recorded_at DATETIME         NOT NULL   COMMENT 'When the ping was captured on device',
  synced_at   DATETIME         NOT NULL DEFAULT NOW() COMMENT 'When it reached the server',

  PRIMARY KEY (id),
  CONSTRAINT fk_lh_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Core query: find users near a point at a specific time window
  INDEX idx_lh_time_geo (recorded_at, lat, lng),

  -- Purge job needs to scan by time only
  INDEX idx_lh_recorded (recorded_at)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='72-hour rolling location ping log. PII-minimised: no route reconstruction.';


-- ─────────────────────────────────────────────────────────────────────────────
--  Add suppression tracking to witness_alerts
--  Prevents the same user getting duplicate alerts for the same case.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE witness_alerts
  ADD COLUMN IF NOT EXISTS suppressed      TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = alert was generated but not sent (dedup / opt-out)',
  ADD COLUMN IF NOT EXISTS suppression_reason VARCHAR(100) NULL,
  ADD UNIQUE KEY uq_alert_case_user (case_id, user_id)
    COMMENT 'One alert per user per case — enforced at DB level';


-- ─────────────────────────────────────────────────────────────────────────────
--  Push subscription table (extended from v1)
--  Adds opt-out and radius override so users control their alert preferences.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS alerts_enabled TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS radius_override_km SMALLINT UNSIGNED NULL
    COMMENT 'Overrides users.preferred_radius_km for push targeting if set';


-- ─────────────────────────────────────────────────────────────────────────────
--  Nightly purge event (MySQL Event Scheduler must be ON)
--  SET GLOBAL event_scheduler = ON;
-- ─────────────────────────────────────────────────────────────────────────────
DROP EVENT IF EXISTS purge_old_location_history;
CREATE EVENT purge_old_location_history
  ON SCHEDULE EVERY 1 DAY
  STARTS (CURRENT_DATE + INTERVAL 1 DAY + INTERVAL 2 HOUR)  -- runs at 02:00 daily
  DO
    DELETE FROM location_history
    WHERE recorded_at < NOW() - INTERVAL 72 HOUR;
