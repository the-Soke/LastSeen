const { DataTypes } = require('sequelize');

module.exports = {
  id: '002_location_history',
  description: 'Add location history and alert preference extensions',
  up: async ({ sequelize, queryInterface }) => {
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const wa = await queryInterface.describeTable('witness_alerts');
    if (!wa.suppressed) {
      await queryInterface.addColumn('witness_alerts', 'suppressed', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
    if (!wa.suppression_reason) {
      await queryInterface.addColumn('witness_alerts', 'suppression_reason', {
        type: DataTypes.STRING(100),
        allowNull: true,
      });
    }
    await addIndexIfMissing(queryInterface, 'witness_alerts', ['case_id', 'user_id'], {
      unique: true,
      name: 'uq_alert_case_user',
    });

    const ps = await queryInterface.describeTable('push_subscriptions');
    if (!ps.alerts_enabled) {
      await queryInterface.addColumn('push_subscriptions', 'alerts_enabled', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    }
    if (!ps.radius_override_km) {
      await queryInterface.addColumn('push_subscriptions', 'radius_override_km', {
        type: DataTypes.SMALLINT.UNSIGNED,
        allowNull: true,
      });
    }
  },
};

async function addIndexIfMissing(queryInterface, table, fields, options) {
  try {
    await queryInterface.addIndex(table, fields, options);
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (
      err?.original?.code === 'ER_DUP_KEYNAME' ||
      err?.original?.code === 'ER_DUP_ENTRY' ||
      msg.includes('duplicate') ||
      msg.includes('already exists')
    ) {
      return;
    }
    throw err;
  }
}

