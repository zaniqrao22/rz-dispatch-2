/* global WebSocket, window, document */
/**
 * RZ Dispatch realtime client.
 *
 * One tiny WebSocket channel shared by all three portals (dispatch, operator,
 * customer). It reconnects automatically with exponential backoff, survives
 * network drops and server restarts, and never throws — if a socket cannot be
 * opened the app keeps working exactly as it did before (REST + polling).
 *
 * API (window.RZRealtime):
 *   configure({ apiBase })
 *   identify({ role, driverId, email, name, token }) | identify(null)
 *   connect() / disconnect()
 *   on(event, handler) / off(event, handler)      returns off()
 *   subscribe(audience) / unsubscribe(audience)
 *   send(action, payload)
 *   status / getPresence()
 *
 * Events delivered by the server include:
 *   hello, presence, message.new, message.read, message.deleted,
 *   job.status, job.assigned, activity, subscribed, error, pong
 */
(function () {
  'use strict';

  const state = {
    socket: null,
    apiBase: (window.RZ_API_BASE || '').replace(/\/+$/, ''),
    identity: null,
    handlers: Object.create(null),
    status: 'closed',
    retries: 0,
    backoff: 800,
    reconnectTimer: null,
    manualClose: false,
    extraAudiences: [],
    online: []
  };

  function listeners(event) {
    if (!state.handlers[event]) state.handlers[event] = new Set();
    return state.handlers[event];
  }

  function on(event, handler) {
    if (typeof handler !== 'function') return function () {};
    listeners(event).add(handler);
    return function () { off(event, handler); };
  }

  function off(event, handler) {
    const set = state.handlers[event];
    if (!set) return;
    if (handler) set.delete(handler);
    else state.handlers[event] = new Set();
  }

  function emit(event, payload) {
    const set = state.handlers[event];
    if (set) for (const handler of [...set]) { try { handler(payload); } catch (_) {/* handler must not kill the bus */} }
  }

  function configure(options) {
    if (!options) return;
    if (typeof options.apiBase === 'string') state.apiBase = options.apiBase.replace(/\/+$/, '');
  }

  function shouldConnect() {
    const id = state.identity;
    return Boolean(id && (id.token || id.email));
  }

  function buildUrl() {
    let base = state.apiBase || '';
    let host = '';
    if (base && /^https?:\/\//.test(base)) {
      host = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    } else {
      base = base.replace(/\/+$/, '');
      host = (window.location.protocol === 'https:' ? 'wss' : 'ws') + '://' + window.location.host + base;
    }
    const id = state.identity || {};
    const params = new URLSearchParams();
    if (id.token) params.set('token', id.token);
    if (!id.token && id.email) {
      params.set('email', id.email);
      if (id.name) params.set('name', id.name);
    }
    if (id.role === 'operator' && id.driverId) params.set('driverId', id.driverId);
    const qs = params.toString();
    return host + '/realtime' + (qs ? '?' + qs : '');
  }

  function scheduleReconnect() {
    if (state.manualClose || !shouldConnect()) return;
    if (state.reconnectTimer) return;
    const delay = Math.min(30000, state.backoff) + Math.floor(Math.random() * 400);
    state.backoff = Math.min(30000, state.backoff * 1.7);
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!window.WebSocket || !shouldConnect()) return;
    if (state.socket && (state.socket.readyState === 0 || state.socket.readyState === 1)) return;
    state.manualClose = false;
    if (state.reconnectTimer) { window.clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(buildUrl());
    } catch (_) {
      scheduleReconnect();
      return;
    }
    state.socket = ws;

    ws.onopen = function () {
      state.retries = 0;
      state.backoff = 800;
      setStatus('open');
      for (const audience of state.extraAudiences) send('subscribe', { audiences: [audience] });
    };

    ws.onmessage = function (event) {
      let frame;
      try { frame = JSON.parse(String(event.data || '')); } catch (_) { return; }
      if (!frame || typeof frame.event !== 'string') return;
      if (frame.event === 'hello') state.online = (frame.payload && frame.payload.online) || [];
      if (frame.event === 'presence') state.online = (frame.payload && frame.payload.online) || [];
      if (frame.event === 'pong') return;
      emit(frame.event, frame.payload);
      emit('*', { event: frame.event, payload: frame.payload });
    };

    ws.onerror = function () {
      try { ws.close(); } catch (_) { /* ignore */ }
    };

    ws.onclose = function () {
      if (state.socket === ws) state.socket = null;
      setStatus('closed');
      if (!state.manualClose && shouldConnect()) scheduleReconnect();
    };
  }

  function disconnect() {
    state.manualClose = true;
    if (state.reconnectTimer) { window.clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    state.extraAudiences = [];
    const ws = state.socket;
    state.socket = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch (_) { /* ignore */ } }
    setStatus('closed');
  }

  function identify(identity) {
    state.identity = identity || null;
    state.extraAudiences = [];
    if (!state.identity) { disconnect(); return; }
    connect();
  }

  function send(action, payload) {
    const ws = state.socket;
    if (!ws || ws.readyState !== 1) return false;
    const frame = Object.assign({ action }, payload || {});
    try { ws.send(JSON.stringify(frame)); return true; } catch (_) { return false; }
  }

  function subscribe(audience) {
    if (!audience) return false;
    if (send('subscribe', { audiences: [audience] })) return true;
    if (!state.extraAudiences.includes(audience)) state.extraAudiences.push(audience);
    return false;
  }

  function unsubscribe(audience) {
    state.extraAudiences = state.extraAudiences.filter((a) => JSON.stringify(a) !== JSON.stringify(audience));
    return send('unsubscribe', { audiences: [audience] });
  }

  function setStatus(value) {
    if (state.status === value) return;
    state.status = value;
    emit('status', value);
  }

  function getPresence() {
    return state.online;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.status === 'closed' && shouldConnect()) connect();
  });

  window.RZRealtime = {
    on,
    off,
    emit,
    configure,
    identify,
    connect,
    disconnect,
    send,
    subscribe,
    unsubscribe,
    getPresence,
    get status() { return state.status; }
  };
})();