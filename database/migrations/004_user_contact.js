const { DataTypes } = require('sequelize');

module.exports = {
  id: '004_user_contact',
  description: 'Add reporter email and phone contact fields',
  up: async ({ queryInterface }) => {
    const cols = await queryInterface.describeTable('users');

    if (!cols.email) {
      await queryInterface.addColumn('users', 'email', {
        type: DataTypes.STRING(190),
        allowNull: true,
      });
    }
    if (!cols.phone_e164) {
      await queryInterface.addColumn('users', 'phone_e164', {
        type: DataTypes.STRING(20),
        allowNull: true,
      });
    }

    await addIndexIfMissing(queryInterface, 'users', ['email'], {
      unique: true,
      name: 'uq_users_email',
    });
    await addIndexIfMissing(queryInterface, 'users', ['phone_e164'], {
      name: 'idx_users_phone',
    });
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

