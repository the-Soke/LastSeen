const path = require('path');

module.exports = {
  id: '001_initial_schema',
  description: 'Create initial LastSeen schema',
  up: async ({ executeSqlFile }) => {
    await executeSqlFile(path.join(__dirname, '001_initial_schema.sql'));
  },
};

