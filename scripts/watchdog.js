'use strict';

/**
 * Process watchdog for the RZ Dispatch backend.
 *
 * Runs `node server.js` as a DETACHED child and restarts it whenever it exits,
 * so a crash (dropped database, socket failure, anything) never leaves the
 * backend down for more than a few seconds.
 *
 * Detached matters on Windows: the server is launched with its own hidden
 * console, so a Ctrl+C or window-close in whatever terminal started the app
 * can no longer kill PostgreSQL and the backend along with it (that was the
 * recurring "server just died" outage). To stop the app cleanly use
 * `npm run stop` (scripts/stop-app.js).
 *
 * If a backend is already answering on :8000 (e.g. a detached orphan survived
 * the previous console), this watchdog stops that stale backend first and then
 * starts its own fresh one, so `npm start` always leaves exactly one armed
 * backend+watchdog running.
 *
 * Usage: npm start  (or)  node scripts/watchdog.js
 */

const { spawn, execSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const LOG_FILE = path.join(__dirname, '..', '.backend.log');
const PID_FILE = path.join(__dirname, '..', '.watchdog.pid');
const PORT = Number(process.env.PORT) || 8000;
const RESTART_DELAY_MS = Number(process.env.WATCHDOG_RESTART_DELAY_MS) || 3000;
const BACKOFF_DELAY_MS = Number(process.env.WATCHDOG_BACKOFF_DELAY_MS) || 30000;
const BACKOFF_AFTER = 8;
const STOP_GRACE_MS = 3000;

let child = null;
let stopping = false;
let logFd = null;
let consecutiveFailures = 0;

function stamp(message) {
  console.log(`[watchdog ${new Date().toLocaleTimeString()}] ${message}`);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/** PID currently LISTENING on a TCP port (by scanning netstat), or null. */
function listeningPid(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${port} `) && line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

/** PID recorded by the previous watchdog session, or null. */
function previousWatchdogPid() {
  try {
    const value = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_) { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function stopProcessTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      killer.on('close', resolve);
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (_) { /* already gone */ }
      resolve();
    }
  });
}

/**
 * Clear the slate before starting: kill the previous session's watchdog (from
 * .watchdog.pid) and any backend still LISTENING on :8000 (a detached orphan).
 * Path/commandline independent, so it works no matter how the app was launched.
 */
async function cleanStaleProcesses() {
  const staleWatchdog = previousWatchdogPid();
  if (staleWatchdog && staleWatchdog !== process.pid && processAlive(staleWatchdog)) {
    stamp(`stopping previous watchdog (pid ${staleWatchdog}).`);
    await stopProcessTree(staleWatchdog);
  }
  const listener = listeningPid(PORT);
  if (listener && listener !== process.pid) {
    stamp(`stopping stale backend on :${PORT} (pid ${listener}).`);
    await stopProcessTree(listener);
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function startServer() {
  if (stopping) return;

  // Open the log fresh each launch so it never grows unbound.
  if (logFd) { try { fs.closeSync(logFd); } catch (_) { /* ignore */ } }
  logFd = fs.openSync(LOG_FILE, 'a');

  stamp(`launching backend (detached, logs -> ${path.basename(LOG_FILE)}).`);
  child = spawn(process.execPath, [SERVER], {
    detached: true,
    windowsHide: true,
    env: { ...process.env },
    stdio: ['ignore', logFd, logFd]
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      stamp('Backend stopped. Exiting.');
      process.exit(0);
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= BACKOFF_AFTER) {
      stamp(`server.js exited (code=${code}, signal=${signal}); ${consecutiveFailures} crashes in a row - backing off to ${BACKOFF_DELAY_MS / 1000}s before retrying...`);
      setTimeout(() => { consecutiveFailures = 0; startServer(); }, BACKOFF_DELAY_MS);
      return;
    }
    stamp(`server.js exited (code=${code}, signal=${signal}); restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startServer, RESTART_DELAY_MS);
  });

  child.on('error', (error) => {
    child = null;
    consecutiveFailures += 1;
    stamp(`Failed to launch server.js: ${error.message}. Retrying in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startServer, RESTART_DELAY_MS);
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  stamp('Shutting down...');
  if (child && child.pid) {
    stopProcessTree(child.pid);
    // Give the detach tree a moment, then leave for good.
    setTimeout(() => process.exit(0), STOP_GRACE_MS);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  await cleanStaleProcesses();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  stamp('Watchdog started; launching backend.');
  startServer();
})();