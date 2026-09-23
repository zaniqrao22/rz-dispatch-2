'use strict';

/**
 * PostgreSQL database layer for RZ Dispatch.
 *
 * Replaces the old better-sqlite3 synchronous connection with an async
 * `pg` (node-postgres) connection pool while keeping a very similar API:
 *
 *   await db.get(sql, ...params)  -> single row object or undefined
 *   await db.all(sql, ...params)  -> array of row objects
 *   await db.run(sql, ...params)  -> { changes, lastInsertRowid }
 *   await db.exec(sql, ...params) -> alias of run (schema DDL)
 *   await db.transaction(fn)      -> runs fn(tx) inside BEGIN/COMMIT
 *   await db.close()              -> releases the pool
 *
 * SQL written for SQLite uses `?` placeholders; they are converted to
 * PostgreSQL `$1, $2, ...` here so the application SQL did not need to change.
 * JS booleans are mapped to 0/1 (the schema stores flag columns as SMALLINT,
 * matching the previous SQLite behaviour) and `undefined` to NULL.
 *
 * The schema plus seed data are created lazily on the first query through
 * `db.setInitializer(fn)` — this keeps both `node server.js` and `node --test`
 * working without any extra bootstrapping.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * The embedded PostgreSQL port, matching scripts/ensure-database.js: a stale
 * .pgport file (written when a blocked port forced us to move) takes
 * precedence so this process talks to the same cluster everywhere.
 */
