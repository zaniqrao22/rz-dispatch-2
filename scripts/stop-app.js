'use strict';

/**
 * Cleanly stop the RZ Dispatch backend and its embedded PostgreSQL.
 *
 * The backend runs detached (see scripts/watchdog.js), so closing the terminal
 * that launched it no longer stops it. This script stops:
 *   1. the previous watchdog (recorded in .watchdog.pid),
 *   2. whatever is listening on :8000 (the backend server + its tree),
 *   3. any leftover node watchdog/server for this project (path sweep),
 *   4. the embedded PostgreSQL (scoped to .pgdata only).
 *
 * Usage: npm run stop  (or)  node scripts/stop-app.js
 */

const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const PGDATA = path.join(ROOT, '.pgdata');
const PID_FILE = path.join(ROOT, '.watchdog.pid');

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

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    killer.on('close', resolve);
  });
}

async function stop() {
  const stopped = [];

  // 1. Previous watchdog, by recorded pid.
  let watchdogPid = null;
  try {
    const raw = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isInteger(raw) && raw > 0) watchdogPid = raw;
  } catch (_) { /* no pid file yet */ }
  if (watchdogPid) {
    try { process.kill(watchdogPid, 0); stopped.push(watchdogPid); await killTree(watchdogPid); } catch (_) { /* already gone */ }
  }

  // 2. Whatever holds :8000.
  const listener = listeningPid(8000);
  if (listener) { stopped.push(listener); await killTree(listener); }

  // 3. Mop-up sweep for any leftover node watchdog/server of this project
  //    (covers relative-path launches like `node scripts/watchdog.js`).
  if (process.platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and (" +
      "($_.CommandLine -like '*FIRST PROJECT*watchdog.js*' -or $_.CommandLine -like '*scripts*watchdog.js*') -or " +
      "($_.CommandLine -like '*FIRST PROJECT*server.js*')) " +
      "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }";
    const sweep = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true
    });
    if (sweep.stdout) {
      for (const line of sweep.stdout.split(/\r?\n/)) {
        if (/^\d+$/.test(line.trim())) stopped.push(Number(line.trim()));
      }
    }
  }

  // 4. Embedded PostgreSQL (this project's data directory only).
  const pgScript =
    "Get-CimInstance Win32_Process | Where-Object { " +
    `$_.Name -eq 'postgres.exe' -and $_.CommandLine -like '*${PGDATA}*' ` +
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }";
  const pgSweep = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', pgScript], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true
  });
  if (pgSweep.stdout) {
    for (const line of pgSweep.stdout.split(/\r?\n/)) {
      if (/^\d+$/.test(line.trim())) stopped.push(Number(line.trim()));
    }
  }

  const unique = [...new Set(stopped)];
  console.log(unique.length ? `[stop] Stopped ${unique.length} process(es): ${unique.join(', ')}` : '[stop] Nothing was running.');

  await new Promise((resolve) => setTimeout(resolve, 2500));
  console.log((await isPortOpen(8000)) ? '[stop] Port 8000 is still responding; retry in a moment.' : '[stop] Backend is down. Done.');
}

stop().catch((error) => {
  console.error('[stop] Failed:', error);
  process.exit(1);
});