const fs = require('fs');
const path = require('path');
const db = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function runMigrations() {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('[migrate] No migrations directory found; nothing to do.');
    return { applied: [], skipped: [] };
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied = [];
  const skipped = [];
  for (const file of files) {
    const existing = await db.get('SELECT name FROM schema_migrations WHERE name = ?', file);
    if (existing) { skipped.push(file); continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await db.exec(statement);
    }
    await db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, new Date().toISOString());
    applied.push(file);
    console.log(`[migrate] applied ${file}`);
  }
  console.log(`[migrate] done (applied: ${applied.length}, already applied: ${skipped.length})`);
  return { applied, skipped };
}

module.exports = { runMigrations };

if (require.main === module) {
  (async () => {
    const { ensureDatabase } = require('./ensure-database');
    const { initializeDatabase } = require('../server');
    await ensureDatabase();
    await initializeDatabase();
    await runMigrations();
    const db = require('../db');
    await db.close();
    process.exit(0);
  })().catch((error) => { console.error('[migrate] failed:', error); process.exit(1); });
}