module.exports = {
  id: '004_user_contact',
  description: 'Add reporter email and phone contact fields',
  up: async ({ sequelize }) => {
    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email VARCHAR(190) NULL,
        ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR(20) NULL;
    `);

    await sequelize.query(`CREATE UNIQUE INDEX uq_users_email ON users (email);`)
      .catch(() => {});
    await sequelize.query(`CREATE INDEX idx_users_phone ON users (phone_e164);`)
      .catch(() => {});
  },
};

