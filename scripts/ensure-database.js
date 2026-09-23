'use strict';

/**
 * Shared "make sure PostgreSQL is reachable" helper for RZ Dispatch.
 *
 * Development runs against an embedded PostgreSQL (data in .pgdata) that you
 * would otherwise have to start by hand (`npm run db:start`). This helper makes
 * every app entrypoint self-sufficient: if the configured port is not
 * accepting connections and no external connection string is set, it starts the
 * embedded cluster and waits until it is really ready -- cleaning up stale
 * postmaster files from a previously interrupted run as it goes.
 *
 * Usage:
 *   const ensureDatabase = require('./ensure-database');
 *   await ensureDatabase();
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const PGDATA = path.join(__dirname, '..', '.pgdata');
const PGPORT_FILE = path.join(__dirname, '..', '.pgport');

/**
 * The port used by the embedded PostgreSQL. Priority: the persisted .pgport
 * file (written when a blocked port forced us to move), then process.env.PGPORT,
 * then a sensible default.
 */
function readPgPortFile() {
  try {
    const value = Number(fs.readFileSync(PGPORT_FILE, 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch (_) { /* no file yet */ }
  return null;
}

function writePgPortFile(port) {
  try {
    fs.writeFileSync(PGPORT_FILE, String(port));
  } catch (_) { /* non-fatal */ }
}

let PORT = readPgPortFile() || Number(process.env.PGPORT) || 55458;
const READY_TIMEOUT_MS = Number(process.env.PG_START_TIMEOUT_MS) || 90000;

async function findFreePort() {
  for (let candidate = 55432; candidate < 55600; candidate += 1) {
    if (!(await isPortOpen(candidate, '127.0.0.1'))) return candidate;
  }
  throw new Error('No free port found for the embedded PostgreSQL.');
}

function isPortOpen(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: host || '127.0.0.1' });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function isDatabaseResponsive() {
  try {
    const db = require('../db');
    await db.all('SELECT 1 AS ok');
    return true;
  } catch (error) {
    return false;
  }
}

function usesExternalDatabase() {
  return Boolean(process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING);
}

/**
 * A force-terminated embedded PostgreSQL on Windows can leave a zombie
 * postmaster behind: the port stays half-open and never answers the login
 * handshake, so new connections time out. Kill any postgres.exe whose command
 * line points at THIS project's .pgdata directory before we start fresh.
 */
function stopStrayPostgres() {
  if (process.platform !== 'win32') return;
  const escaped = PGDATA.replace(/\\/g, '\\\\');
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | " +
    `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    spawnSync('powershell', ['-NoProfile', '-Command', script], { timeout: 15000, windowsHide: true });
  } catch (_) { /* non-fatal */ }
}

async function waitForPortClosed(host) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isPortOpen(PORT, host || '127.0.0.1'))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function ensureDatabase() {
  // If a connection string is supplied, assume PostgreSQL is managed
  // externally; nothing for us to start here.
  if (usesExternalDatabase()) return;

  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD || 'postgres';
  const database = process.env.PGDATABASE || 'rz_dispatch';

  // If the port is already accepting connections AND answers a real query, it
  // is healthy and there is nothing to do.
  if (await isPortOpen(PORT, '127.0.0.1')) {
    if (await isDatabaseResponsive()) return;
    console.log(`PostgreSQL on 127.0.0.1:${PORT} is not responding; restarting it...`);
    // A zombie postmaster can hold the port half-open without ever answering
    // the login handshake. Kill it (this data directory only) and wait for the
    // port to fully close before starting a clean instance.
    stopStrayPostgres();
    await waitForPortClosed('127.0.0.1');
    // If the port is STILL open after the kill, Windows is keeping a stale
    // orphan socket bound to it (the process is gone but the kernel holds the
    // port). No new server can ever bind it, so move to a fresh port and
    // remember the choice so every part of the app follows.
    if (await isPortOpen(PORT, '127.0.0.1')) {
      const nextPort = await findFreePort();
      console.log(`Port ${PORT} is blocked by a stale Windows socket; moving PostgreSQL to port ${nextPort}.`);
      PORT = nextPort;
      writePgPortFile(nextPort);
    }
  }

  console.log(`Embedded PostgreSQL not running on 127.0.0.1:${PORT}; starting it...`);

  const EmbeddedPostgres = require('embedded-postgres').default;
  const pg = new EmbeddedPostgres({
    databaseDir: PGDATA,
    user,
    password,
    authMethod: 'scram-sha-256',
    port: PORT,
    persistent: true,
    onLog: () => {}
  });

  const alreadyInitialised = fs.existsSync(path.join(PGDATA, 'PG_VERSION'));
  if (alreadyInitialised) {
    // Remove leftover lock files from an unclean shutdown; a short delay
    // avoids racing a shutting-down postgres that still owns the port.
    fs.rmSync(path.join(PGDATA, 'postmaster.pid'), { force: true });
    fs.rmSync(path.join(PGDATA, 'postmaster.opts'), { force: true });
  } else {
    await pg.initialise();
  }

  await Promise.race([
    pg.start(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Timed out after ${READY_TIMEOUT_MS}ms waiting for embedded PostgreSQL to start. Check the port ${PORT} and the .pgdata folder.`)),
      READY_TIMEOUT_MS
    ))
  ]);

  try {
    await pg.createDatabase(database);
  } catch (_) {
    // Database already exists -- fine.
  }

  // Confirm the freshly started cluster really answers queries before we
  // consider recovery successful; if not, throw so the caller can retry.
  if (!(await isDatabaseResponsive())) {
    throw new Error('Embedded PostgreSQL started but did not become responsive on 127.0.0.1:' + PORT);
  }
  console.log(`Embedded PostgreSQL started on 127.0.0.1:${PORT}.`);
}

module.exports = { ensureDatabase, isPortOpen, usesExternalDatabase, getPort: () => PORT };