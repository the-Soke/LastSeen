const path = require('path');

module.exports = {
  id: '002_location_history',
  description: 'Add location history and witness alert extensions',
  up: async ({ executeSqlFile }) => {
    await executeSqlFile(path.join(__dirname, '002_location_history.sql'));
  },
};

