'use strict';

/**
 * RZ Dispatch realtime communication hub.
 *
 * A small JSON-over-WebSocket bus that connects the three portals on a single
 * always-on channel: the dispatch dashboard (staff), the operator portal
 * (drivers), and the customer portal. Events are announced right after they
 * are persisted by the REST API, so the REST endpoints remain the source of
 * truth and every page can fall back to plain polling when a socket is not
 * available.
 *
 * Rooms:
 *   staff            -> every authenticated dispatcher/owner
 *   driver:<id>      -> one operator socket subscribed to driver <id>
 *   customer:<email> -> one customer socket subscribed to <email>
 *
 * A socket lives in its default room and can subscribe to extra rooms (with
 * strict per-role permission checks) so, for example, a dispatcher can watch
 * a customer's conversation while their thread is open.
 */

const { WebSocketServer } = require('ws');

const REALTIME_PATH = '/realtime';
const HEARTBEAT_MS = 30000;
const STALE_MS = 75000;

let wss = null;
let httpServer = null;
let jwtSecret = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
let enabled = process.env.REALTIME_DISABLED !== 'true';
let heartbeatTimer = null;

const clients = new Map();   // ws -> { principal, since }
const rooms = new Map();     // room -> Set<ws>

function roomName(principal) {
  if (principal.kind === 'staff') return 'staff';
  if (principal.kind === 'driver') return `driver:${principal.driverId}`;
  return `customer:${String(principal.email || '').toLowerCase()}`;
}

function audienceToRooms(audience) {
  if (audience === '*') return [...rooms.keys()];
  if (audience === 'staff') return ['staff'];
  if (audience && typeof audience === 'object') {
    if (audience.type === 'driver' && audience.id) return [`driver:${audience.id}`];
    if (audience.type === 'customer' && audience.email) return [`customer:${String(audience.email).toLowerCase()}`];
    return [];
  }
  return [];
}

function isAllowedExtraRoom(principal, room) {
  if (principal.kind === 'staff' || principal.kind === 'driver') {
    if (room === 'staff') return principal.kind === 'staff';
    if (room.startsWith('driver:')) return room === roomName(principal);
    if (room.startsWith('customer:')) return principal.kind === 'staff';
    return false;
  }
  if (principal.kind === 'customer') {
    return room === roomName(principal);
  }
  return false;
}

function subscribeSocket(ws, room) {
  if (!room || !rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room);
  set.add(ws);
}

function unsubscribeSocket(ws) {
  const record = clients.get(ws);
  if (record) {
    clients.delete(ws);
    for (const [room, set] of rooms) {
      if (set.delete(ws) && set.size === 0) rooms.delete(room);
    }
  }
  if (heartbeatTimer && clients.size === 0) clearInterval(heartbeatTimer);
}

function sendTo(ws, event, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify({ event, payload, ts: Date.now() }));
    } catch (_) { /* socket already gone */ }
  }
}

function presenceSnapshot() {
  const now = Date.now();
  return [...clients.entries()]
    .filter(([, record]) => now - record.since < STALE_MS)
    .map(([, record]) => {
      const p = record.principal;
      return { kind: p.kind, name: p.label, driverId: p.driverId || null, email: p.email || null, since: new Date(record.since).toISOString() };
    });
}

function announcePresence() {
  broadcast('presence', { online: presenceSnapshot() }, ['staff']);
}

/**
 * Deliver `event` + `payload` to every room represented by `audiences`.
 * audiences: array of 'staff' strings or {type,id}/{type,email} objects.
 */
function broadcast(event, payload, audiences = ['staff']) {
  if (!enabled || !wss) return;
  const targets = new Set();
  for (const audience of audiences) {
    for (const name of audienceToRooms(audience)) {
      const set = rooms.get(name);
      if (!set) continue;
      for (const ws of set) targets.add(ws);
    }
  }
  for (const ws of targets) sendTo(ws, event, payload);
}