function readPgPortFile() {
  try {
    const value = Number(fs.readFileSync(path.join(__dirname, '.pgport'), 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch (_) { /* no file yet */ }
  return null;
}

function buildConnectionConfig() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || '';

  const config = {
    // Friendly local defaults so the app boots against a default local install.
    host: process.env.PGHOST || '127.0.0.1',
    port: readPgPortFile() || Number(process.env.PGPORT) || 55458,
    database: process.env.PGDATABASE || 'rz_dispatch',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    max: Math.max(1, Number(process.env.PG_POOL_MAX) || 10),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 5000,
    // Keep the underlying TCP connections alive so an idle embedded
    // PostgreSQL does not reset them and kill the pool.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
  };

  if (connectionString) {
    delete config.host;
    delete config.port;
    delete config.database;
    delete config.user;
    delete config.password;
    config.connectionString = connectionString;
  }

  if (process.env.PGSSL === 'true' || process.env.PG_SSL === 'true') {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

/** Pool is exported for advanced use (e.g. the data migration script). */
const pool = new Pool(buildConnectionConfig());

// The single most important guard: a pg Pool emits an 'error' event when an
// idle client in the pool dies (e.g. the database resets the connection).
// Without a listener Node treats it as an unhandled error and crashes the
// whole server, which is exactly the recurring outage we saw when the
// embedded PostgreSQL dropped connections (read ECONNRESET). Listening here
// logs the drop instead of dying; new queries create a fresh connection.
pool.on('error', (error) => {
  console.error(`[db] Idle client error (pool stays alive): ${error?.code || ''} ${error?.message || error}`);
});

/**
 * Translate application SQL to PostgreSQL dialect:
 *   1. Convert SQLite `?` placeholders to PostgreSQL $1..$n parameters.
 *   2. Quote unquoted `AS alias` column aliases ("AS \"fileName\"") so the
 *      returned row keeps the camelCase key the JavaScript code expects
 *      (PostgreSQL folds unquoted identifiers to lowercase).
 */
function translateSql(sql) {
  let index = 0;
  return String(sql)
    .replace(/\?/g, () => `$${++index}`)
    .replace(/\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi, ' as "$1"');
}

/** Map JS values to values accepted by PostgreSQL. */
function toParam(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Lazy, idempotent schema/seed initialisation.
 * The initializer (server.js's `initializeDatabase`) runs exactly once on the
 * first database access. While it is running, nested db calls are allowed to
 * proceed straight to the pool (guarded by `running`) instead of waiting on a
 * promise that can only resolve after the initializer finishes.
 */
let initializer = null;
let initialized = null;
let running = false;

function ensureReady() {
  if (!initializer || running) return Promise.resolve();
  if (initialized) return initialized;
  running = true;
  initialized = Promise.resolve()
    .then(initializer)
    .then(() => undefined)
    .catch((error) => {
      // Allow a later query to retry if e.g. the database was briefly offline.
      initialized = null;
      throw error;
    })
    .finally(() => {
      running = false;
    });
  return initialized;
}

/** Register the function that creates the schema + seed data. */
function setInitializer(fn) {
  if (typeof fn !== 'function') throw new Error('db.setInitializer expects a function.');
  initializer = fn;
}

async function execute(client, sql, params) {
  const converted = translateSql(sql);
  const values = (params || []).map(toParam);
  return client.query(converted, values);
}

// Connection-level failures that are safe to retry once. Anything else
// (SQL syntax, constraints, etc.) is a real error and passes through.
const RETRYABLE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', '57P01', '57P02', '57P03', '08003', '08006', '53300']);

function isRetryableConnectionError(error) {
  if (!error) return false;
  if (RETRYABLE_CODES.has(String(error.code))) return true;
  const message = String(error.message || '');
  return /connection (was )?(closed|reset|terminated)|terminated due to connection timeout|socket hang up|timeout expired|connection refused|cannot connect now|no more connections|server closed the connection/i.test(message);
}

// Prevents multiple concurrent requests from all trying to restart the
// database at once; they share a single restart and then retry.
let recovering = null;

async function recoverEmbeddedDatabase() {
  if (recovering) return recovering;
  recovering = (async () => {
    const { ensureDatabase } = require('./scripts/ensure-database');
    console.error('[db] Database connection lost; restarting embedded PostgreSQL...');
    try {
      await ensureDatabase();
      console.error('[db] Embedded PostgreSQL recovered.');
    } finally {
      recovering = null;
    }
  })();
  return recovering;
}

async function withConnectionRetry(queryFn) {
  try {
    return await queryFn();
  } catch (error) {
    if (!isRetryableConnectionError(error)) throw error;
    // If we are already inside a database restart (ensureDatabase probes the
    // pool), bail out fast instead of recursing into another restart.
    if (recovering) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      return await queryFn();
    } catch (error2) {
      if (!isRetryableConnectionError(error2)) throw error2;
      // The embedded database server itself may have gone away (this is what
      // killed the backend historically). Restart it, then retry once more.
      await recoverEmbeddedDatabase();
      return queryFn();
    }
  }
}

async function all(sql, ...params) {
  await ensureReady();
  const result = await withConnectionRetry(() => execute(pool, sql, params));
  return result.rows;
}

async function get(sql, ...params) {
  const rows = await all(sql, ...params);
  return rows[0];
}

async function run(sql, ...params) {
  await ensureReady();
  const result = await withConnectionRetry(() => execute(pool, sql, params));
  return { changes: result.rowCount, lastInsertRowid: null };
}

async function exec(sql, ...params) {
  return run(sql, ...params);
}

/**
 * Run fn(tx) inside a PostgreSQL transaction. `tx` exposes the same
 * get/all/run/exec helpers but bound to the transaction connection, so the
 * whole block commits (or rolls back) atomically.
 */
async function transaction(fn) {
  await ensureReady();
  const client = await pool.connect();
  const tx = {};

  tx.get = async (sql, ...params) => {
    const result = await execute(client, sql, params);
    return result.rows[0];
  };
  tx.all = async (sql, ...params) => {
    const result = await execute(client, sql, params);
    return result.rows;
  };
  tx.run = async (sql, ...params) => {
    const result = await execute(client, sql, params);
    return { changes: result.rowCount, lastInsertRowid: null };
  };
  tx.exec = tx.run;

  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Connection may have dropped; nothing else we can do here.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  setInitializer,
  initialize: () => ensureReady(),
  get,
  all,
  run,
  exec,
  transaction,
  close,
  translateSql,
  toParam
};