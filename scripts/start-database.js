'use strict';

/**
 * Starts the embedded PostgreSQL server (leinelissen/embedded-postgres).
 *
 * Data is persisted in .pgdata and survives restarts. Keeps running until the
 * process is terminated (Ctrl+C / SIGINT / SIGTERM).
 *
 * Usage:
 *   node scripts/start-database.js
 */

const path = require('path');
const fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;

const PGDATA = path.join(__dirname, '..', '.pgdata');
const PORT = Number(process.env.PGPORT) || 55458;
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || 'postgres';
const DATABASE = process.env.PGDATABASE || 'rz_dispatch';

async function main() {
  console.log(`Starting embedded PostgreSQL on 127.0.0.1:${PORT}...`);

  const pg = new EmbeddedPostgres({
    databaseDir: PGDATA,
    user: USER,
    password: PASSWORD,
    authMethod: 'scram-sha-256',
    port: PORT,
    persistent: true,
    onLog: () => {}
  });

  const alreadyInitialised = fs.existsSync(path.join(PGDATA, 'PG_VERSION'));
  if (alreadyInitialised) {
    fs.rmSync(path.join(PGDATA, 'postmaster.pid'), { force: true });
    fs.rmSync(path.join(PGDATA, 'postmaster.opts'), { force: true });
  } else {
    await pg.initialise();
  }
  await pg.start();

  try {
    await pg.createDatabase(DATABASE);
    console.log(`Database "${DATABASE}" ready.`);
  } catch (error) {
    // Database already exists (or is the default) — not an error.
    console.log(`Database "${DATABASE}" already exists.`);
  }

  console.log(`Embedded PostgreSQL is running on 127.0.0.1:${PORT}; press Ctrl+C to stop.`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping embedded PostgreSQL...');
    try {
      await pg.stop();
    } catch (error) {
      console.error('Stop failed:', error.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start embedded PostgreSQL:', error.message);
  process.exit(1);
});