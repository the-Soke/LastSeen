module.exports = {
  id: '003_user_auth',
  description: 'Add username/password auth columns and index',
  up: async ({ sequelize }) => {
    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS username VARCHAR(40) NULL,
        ADD COLUMN IF NOT EXISTS password_hash CHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS password_salt CHAR(32) NULL;

      CREATE UNIQUE INDEX uq_users_username ON users (username);
    `).catch(async () => {
      await sequelize.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS username VARCHAR(40) NULL,
          ADD COLUMN IF NOT EXISTS password_hash CHAR(64) NULL,
          ADD COLUMN IF NOT EXISTS password_salt CHAR(32) NULL;
      `);
    });
  },
};

