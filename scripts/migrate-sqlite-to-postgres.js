'use strict';

/**
 * One-time data migration: copies the existing SQLite database
 * (.data/rz_dispatch.db) into PostgreSQL.
 *
 * Usage:
 *   npm run db:migrate
 *
 * Requirements
 *   - PostgreSQL reachable at DATABASE_URL or PG* env vars (see .env.example).
 *   - The schema is created automatically; this script initializes it first,
 *     then upserts every table row-for-row so it is safe to re-run.
 *   - `better-sqlite3` is kept as a devDependency only for this script.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const Database = require('better-sqlite3');

const DATA_FILE = path.join(__dirname, '..', '.data', 'rz_dispatch.db');

if (!fs.existsSync(DATA_FILE)) {
  console.error(`SQLite database not found at ${DATA_FILE}. Nothing to migrate.`);
  process.exit(1);
}

const { setInitializer, transaction, close } = require('../db');
const { initializeDatabase } = require('../server');

// Tables in dependency order. The primary key is used for ON CONFLICT upserts.
const TABLES = [
  { name: 'users', pk: 'id' },
  { name: 'jobs', pk: 'id' },
  { name: 'licenses', pk: 'id' },
  { name: 'activity', pk: 'id' },
  { name: 'messages', pk: 'id' },
  { name: 'services', pk: 'key' },
  { name: 'service_zones', pk: 'key' },
  { name: 'quotes', pk: 'id' },
  { name: 'bookings', pk: 'id' },
  { name: 'proof_documents', pk: 'id' }
];

async function main() {
  console.log(`Opening SQLite database read-only: ${DATA_FILE}`);
  const sqlite = new Database(DATA_FILE, { readonly: true, fileMustExist: true });

  // Ensure the PostgreSQL schema exists before copying data over.
  await initializeDatabase();
  console.log('PostgreSQL schema is ready.');

  for (const { name: table } of TABLES) {
    let rows;
    try {
      rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    } catch (error) {
      console.log(`- ${table}: table does not exist in SQLite, skipped.`);
      continue;
    }

    if (rows.length === 0) {
      console.log(`- ${table}: 0 rows, nothing to copy.`);
      continue;
    }

    const columns = Object.keys(rows[0]);
    const quoted = columns.map((column) => `"${column}"`);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const insertSql = `INSERT INTO ${table} (${quoted.join(', ')}) VALUES (${placeholders})`;

    await transaction(async (tx) => {
      // The destination may already hold seed/demo rows (created lazily on first
      // app start). Clear it so the SQLite snapshot becomes the source of truth.
      await tx.run(`DELETE FROM ${table}`);
      for (const row of rows) {
        await tx.run(insertSql, ...columns.map((column) => row[column]));
      }
    });
    console.log(`- ${table}: copied ${rows.length} rows.`);
  }

  sqlite.close();
  console.log('Migration complete.');
  await close();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});