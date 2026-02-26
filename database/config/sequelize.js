const { Sequelize } = require('sequelize');

const useSsl = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';

const sequelize = new Sequelize(
  process.env.DB_NAME || 'lastseen',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    logging: false,
    dialectOptions: useSsl ? { ssl: {} } : {},
  }
);

module.exports = sequelize;

