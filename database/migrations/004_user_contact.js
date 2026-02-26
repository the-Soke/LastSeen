const path = require('path');

module.exports = {
  id: '004_user_contact',
  description: 'Add reporter email and phone contact fields',
  up: async ({ executeSqlFile }) => {
    await executeSqlFile(path.join(__dirname, '004_user_contact.sql'));
  },
};

