const path = require('path');

module.exports = {
  id: '003_user_auth',
  description: 'Add username/password auth columns and index',
  up: async ({ executeSqlFile }) => {
    await executeSqlFile(path.join(__dirname, '003_user_auth.sql'));
  },
};

