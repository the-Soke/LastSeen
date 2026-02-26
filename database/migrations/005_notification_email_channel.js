const path = require('path');

module.exports = {
  id: '005_notification_email_channel',
  description: 'Allow email in notification channel enum',
  up: async ({ executeSqlFile }) => {
    await executeSqlFile(path.join(__dirname, '005_notification_email_channel.sql'));
  },
};