function handleMessage(ws, principal, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch (_) {
    return sendTo(ws, 'error', { error: 'Invalid JSON payload' });
  }
  const action = String(frame.action || '').toLowerCase();
  if (action === 'ping') return sendTo(ws, 'pong', {});

  if (action === 'subscribe') {
    const wanted = Array.isArray(frame.audiences) ? frame.audiences : [frame.audience];
    const accepted = [];
    for (const audience of wanted) {
      const roomsList = audienceToRooms(audience);
      for (const room of roomsList) {
        if (isAllowedExtraRoom(principal, room)) {
          subscribeSocket(ws, room);
          accepted.push(room);
        }
      }
    }
    return sendTo(ws, 'subscribed', { rooms: accepted });
  }

  if (action === 'unsubscribe') {
    const wanted = Array.isArray(frame.audiences) ? frame.audiences : [frame.audience];
    const names = wanted.flatMap(audienceToRooms);
    for (const room of names) {
      const set = rooms.get(room);
      if (set) set.delete(ws);
    }
    return sendTo(ws, 'subscribed', { rooms: names });
  }

  return sendTo(ws, 'error', { error: `Unknown action "${action}"` });
}

function registerSocket(ws, principal) {
  const record = { principal, since: Date.now() };
  clients.set(ws, record);
  const room = roomName(principal);
  subscribeSocket(ws, room);

  ws.on('message', (data) => handleMessage(ws, principal, String(data)));
  ws.on('pong', () => { record.since = Date.now(); });
  ws.on('error', () => {
    try { ws.terminate(); } catch (_) { /* ignore */ }
  });
  ws.on('close', () => {
    unsubscribeSocket(ws);
    announcePresence();
  });

  sendTo(ws, 'hello', {
    you: { kind: principal.kind, name: principal.label, driverId: principal.driverId || null, email: principal.email || null },
    online: presenceSnapshot()
  });
  announcePresence();
}

function startHeartbeat() {
  if (!enabled || heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [ws, record] of [...clients.entries()]) {
      if (now - record.since > STALE_MS) {
        try { ws.terminate(); } catch (_) { /* ignore */ }
        continue;
      }
      try { ws.ping(); } catch (_) { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  if (heartbeatTimer && heartbeatTimer.unref) heartbeatTimer.unref();
}

function principalFromRequest(req) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch (_) {
    return null;
  }
  if (url.pathname !== REALTIME_PATH) return null;
  const params = url.searchParams;
  const token = params.get('token') || '';
  let decoded = null;
  if (token) {
    try {
      decoded = require('jsonwebtoken').verify(token, jwtSecret);
    } catch (_) {
      decoded = null;
    }
  }

  if (decoded) {
    const role = String(decoded.role || '');
    const driverId = decoded.driverId || params.get('driverId') || null;
    const email = String(decoded.email || '').toLowerCase() || null;
    if (role === 'admin' || role === 'owner') {
      return { kind: 'staff', id: decoded.id, label: email || 'Dispatcher', email };
    }
    if (role === 'operator') {
      return { kind: 'driver', id: decoded.id, label: String(email || 'Operator').split('@')[0], driverId, email };
    }
    if (role === 'customer') {
      return { kind: 'customer', id: decoded.id, label: email || 'Customer', email };
    }
    return null;
  }

  const email = String(params.get('email') || '').trim().toLowerCase();
  const name = String(params.get('name') || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { kind: 'customer', id: email, label: name || email, email };
  }
  return null;
}

/**
 * Attach the realtime WebSocket server to an existing Node http.Server.
 * Safe to call more than once (only the first server wins).
 */
function attachRealtime(server, options = {}) {
  if (!enabled) {
    console.warn('[realtime] Realtime communication disabled (set REALTIME_DISABLED=true to silence this).');
    return null;
  }
  if (wss) {
    console.warn('[realtime] Hub is already attached to an HTTP server; ignoring duplicate attach.');
    return wss;
  }
  if (!server) return null;
  if (options.jwtSecret) jwtSecret = options.jwtSecret;
  httpServer = server;
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const principal = principalFromRequest(req);
    if (!principal) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, principal);
    });
  });

  wss.on('connection', (ws, req, principal) => {
    registerSocket(ws, principal);
  });

  startHeartbeat();
  console.log('[realtime] Communication hub ready at ws://host' + REALTIME_PATH);
  return wss;
}

function clientsOnline() {
  return clients.size;
}

module.exports = {
  attachRealtime,
  broadcast,
  presenceSnapshot,
  clientsOnline,
  isRealtimeEnabled: () => enabled
};