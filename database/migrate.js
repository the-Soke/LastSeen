#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = __dirname;

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.js$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

async function createConnection() {
  const useSsl = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'lastseen',
    multipleStatements: true,
    ssl: useSsl ? {} : undefined,
  });
}

async function ensureMigrationsTable(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id VARCHAR(120) NOT NULL PRIMARY KEY,
      description VARCHAR(255) NULL,
      applied_at DATETIME NOT NULL DEFAULT NOW()
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function isApplied(conn, id) {
  const [[row]] = await conn.execute(
    'SELECT id FROM _migrations WHERE id = ?',
    [id]
  );
  return !!row;
}

async function markApplied(conn, id, description) {
  await conn.execute(
    'INSERT INTO _migrations (id, description, applied_at) VALUES (?, ?, NOW())',
    [id, description || null]
  );
}

async function executeSqlFile(conn, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  await conn.query(sql);
}

async function run() {
  const conn = await createConnection();
  try {
    await ensureMigrationsTable(conn);
    const files = migrationFiles();
    if (!files.length) {
      console.log('[Migrate] No JS migration files found.');
      return;
    }

    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const migration = require(fullPath);
      const id = migration.id || path.basename(file, '.js');
      const description = migration.description || '';

      if (await isApplied(conn, id)) {
        console.log(`[Migrate] Skip ${id} (already applied)`);
        continue;
      }

      console.log(`[Migrate] Apply ${id}${description ? ` - ${description}` : ''}`);
      await migration.up({
        conn,
        executeSqlFile: (p) => executeSqlFile(conn, p),
      });
      await markApplied(conn, id, description);
      console.log(`[Migrate] Done ${id}`);
    }

    console.log('[Migrate] All migrations complete.');
  } catch (err) {
    console.error('[Migrate] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

run();

