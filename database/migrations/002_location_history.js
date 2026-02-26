module.exports = {
  id: '002_location_history',
  description: 'Add location history and alert preference extensions',
  up: async ({ sequelize }) => {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS location_history (
        id          BIGINT UNSIGNED  AUTO_INCREMENT NOT NULL,
        user_id     CHAR(36)         NOT NULL,
        lat         DECIMAL(9,6)     NOT NULL,
        lng         DECIMAL(9,6)     NOT NULL,
        accuracy_m  SMALLINT UNSIGNED    NULL,
        recorded_at DATETIME         NOT NULL,
        synced_at   DATETIME         NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        CONSTRAINT fk_lh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_lh_time_geo (recorded_at, lat, lng),
        INDEX idx_lh_recorded (recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      ALTER TABLE witness_alerts
        ADD COLUMN IF NOT EXISTS suppressed TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS suppression_reason VARCHAR(100) NULL,
        ADD UNIQUE KEY uq_alert_case_user (case_id, user_id);

      ALTER TABLE push_subscriptions
        ADD COLUMN IF NOT EXISTS alerts_enabled TINYINT(1) NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS radius_override_km SMALLINT UNSIGNED NULL;
    `);
  },
};

