const mysql = require('mysql2/promise');

const useSsl = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
const requestedPool = Number(process.env.DB_POOL_LIMIT || 4);
const safePoolLimit = Number.isFinite(requestedPool)
  ? Math.max(1, Math.min(requestedPool, 5))
  : 4;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lastseen',
  waitForConnections: true,
  connectionLimit: safePoolLimit,
  queueLimit: 0,
  ssl: useSsl ? {} : undefined,
});

module.exports = pool;
