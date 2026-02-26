const { DataTypes } = require('sequelize');

module.exports = {
  id: '003_user_auth',
  description: 'Add username/password auth columns and index',
  up: async ({ queryInterface }) => {
    const cols = await queryInterface.describeTable('users');

    if (!cols.username) {
      await queryInterface.addColumn('users', 'username', {
        type: DataTypes.STRING(40),
        allowNull: true,
      });
    }
    if (!cols.password_hash) {
      await queryInterface.addColumn('users', 'password_hash', {
        type: DataTypes.CHAR(64),
        allowNull: true,
      });
    }
    if (!cols.password_salt) {
      await queryInterface.addColumn('users', 'password_salt', {
        type: DataTypes.CHAR(32),
        allowNull: true,
      });
    }

    await addIndexIfMissing(queryInterface, 'users', ['username'], {
      unique: true,
      name: 'uq_users_username',
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

