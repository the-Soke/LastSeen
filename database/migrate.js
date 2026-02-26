#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sequelize = require('./config/sequelize');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.js$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

async function ensureMigrationsTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id VARCHAR(120) NOT NULL PRIMARY KEY,
      description VARCHAR(255) NULL,
      applied_at DATETIME NOT NULL DEFAULT NOW()
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function isApplied(id) {
  const [rows] = await sequelize.query('SELECT id FROM _migrations WHERE id = ?', {
    replacements: [id],
  });
  return rows.length > 0;
}

async function markApplied(id, description) {
  await sequelize.query(
    'INSERT INTO _migrations (id, description, applied_at) VALUES (?, ?, NOW())',
    { replacements: [id, description || null] }
  );
}

async function run() {
  try {
    await sequelize.authenticate();
    await ensureMigrationsTable();

    const files = migrationFiles();
    if (!files.length) {
      console.log('[Migrate] No JS migration files found.');
      return;
    }

    const qi = sequelize.getQueryInterface();

    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const migration = require(fullPath);
      const id = migration.id || path.basename(file, '.js');
      const description = migration.description || '';

      if (await isApplied(id)) {
        console.log(`[Migrate] Skip ${id} (already applied)`);
        continue;
      }

      console.log(`[Migrate] Apply ${id}${description ? ` - ${description}` : ''}`);
      await migration.up({
        sequelize,
        queryInterface: qi,
      });
      await markApplied(id, description);
      console.log(`[Migrate] Done ${id}`);
    }

    console.log('[Migrate] All migrations complete.');
  } catch (err) {
    console.error('[Migrate] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

run();

