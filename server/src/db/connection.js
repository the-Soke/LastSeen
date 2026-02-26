const mysql = require('mysql2/promise');

const useSsl = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lastseen',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
  queueLimit: 0,
  ssl: useSsl ? {} : undefined,
});

module.exports = pool;
