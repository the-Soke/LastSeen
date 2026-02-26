module.exports = {
  id: '005_notification_email_channel',
  description: 'Allow email in notification channel enum',
  up: async ({ sequelize }) => {
    await sequelize.query(`
      ALTER TABLE notification_log
        MODIFY COLUMN channel ENUM('push','sms','email') NOT NULL;
    `);
  },
};

