const main = document.querySelector('.main-content');
const appShell = document.querySelector('.app-shell');
const sidebar = document.querySelector('.sidebar');
const toast = document.getElementById('toast');
const dispatchMarkup = main ? main.innerHTML : '';
const licenseModal = document.getElementById('licenseModal');
const licenseForm = document.getElementById('licenseForm');
const licenseError = document.getElementById('licenseFormError');
let licenseDemoKeyConfigured = false;
let paymentsConfigured = false;
let editingVehicleId = null;
const quoteModal = document.getElementById('quoteModal');
const quoteForm = document.getElementById('quoteForm');
const quoteError = document.getElementById('quoteFormError');
const quoteEstimateSummary = document.getElementById('quoteEstimateSummary');
const AUTH_TOKEN_KEY = 'rz_dispatch_token';
const MODE_KEY = 'rz_app_mode';
const CUSTOMER_PROFILE_KEY = 'rz_customer_profile';
const WORKSPACE_KEY = 'rz_workspace';
const LICENSE_KEY_STORE = 'rz_license_key';
const API_BASE_OVERRIDE = (window.RZ_API_BASE || '').replace(/\/+$/, '');
let apiBase = '';
const availableWorkspaces = [
  { id: 'west-coast', name: 'West Coast Fleet' },
  { id: 'east-coast', name: 'East Coast Fleet' },
  { id: 'central', name: 'Central Operations' }
];
let state = { jobs: [], drivers: [], vehicles: [], activity: [], metrics: {}, analytics: {}, bookings: [], quotes: [] };
let currentUser = null;
let currentMode = localStorage.getItem(MODE_KEY) || 'dispatcher';
let workspaceMenuOpen = false;

function getCurrentWorkspace() {
  return localStorage.getItem(WORKSPACE_KEY) || 'West Coast Fleet';
}

function updateWorkspaceLabel(name) {
  const label = document.querySelector('.workspace-switcher > span:nth-child(2)');
  if (label) label.textContent = name;
}

function setCurrentWorkspace(name) {
  localStorage.setItem(WORKSPACE_KEY, name);
  updateWorkspaceLabel(name);
}

async function refreshWorkspaceFromAccount() {
  try {
    const response = await fetchJson('/api/account/summary');
    if (!response.ok) return;
    const summary = await response.json();
    if (summary.workspace) {
      updateWorkspaceLabel(getCurrentWorkspace());
      if (!localStorage.getItem(WORKSPACE_KEY)) {
        localStorage.setItem(WORKSPACE_KEY, summary.workspace);
        updateWorkspaceLabel(summary.workspace);
      }
    }
  } catch (error) {
    // Keep the default label when the account summary is unavailable.
  }
}

function toggleWorkspaceMenu() {
  const existing = document.getElementById('workspaceMenu');
  if (existing) { existing.remove(); workspaceMenuOpen = false; return; }
  const switcher = document.querySelector('.workspace-switcher');
  if (!switcher) return;
  const rect = switcher.getBoundingClientRect();
  const current = getCurrentWorkspace();
  const menu = document.createElement('div');
  menu.id = 'workspaceMenu';
  menu.className = 'workspace-menu';
  menu.innerHTML = `<div class="workspace-menu-heading"><strong>Switch workspace</strong></div>${availableWorkspaces.map((ws) => `<button class="workspace-menu-item ${ws.name === current ? 'is-active' : ''}" data-workspace="${escapeHTML(ws.name)}" type="button"><span class="status-dot"></span><div class="workspace-menu-copy"><strong>${escapeHTML(ws.name)}</strong><small>${ws.name === current ? 'Current workspace' : 'Switch workspace'}</small></div><span class="workspace-check">${ws.name === current ? '✓' : ''}</span></button>`).join('')}`;
  menu.style.top = `${rect.bottom + 8}px`;
  menu.style.left = `${rect.left}px`;
  document.body.appendChild(menu);
  menu.style.minWidth = `${Math.max(rect.width, 220)}px`;
  document.querySelectorAll('.workspace-menu-item').forEach((item) => item.addEventListener('click', () => {
    const name = item.dataset.workspace;
    setCurrentWorkspace(name);
    menu.remove();
    workspaceMenuOpen = false;
    showToast(`Showing ${name}`);
  }));
  workspaceMenuOpen = true;
}

function closeWorkspaceMenu() {
  const menu = document.getElementById('workspaceMenu');
  if (menu) { menu.remove(); workspaceMenuOpen = false; }
}

let leafletMap = null;
let mapMarkers = null;
let mapRouteLines = null;

function renderMetrics() {
  const values = [state.metrics.active, state.metrics.onRoad, String(state.metrics.available).padStart(2, '0'), `${state.metrics.eta} min`];
  document.querySelectorAll('#dispatch .metric-card>strong').forEach((element, index) => {
    if (index === 3) element.innerHTML = `${escapeHTML(state.metrics.eta)} <em>min</em>`;
    else element.textContent = values[index];
  });
}

function initLeafletMap() {
  if (leafletMap || !L) return;
  const container = document.getElementById('mapCanvas');
  if (!container || container._leaflet_id) return;
  leafletMap = L.map(container, {
    center: [37.78, -122.415],
    zoom: 13,
    zoomControl: false,
    attributionControl: false
  });
  L.control.zoom({ position: 'bottomright' }).addTo(leafletMap);
  L.control.attribution({ prefix: '' }).addTo(leafletMap);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    subdomains: 'abc'
  }).addTo(leafletMap);
  mapMarkers = L.layerGroup().addTo(leafletMap);
  mapRouteLines = L.layerGroup().addTo(leafletMap);
  setTimeout(() => { leafletMap.invalidateSize(); }, 120);
}

function destroyLeafletMap() {
  if (leafletMap) { leafletMap.remove(); leafletMap = null; mapMarkers = null; mapRouteLines = null; }
}

function bindDispatch() {
  renderLiveDateAndGreeting();
  renderMetrics();
  initLeafletMap();
  setTimeout(() => {
    renderMapPins();
    if (leafletMap && state.jobs.length) {
      const bounds = L.latLngBounds(state.jobs.filter((j) => j.lat != null && j.lng != null).map((j) => [j.lat, j.lng]));
      if (bounds.isValid()) leafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, 200);
  renderQueue();
  selectJob(state.jobs[0]?.id);
  refreshWorkspaceFromAccount();
  document.getElementById('optimizeRoute')?.addEventListener('click', optimizeRoute);
  document.getElementById('newJob')?.addEventListener('click', openJobModal);
  document.getElementById('dashboardSearch')?.addEventListener('click', toggleSearchPanel);
  document.getElementById('dashboardNotifications')?.addEventListener('click', toggleNotificationsPanel);
  document.getElementById('requestQuoteButton')?.addEventListener('click', openQuoteModal);
  document.querySelector('.queue-heading .text-button')?.addEventListener('click', () => { window.location.hash = 'schedule'; });
  document.querySelector('.activity-panel .text-button')?.addEventListener('click', () => { window.location.hash = 'analytics'; });
  refreshNotificationBadge();
  document.getElementById('performanceRefresh')?.addEventListener('click', async () => {
    await requestOverview();
    renderMetrics();
    renderQueue();
    renderMapPins();
    showToast('Dashboard data refreshed');
  });
  document.querySelectorAll('.map-tools .small-icon').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (!leafletMap) return;
      if (i === 0) { leafletMap.setView([37.78, -122.415], 13); showToast('Map recentered'); }
      if (i === 1) leafletMap.setZoom(leafletMap.getZoom() + 1);
      if (i === 2) leafletMap.setZoom(leafletMap.getZoom() - 1);
    });
  });
}

function setAppMode(mode) {
  currentMode = mode;
  localStorage.setItem(MODE_KEY, mode);
  if (appShell) { appShell.classList.toggle('customer-mode', mode === 'customer'); appShell.classList.toggle('operator-mode', mode === 'operator'); }
  if (sidebar) sidebar.style.display = mode === 'customer' || mode === 'operator' ? 'none' : '';
  if (main) { main.classList.toggle('customer-main', mode === 'customer'); main.classList.toggle('operator-main', mode === 'operator'); }
}

function updateDispatcherSidebar() {
  if (!sidebar) return;
  sidebar.style.display = currentMode === 'customer' || currentMode === 'operator' ? 'none' : '';
  if (appShell) { appShell.classList.toggle('customer-mode', currentMode === 'customer'); appShell.classList.toggle('operator-mode', currentMode === 'operator'); }
  if (main) { main.classList.toggle('customer-main', currentMode === 'customer'); main.classList.toggle('operator-main', currentMode === 'operator'); }
}

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || sessionStorage.getItem(AUTH_TOKEN_KEY) || '';
}

function getDisplayName() {
  if (currentUser && currentUser.name) return currentUser.name;
  if (currentUser && currentUser.email) return currentUser.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return 'Dispatcher';
}

function getUserInitials() {
  const name = getDisplayName();
  return name.split(/\s+/).map((part) => part[0]).join('').toUpperCase().slice(0, 2) || 'OP';
}

function updateSidebarUser() {
  const nameEl = document.querySelector('.user-row strong');
  const avatarEl = document.querySelector('.user-row .avatar');
  if (nameEl) nameEl.textContent = getDisplayName();
  if (avatarEl) avatarEl.textContent = getUserInitials();
}

function setAuthToken(token, remember = true) {
  const storage = remember ? localStorage : sessionStorage;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  if (token) storage.setItem(AUTH_TOKEN_KEY, token);
}

function getStoredLicenseKey() {
  return localStorage.getItem(LICENSE_KEY_STORE) || '';
}

function saveStoredLicenseKey(key) {
  if (!key) { localStorage.removeItem(LICENSE_KEY_STORE); return; }
  localStorage.setItem(LICENSE_KEY_STORE, key);
}

function getCustomerProfile() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOMER_PROFILE_KEY) || '{}');
  } catch (error) {
    return {};
  }
}

function saveCustomerProfile(profile) {
  localStorage.setItem(CUSTOMER_PROFILE_KEY, JSON.stringify(profile));
}

function apiUrl(url) {
  if (!apiBase) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url;
  return apiBase + url;
}

async function detectApiBase() {
  if (API_BASE_OVERRIDE) { apiBase = API_BASE_OVERRIDE; return; }
  // When served by a static file server (VS Code Live Server etc.) the same
  // origin has no /api backend, so probe the real backend first instead of
  // firing a noisy 404 request on the static server.
  const port = window.location.port;
  const staticServerPorts = ['5500', '5501', '3000', '3001', '5173', '8001', '8080', '8081'];
  let candidates;
  if (staticServerPorts.includes(port)) {
    candidates = ['http://127.0.0.1:8000', 'http://localhost:8000', ''];
  } else {
    candidates = ['', 'http://127.0.0.1:8000', 'http://localhost:8000'];
  }
  for (const base of candidates) {
    try {
      const probe = await fetch(base + '/api/health', { headers: { 'Accept': 'application/json' } });
      const text = await probe.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
      if (probe.ok && body && body.ok) { apiBase = base; return; }
    } catch (_) { /* try next candidate */ }
  }
  apiBase = '';
}

async function fetchJson(url, options = {}) {
  const token = getAuthToken();
  const headers = { ...(options.headers || {}) };
  if (!headers['Content-Type'] && !headers['content-type'] && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const storedLicense = getStoredLicenseKey();
  if (storedLicense) headers['X-License-Key'] = storedLicense;

  const response = await fetch(apiUrl(url), { ...options, headers });
  if (response.status === 401) {
    if (window.RZRealtime) window.RZRealtime.disconnect();
    setAuthToken('');
    renderAuthScreen();
    throw new Error('Your session expired. Please log in again.');
  }
  if (response.status === 402) {
    openLicenseModal();
  }
  return response;
}

async function checkLicenseStatus() {
  try {
    const response = await fetchJson('/api/license/status');
    const result = await response.json();
    licenseDemoKeyConfigured = Boolean(result.demoKeyConfigured);
    paymentsConfigured = Boolean(result.paymentsConfigured);
    if (!result.locked || result.active) return true;
    openLicenseModal();
    return false;
  } catch (error) {
    return false;
  }
}

function openLicenseModal() {
  if (!licenseModal) return;
  licenseModal.hidden = false;
  const emailField = document.querySelector('#licenseEmail')?.closest('label');
  if (emailField) {
    emailField.hidden = !licenseDemoKeyConfigured;
    emailField.style.display = licenseDemoKeyConfigured ? '' : 'none';
  }
  const input = document.getElementById('licenseKey');
  const buyButton = document.getElementById('purchaseLicenseModal');
  const divider = document.getElementById('purchaseDivider');
  if (buyButton) buyButton.hidden = !paymentsConfigured;
  if (divider) divider.hidden = !paymentsConfigured;
  if (!licenseDemoKeyConfigured) {
    const hint = document.querySelector('.modal-subtitle');
    if (hint) hint.textContent = paymentsConfigured ? 'Enter a license key, or purchase a lifetime license below.' : 'Enter your license key to unlock the dashboard.';
  }
  if (input) input.focus();
}

function closeLicenseModal() {
  if (!licenseModal) return;
  licenseModal.hidden = true;
  if (licenseForm) licenseForm.reset();
  if (licenseError) licenseError.textContent = '';
}

async function activateLicense(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const key = String(form.get('licenseKey') || '').trim();
  const email = String(form.get('email') || '').trim();

  if (!key && !email) {
    licenseError.textContent = 'Add a valid license key to activate.';
    return;
  }
  if (!key && !licenseDemoKeyConfigured) {
    licenseError.textContent = 'No demo license is configured. Enter your license key to activate.';
    return;
  }

  try {
    const response = await fetchJson('/api/license/activate', {
      method: 'POST',
      body: JSON.stringify(key ? { licenseKey: key } : { email })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'License activation failed');
    if (result.licenseKey) saveStoredLicenseKey(result.licenseKey);
    closeLicenseModal();
    showToast('License activated');
    await requestOverview();
    renderView(window.location.hash.slice(1) || 'dispatch');
  } catch (error) {
    if (licenseError) licenseError.textContent = error.message;
  }
}

async function beginLifetimePurchase() {
  try {
    const response = await fetchJson('/api/purchase/lifetime', { method: 'POST', body: JSON.stringify({}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start checkout');
    sessionStorage.setItem('rz_pending_purchase', result.sessionId);
    window.location.assign(result.checkoutUrl);
  } catch (error) {
    showToast(error.message || 'Payments are not configured');
  }
}

async function completeLifetimePurchase(sessionId) {
  try {
    const response = await fetchJson(`/api/purchase/license?session_id=${encodeURIComponent(sessionId)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'We could not confirm your payment yet.');
    saveStoredLicenseKey(result.licenseKey);
    sessionStorage.removeItem('rz_pending_purchase');
    showToast('Payment confirmed. Lifetime license activated.');
  } catch (error) {
    showToast(error.message);
  }
}

function renderAuthScreen() {
  if (!main) return;
  setAppMode('dispatcher');
  main.innerHTML = `
    <div class="auth-wrap">
      <div class="view-header auth-header">
        <div>
          <p class="eyebrow">SECURE ACCESS</p>
          <h1>RZ Dispatch</h1>
          <p class="view-subtitle">Choose your workspace and sign in.</p>
        </div>
      </div>
      <section class="panel data-panel empty-panel auth-card">
        <div class="access-mode-switch">
          <button type="button" class="dispatch-button mode-switch active" data-mode="dispatcher">Dispatcher dashboard</button>
          <button type="button" class="outline-button mode-switch" data-mode="customer">Customer portal</button>
          <button type="button" class="outline-button mode-switch" data-mode="operator">Operator portal</button>
        </div>
        <form id="authForm" class="auth-form">
          <label class="auth-field">Email
            <input id="authEmail" name="email" type="email" placeholder="you@company.com" autocomplete="email" required class="auth-input" />
          </label>
          <label class="auth-field">Password
            <span class="password-field">
              <input id="authPassword" name="password" type="password" placeholder="••••••••" autocomplete="current-password" required class="auth-input" />
              <button type="button" id="passwordToggle" class="password-toggle" aria-label="Show password" aria-pressed="false">
                <svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
                <svg class="icon-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              </button>
            </span>
          </label>
          <div class="auth-options">
            <label class="remember-me"><input id="rememberMe" type="checkbox" checked /> Remember me</label>
            <button type="button" id="forgotPasswordToggle" class="text-button" style="background:none;border:none;color:#1e3a8a;text-decoration:underline;cursor:pointer;padding:0;">Forgot password?</button>
          </div>
          <label class="auth-field" id="registerRoleWrap" style="display:none;">Account type
            <select id="registerRole" class="auth-input" name="role">
              <option value="customer">Customer — instant access</option>
              <option value="dispatcher">Dispatcher — needs approval</option>
              <option value="driver">Driver — needs approval</option>
            </select>
          </label>
          <div class="auth-actions">
            <button type="submit" class="dispatch-button auth-submit">Sign in</button>
            <button type="button" class="outline-button auth-register" id="registerToggle">Create account</button>
          </div>
          <p id="authError" class="form-error" role="alert"></p>
        </form>
      </section>
    </div>
  `;

  document.querySelectorAll('.mode-switch').forEach((button) => {
    button.addEventListener('click', () => selectAuthMode(button.dataset.mode));
  });

  document.getElementById('registerToggle')?.addEventListener('click', () => {
    const submitButton = document.querySelector('#authForm button[type="submit"]');
    const roleWrap = document.getElementById('registerRoleWrap');
    if (!submitButton) return;
    const registering = submitButton.dataset.mode !== 'register';
    submitButton.textContent = registering ? 'Create account' : 'Sign in';
    if (registering) submitButton.dataset.mode = 'register';
    else delete submitButton.dataset.mode;
    if (roleWrap) roleWrap.style.display = registering ? '' : 'none';
  });

  document.getElementById('passwordToggle')?.addEventListener('click', () => {
    const passwordInput = document.getElementById('authPassword');
    const toggle = document.getElementById('passwordToggle');
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    toggle.classList.toggle('is-visible', show);
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  const rememberCheckbox = document.getElementById('rememberMe');
  if (rememberCheckbox) rememberCheckbox.checked = sessionStorage.getItem('rz_dispatch_remember') !== '0';

  document.getElementById('forgotPasswordToggle')?.addEventListener('click', () => {
    renderForgotPassword();
  });

  document.getElementById('authForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    const mode = submitButton?.dataset.mode === 'register' ? 'register' : 'login';
    const resultText = document.getElementById('authError');

    try {
      if (!apiBase) await detectApiBase();
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const role = mode === 'register' ? (document.getElementById('registerRole')?.value || 'customer') : undefined;
      const requestBody = role ? { email, password, role } : { email, password };
      const response = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('The server is unavailable. Make sure the backend is running on port 8000.');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Authentication failed');
      if (mode === 'register' && !payload.token) {
        // Dispatcher and driver registrations start 'pending' and wait for admin
        // approval before they can sign in. Customer registrations sign in instantly.
        resultText.textContent = '';
        showToast(payload.message || 'Your account is awaiting dispatcher approval.');
        if (submitButton) {
          submitButton.textContent = 'Sign in';
          delete submitButton.dataset.mode;
          const roleWrap = document.getElementById('registerRoleWrap');
          if (roleWrap) roleWrap.style.display = 'none';
        }
        event.currentTarget.reset();
        return;
      }
      const remember = document.getElementById('rememberMe')?.checked ?? true;
      if (remember) sessionStorage.removeItem('rz_dispatch_remember');
      else sessionStorage.setItem('rz_dispatch_remember', '0');
      setAuthToken(payload.token, remember);
      currentUser = payload.user || null;
      updateSidebarUser();
      resultText.textContent = '';
      routeByRole();
    } catch (error) {
      resultText.textContent = error.message;
    }
  });
}

// Route a signed-in user to the portal their account role grants access to:
// dispatchers (admin/owner) -> dispatch portal, drivers (linked operators) ->
// operator portal, customers -> customer portal. The portal a user clicked to
// sign in through no longer overrides the account's role.
function routeByRole() {
  const role = currentUser?.role;
  if (role === 'operator' && currentUser.driverId) {
    setAppMode('operator');
    renderOperatorPortal();
    return;
  }
  if (role === 'customer') {
    setAppMode('customer');
    rtSetupSession();
    renderCustomerHome();
    return;
  }
  rtSetupSession();
  setAppMode('dispatcher');
  requestOverview().then(() => renderView(window.location.hash.slice(1) || 'dispatch'));
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

function renderForgotPassword() {
  if (!main) return;
  setAppMode('dispatcher');
  main.innerHTML = `
    <div class="view-header">
      <div>
        <p class="eyebrow">SECURE ACCESS</p>
        <h1>Reset your password</h1>
        <p class="view-subtitle">Enter your account email and we'll send you a reset link.</p>
      </div>
    </div>
    <section class="panel data-panel empty-panel" style="padding:32px 24px;max-width:560px;">
      <form id="forgotForm" style="display:grid;gap:16px;">
        <label style="display:grid;gap:8px;font-weight:700;">Email
          <input id="forgotEmail" name="email" type="email" placeholder="you@company.com" required style="padding:12px;border:1px solid #dce5e1;border-radius:8px;" />
        </label>
        <div style="display:flex;gap:12px;">
          <button type="submit" class="dispatch-button" style="flex:1;">Send reset link</button>
          <button type="button" class="outline-button" id="backToLogin">&larr; Back</button>
        </div>
        <p id="forgotError" class="form-error" role="alert"></p>
      </form>
    </section>
  `;

  document.getElementById('backToLogin')?.addEventListener('click', renderAuthScreen);
  document.getElementById('forgotForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const error = document.getElementById('forgotError');
    error.textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Sending...';
    try {
      const response = await fetch(apiUrl('/api/auth/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not send reset link');
      error.textContent = '';
      showToast(payload.message || 'Reset link sent');
      document.getElementById('forgotForm').innerHTML = `<p class="lead" style="font-weight:700;">Check your inbox.</p>
        <p class="muted">If ${escapeHTML(email)} matches an account, a reset link is on its way.</p>`;
    } catch (error) {
      error.textContent = error.message;
      button.disabled = false;
      button.textContent = 'Send reset link';
    }
  });
}

function renderResetPassword(token) {
  if (!main) return;
  setAppMode('dispatcher');
  main.innerHTML = `
    <div class="view-header">
      <div>
        <p class="eyebrow">SECURE ACCESS</p>
        <h1>Choose a new password</h1>
        <p class="view-subtitle">It must be at least 8 characters long.</p>
      </div>
    </div>
    <section class="panel data-panel empty-panel" style="padding:32px 24px;max-width:560px;">
      <form id="resetForm" style="display:grid;gap:16px;">
        <label style="display:grid;gap:8px;font-weight:700;">New password
          <input id="resetPassword" name="password" type="password" minlength="8" placeholder="••••••••" required style="padding:12px;border:1px solid #dce5e1;border-radius:8px;" />
        </label>
        <div style="display:flex;gap:12px;">
          <button type="submit" class="dispatch-button" style="flex:1;">Update password</button>
        </div>
        <p id="resetError" class="form-error" role="alert"></p>
      </form>
    </section>
  `;

  document.getElementById('resetForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    const error = document.getElementById('resetError');
    error.textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Updating...';
    try {
      const response = await fetch(apiUrl('/api/auth/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not update password');
      error.textContent = '';
      showToast(payload.message || 'Password updated');
      renderAuthScreen();
    } catch (error) {
      error.textContent = error.message;
      button.disabled = false;
      button.textContent = 'Update password';
    }
  });
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function selectAuthMode(selectedMode) {
  document.querySelectorAll('.mode-switch').forEach((item) => item.classList.toggle('active', item.dataset.mode === selectedMode));
  if (selectedMode === 'customer') {
    setAppMode('customer');
    renderCustomerHome();
  } else if (selectedMode === 'operator') {
    setAppMode('operator');
    const form = document.getElementById('authForm');
    if (form) form.dataset.portalMode = 'operator';
  } else {
    setAppMode('dispatcher');
    renderAuthScreen();
  }
}

async function requestOverview() {
  const response = await fetchJson('/api/overview');
  if (!response.ok) throw new Error('Overview unavailable');
  state = await response.json();
  return state;
}

async function optimizeRoute() {
  const button = document.getElementById('optimizeRoute');
  if (button) { button.disabled = true; button.textContent = 'Optimizing...'; }
  try {
    const previewResponse = await fetchJson('/api/optimization/preview');
    const preview = await previewResponse.json();
    if (!previewResponse.ok) throw new Error(preview.error || 'Could not preview route');
    const activeLoads = preview.jobs.map((job) => `${job.id} (${job.optimizationReason})`).join(' → ');
    const message = activeLoads ? `Suggested order: ${activeLoads}` : 'No active loads to optimize';
    if (!window.confirm(`${message}\n\nApply this route order?`)) return;
    const response = await fetchJson('/api/optimization/apply', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not apply route');
    await requestOverview();
    renderView(window.location.hash.slice(1) || 'dispatch');
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Optimize route'; }
  }
}

async function openAssignPicker(id) {
  const modal = document.getElementById('jobDetailModal');
  const content = document.getElementById('jobDetailContent');
  const title = document.getElementById('jobDetailTitle');
  const subtitle = document.getElementById('jobDetailSubtitle');
  if (!modal || !content) return;

  await requestOverview();
  const job = state.jobs.find((item) => item.id === id);
  const availableDrivers = (state.drivers || []).filter((driver) => driver.status === 'Available');
  const availableVehicles = (state.vehicles || []).filter((vehicle) => vehicle.status === 'available');
  if (!job) return showToast('Job unavailable');

  modal.hidden = false;
  if (title) title.textContent = job.id;
  if (subtitle) subtitle.textContent = `${job.type} · Assign driver and vehicle`;
  content.innerHTML = `
    <div class="detail-status-row"><span class="job-tag">${escapeHTML(job.type)}</span><span class="detail-status">queued</span></div>
    <div class="detail-route"><div class="detail-route-point"><span class="route-dot from"></span><div><small>FROM</small><strong>${escapeHTML(job.from)}</strong></div></div><div class="detail-route-line"></div><div class="detail-route-point"><span class="route-dot to"></span><div><small>TO</small><strong>${escapeHTML(job.to)}</strong></div></div></div>
    <form id="assignForm" class="assign-form">
      <div class="assign-grid">
        <label>Driver<select name="driverId" required>
          <option value="" disabled selected>Choose an available driver</option>
          ${availableDrivers.length ? availableDrivers.map((driver) => `<option value="${escapeHTML(driver.id)}">${escapeHTML(driver.name)}</option>`).join('') : '<option value="" disabled>No drivers available</option>'}
        </select></label>
        <label>Vehicle<select name="vehicleId" required>
          <option value="" disabled selected>Choose an available vehicle</option>
          ${availableVehicles.length ? availableVehicles.map((vehicle) => `<option value="${escapeHTML(vehicle.id)}">${escapeHTML(vehicle.plate)} · ${escapeHTML(vehicle.model)}</option>`).join('') : '<option value="" disabled>No vehicles available</option>'}
        </select></label>
      </div>
      <p class="assign-hint">Only drivers without an active route and vehicles not currently dispatched are listed.</p>
      <p class="form-error" id="assignFormError" role="alert"></p>
      <div class="detail-actions">
        <button class="outline-button" id="cancelAssign" type="button">Cancel</button>
        <button class="dispatch-button" id="confirmAssign" type="submit" ${availableDrivers.length && availableVehicles.length ? '' : 'disabled'}>Confirm assignment <span>→</span></button>
      </div>
    </form>`;

  document.getElementById('cancelAssign')?.addEventListener('click', () => { modal.hidden = true; });
  document.getElementById('assignForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const error = document.getElementById('assignFormError');
    try {
      const driverId = String(form.get('driverId') || '');
      const vehicleId = String(form.get('vehicleId') || '');
      const response = await fetchJson(`/api/jobs/${encodeURIComponent(id)}/assign`, { method: 'POST', body: JSON.stringify({ driverId, vehicleId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not assign this job');
      modal.hidden = true;
      await requestOverview();
      renderView('dispatch');
      showToast(result.message);
    } catch (assignError) {
      if (error) error.textContent = assignError.message;
    }
  });
}

async function assignJob(id) {
  const response = await fetchJson(`/api/jobs/${encodeURIComponent(id)}/assign`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not assign this job');
  await requestOverview();
  renderView('dispatch');
  showToast(result.message);
}

async function openJobDetail(id) {
  const modal = document.getElementById('jobDetailModal');
  const content = document.getElementById('jobDetailContent');
  const title = document.getElementById('jobDetailTitle');
  const subtitle = document.getElementById('jobDetailSubtitle');
  if (!modal || !content) return;

  modal.hidden = false;
  content.innerHTML = '<div class="detail-loading">Loading live job data...</div>';
  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(id)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load job details');
    const job = payload.job;
    if (title) title.textContent = job.id;
    if (subtitle) subtitle.textContent = `${job.type} · ${job.status === 'assigned' ? 'Assigned' : 'Awaiting driver'}`;
    content.innerHTML = `<div class="detail-status-row"><span class="job-tag">${escapeHTML(job.type)}</span><span class="detail-status ${job.status === 'assigned' ? 'is-assigned' : ''}">${escapeHTML(job.status)}</span></div><div class="detail-route"><div class="detail-route-point"><span class="route-dot from"></span><div><small>FROM</small><strong>${escapeHTML(job.from)}</strong></div></div><div class="detail-route-line"></div><div class="detail-route-point"><span class="route-dot to"></span><div><small>TO</small><strong>${escapeHTML(job.to)}</strong></div></div></div><div class="detail-facts"><div><small>PRIORITY</small><strong>${escapeHTML(job.priority)}</strong></div><div><small>SCHEDULE</small><strong>${escapeHTML(job.time)}</strong></div><div><small>DISTANCE</small><strong>${escapeHTML(job.distance)}</strong></div><div><small>PRICE</small><strong>${escapeHTML(job.price)}</strong></div><div><small>DRIVER</small><strong>${escapeHTML(job.driver || 'Unassigned')}</strong></div><div><small>VEHICLE</small><strong>${escapeHTML((job.vehicleId && state.vehicles?.find((v) => v.id === job.vehicleId)?.plate) || job.vehicleId || 'Unassigned')}</strong></div></div><div class="detail-actions"><button class="outline-button" id="detailEdit" type="button">Edit load</button><button class="outline-button" id="detailRefresh" type="button">Refresh</button>${job.status === 'assigned' ? '<button class="dispatch-button" disabled>Driver assigned <span>✓</span></button>' : '<button class="dispatch-button" id="detailAssign" type="button">Assign driver & vehicle <span>→</span></button>'}<button class="danger-button" id="detailDelete" type="button">Delete</button></div>`;
    document.getElementById('detailRefresh')?.addEventListener('click', () => openJobDetail(id));
    document.getElementById('detailAssign')?.addEventListener('click', async () => { modal.hidden = true; await openAssignPicker(id); });
    document.getElementById('detailEdit')?.addEventListener('click', () => renderJobEditForm(job));
    document.getElementById('detailDelete')?.addEventListener('click', () => deleteJob(id));
  } catch (error) {
    content.innerHTML = `<p class="form-error">${escapeHTML(error.message)}</p>`;
  }
}

function renderJobEditForm(job) {
  const content = document.getElementById('jobDetailContent');
  if (!content) return;
  content.innerHTML = `<form id="jobEditForm" class="job-edit-form"><label>Load type<select name="type"><option value="PICKUP" ${job.type === 'PICKUP' ? 'selected' : ''}>Pickup</option><option value="DELIVERY" ${job.type === 'DELIVERY' ? 'selected' : ''}>Delivery</option></select></label><label>Pickup address<input name="from" value="${escapeHTML(job.from)}" maxlength="500" required /></label><label>Delivery address<input name="to" value="${escapeHTML(job.to)}" maxlength="500" required /></label><div class="job-edit-grid"><label>Priority<select name="priority"><option ${job.priority === 'Standard' ? 'selected' : ''}>Standard</option><option ${job.priority === 'High priority' ? 'selected' : ''}>High priority</option><option ${job.priority === 'Urgent' ? 'selected' : ''}>Urgent</option></select></label><label>Status<select name="status"><option value="queued" ${job.status === 'queued' ? 'selected' : ''}>Queued</option><option value="assigned" ${job.status === 'assigned' ? 'selected' : ''}>Assigned</option><option value="completed" ${job.status === 'completed' ? 'selected' : ''}>Completed</option><option value="cancelled" ${job.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></label></div><label>Schedule<input name="time" value="${escapeHTML(job.time)}" maxlength="100" required /></label><p class="form-error" id="jobEditError" role="alert"></p><div class="detail-actions"><button class="outline-button" id="cancelJobEdit" type="button">Cancel</button><button class="dispatch-button" type="submit">Save changes <span>✓</span></button></div></form>`;
  document.getElementById('cancelJobEdit')?.addEventListener('click', () => openJobDetail(job.id));
  document.getElementById('jobEditForm')?.addEventListener('submit', (event) => saveJobEdit(event, job.id));
}

async function saveJobEdit(event, id) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const error = document.getElementById('jobEditError');
  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(form.entries())) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update load');
    await requestOverview();
    closeJobDetail();
    renderView(window.location.hash.slice(1) || 'dispatch');
    showToast(result.message);
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function deleteJob(id) {
  if (!window.confirm(`Remove ${id} from the dispatch board?`)) return;
  const response = await fetchJson(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Could not remove load');
  await requestOverview();
  closeJobDetail();
  renderView(window.location.hash.slice(1) || 'dispatch');
  showToast(result.message);
}

function closeJobDetail() {
  const modal = document.getElementById('jobDetailModal');
  if (modal) modal.hidden = true;
}

function selectJob(id) {
  const job = state.jobs.find((item) => item.id === id);
  const selectedJob = document.getElementById('selectedJob');
  if (!job || !selectedJob) return;
  document.querySelectorAll('.queue-item').forEach((item) => item.classList.toggle('selected', item.dataset.job === id));
  if (leafletMap && job.lat != null && job.lng != null) leafletMap.flyTo([job.lat, job.lng], 14, { duration: 0.9 });
  selectedJob.innerHTML = `<div class="selected-job-top"><div><span class="job-tag">${escapeHTML(job.type)}</span><h3>${escapeHTML(id)}</h3></div><span class="priority">● ${escapeHTML(job.priority)}</span></div><div class="route"><div class="route-line"><span class="route-dot from"></span><span></span><span class="route-dot to"></span></div><div><p><small>FROM</small> ${escapeHTML(job.from)}</p><p><small>TO</small> ${escapeHTML(job.to)}</p></div></div><div class="job-detail"><span>${escapeHTML(job.time)}</span><span>${escapeHTML(job.distance)}</span><span>${escapeHTML(job.price)}</span></div>${job.driver ? `<p class="assigned-driver">Assigned to ${escapeHTML(job.driver)}${job.vehicleId ? ` · ${escapeHTML(state.vehicles?.find((v) => v.id === job.vehicleId)?.plate || job.vehicleId)}` : ''}</p>` : ''}<div class="selected-job-actions"><button class="outline-button" id="viewJobDetails" type="button">View details</button><button class="dispatch-button" id="dispatchButton">${job.status === 'assigned' ? 'Driver assigned' : 'Assign driver & vehicle'} <span>${job.status === 'assigned' ? '✓' : '→'}</span></button></div>`;
  const button = document.getElementById('dispatchButton');
  if (job.status === 'assigned') { button.disabled = true; button.style.background = 'var(--green)'; }
  else button.addEventListener('click', () => openAssignPicker(id));
  document.getElementById('viewJobDetails')?.addEventListener('click', () => openJobDetail(id));
}

function renderQueue() {
  const list = document.getElementById('queueList');
  if (!list) return;
  const queuedJobs = state.jobs.filter((job) => job.status === 'queued');
  list.innerHTML = queuedJobs.map((job, index) => `<button class="queue-item ${index === 0 ? 'selected' : ''}" data-job="${escapeHTML(job.id)}"><span class="queue-status ${['orange-status', 'blue-status', 'violet-status', 'green-status'][index % 4]}"></span><span class="queue-copy"><strong>${escapeHTML(job.id)}</strong><small>${escapeHTML(job.type[0] + job.type.slice(1).toLowerCase())} · ${escapeHTML(job.from.replace(' Street', ' St'))}</small></span><span class="queue-time">${index === 0 ? 'Now' : `${index * 8} min`}</span></button>`).join('');
  list.querySelectorAll('.queue-item').forEach((item) => item.addEventListener('click', () => selectJob(item.dataset.job)));
  document.querySelector('.queue-count').textContent = queuedJobs.length;
}

async function renderSchedule(selectedDate = 'today') {
  main.innerHTML = '<div class="schedule-loading">Loading live schedule...</div>';
  try {
    const response = await fetchJson(`/api/schedule?date=${encodeURIComponent(selectedDate)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Schedule unavailable');
    const columns = [
      { key: 'queued', label: 'Needs dispatch', tone: 'orange' },
      { key: 'assigned', label: 'Assigned', tone: 'blue' },
      { key: 'completed', label: 'Completed', tone: 'green' }
    ];
    const dateLabel = selectedDate === 'today' ? 'Today' : new Date(`${selectedDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    main.innerHTML = `<div class="view-header schedule-header"><div><p class="eyebrow">OPERATIONS PLANNER</p><h1>Schedule board</h1><p class="view-subtitle">Coordinate jobs by status and keep every route moving.</p></div><div class="schedule-actions"><button class="outline-button" id="schedulePrevious" type="button">← Previous</button><button class="small-filter" id="scheduleToday" type="button">${dateLabel}</button><button class="outline-button" id="scheduleNext" type="button">Next →</button><button class="dispatch-button" id="scheduleNewJob" type="button">+ New job</button></div></div><div class="schedule-summary"><span><i class="summary-dot orange"></i>${payload.columns.queued.length} awaiting dispatch</span><span><i class="summary-dot blue"></i>${payload.columns.assigned.length} assigned</span><span><i class="summary-dot green"></i>${payload.columns.completed.length} completed</span><span class="schedule-updated">Updated ${new Date(payload.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div><section class="schedule-board">${columns.map((column) => `<article class="schedule-column"><div class="schedule-column-heading"><div><span class="column-kicker ${column.tone}"></span><h2>${column.label}</h2></div><strong>${payload.columns[column.key].length}</strong></div><div class="schedule-cards">${payload.columns[column.key].length ? payload.columns[column.key].map((job) => `<button class="schedule-card" data-job="${escapeHTML(job.id)}"><div class="schedule-card-top"><strong>${escapeHTML(job.id)}</strong><span class="job-tag">${escapeHTML(job.type)}</span></div><div class="schedule-card-route"><span>${escapeHTML(job.from)}</span><b>→</b><span>${escapeHTML(job.to)}</span></div><div class="schedule-card-meta"><span>${escapeHTML(job.time)}</span><span>${escapeHTML(job.distance)}</span><span>${escapeHTML(job.driver || 'Unassigned')}</span></div>${column.key === 'queued' ? '<span class="schedule-card-action">Open and assign →</span>' : '<span class="schedule-card-action">View details →</span>'}</button>`).join('') : '<div class="schedule-empty">No jobs in this lane.</div>'}</div></article>`).join('')}</section>`;

    document.querySelectorAll('.schedule-card').forEach((card) => card.addEventListener('click', () => openJobDetail(card.dataset.job)));
    document.getElementById('scheduleNewJob')?.addEventListener('click', openJobModal);
    document.getElementById('scheduleToday')?.addEventListener('click', () => renderSchedule('today'));
    document.getElementById('schedulePrevious')?.addEventListener('click', () => renderSchedule(shiftScheduleDate(selectedDate, -1)));
    document.getElementById('scheduleNext')?.addEventListener('click', () => renderSchedule(shiftScheduleDate(selectedDate, 1)));
  } catch (error) {
    main.innerHTML = `<div class="empty-state"><strong>Schedule unavailable</strong><p>${escapeHTML(error.message)}</p><button class="outline-button" id="scheduleRetry" type="button">Retry</button></div>`;
    document.getElementById('scheduleRetry')?.addEventListener('click', () => renderSchedule(selectedDate));
  }
}

function shiftScheduleDate(selectedDate, offset) {
  const base = selectedDate === 'today' ? new Date() : new Date(`${selectedDate}T12:00:00`);
  base.setDate(base.getDate() + offset);
  return base.toISOString().slice(0, 10);
}

function formatLiveDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date).toUpperCase();
}

function getGreeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderLiveDateAndGreeting() {
  const stamp = document.getElementById('liveDateStamp');
  const greeting = document.getElementById('liveGreeting');
  if (stamp) stamp.textContent = formatLiveDate();
  if (greeting) {
    const name = getDisplayName().split(' ')[0];
    const hour = new Date().getHours();
    const currentGreeting = getGreeting();
    greeting.innerHTML = `${currentGreeting}, ${escapeHTML(name)} <span>✦</span>`;
    greeting.title = `Local time: ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  updateSidebarUser();
}

function renderMapPins() {
  if (!mapMarkers || !L) return;
  mapMarkers.clearLayers();
  if (mapRouteLines) mapRouteLines.clearLayers();
  if (!leafletMap) return;
  const jobs = state.jobs.slice(0, 4);
  const colorByPriority = { 'High priority': 'orange', Urgent: 'orange' };
  jobs.forEach((job, index) => {
    const color = colorByPriority[job.priority] || (job.type === 'DELIVERY' ? 'blue' : 'violet');
    const symbol = job.type === 'PICKUP' ? '↗' : '◆';
    const isAssigned = job.status === 'assigned';
    const isCompleted = job.status === 'completed';
    const markerColor = isCompleted ? 'completed' : isAssigned ? 'assigned' : color;
    const pulseColor = isCompleted || isAssigned ? null : color;
    const svgIcon = createMapMarkerIcon(markerColor, symbol);
    if (job.lat != null && job.lng != null) {
      const marker = L.marker([job.lat, job.lng], { icon: svgIcon })
        .addTo(mapMarkers)
        .bindPopup(`<div class="map-popup"><strong>${escapeHTML(job.id)}</strong><span class="map-popup-tag">${escapeHTML(job.type)}</span><p>${escapeHTML(job.from)} → ${escapeHTML(job.to)}</p><small>${escapeHTML(job.distance)} · ${escapeHTML(job.price)}</small></div>`, { closeButton: false, offset: [0, -12], className: 'rz-popup' });
      marker.on('click', () => selectJob(job.id));
    }
    if (job.lat != null && job.lng != null && job.toLat != null && job.toLng != null && !isCompleted) {
      const linePoints = [[job.lat, job.lng], [job.toLat, job.toLng]];
      L.polyline(linePoints, { color: color === 'orange' ? '#f36d3c' : color === 'blue' ? '#5b8def' : '#9b7ae7', weight: 2.5, opacity: 0.45, dashArray: '6,4', className: 'map-route-line' }).addTo(mapRouteLines);
    }
  });
}

function createMapMarkerIcon(color, symbol) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="14" fill="${getMarkerColor(color)}" stroke="white" stroke-width="3"/><text x="17" y="21" text-anchor="middle" fill="white" font-family="Manrope,Arial,sans-serif" font-size="15" font-weight="800">${escapeHTML(symbol)}</text></svg>`;
  return L.divIcon({
    className: 'map-marker',
    html: `<div class="map-marker-pulse ${color}"></div><div class="map-marker-icon ${color}"><span>${escapeHTML(symbol)}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20]
  });
}

function getMarkerColor(name) {
  return { orange: '#f36d3c', blue: '#5b8def', violet: '#9b7ae7', green: '#43b982', completed: '#71807c' }[name] || '#71807c';
}

function updateMapZoom(delta) {
  if (leafletMap) leafletMap.setZoom(leafletMap.getZoom() + delta);
}

async function searchDashboard() {
  const query = window.prompt('Search jobs, customers, or services');
  if (!query || !query.trim()) return;
  const response = await fetchJson(`/api/search?q=${encodeURIComponent(query.trim())}`);
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Search unavailable');
  if (!result.results.length) return showToast('No matching records found');
  showToast(result.results.slice(0, 3).map((item) => item.label).join(' · '));
}

async function showDashboardNotifications() {
  const response = await fetchJson('/api/notifications');
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Notifications unavailable');
  if (!result.notifications.length) return showToast('No unread notifications');
  showToast(result.notifications.map((item) => item.subject).join(' · '));
}

let searchPanelOpen = false;

function toggleSearchPanel() {
  const existing = document.getElementById('searchPanel');
  if (existing) { existing.remove(); searchPanelOpen = false; return; }
  searchPanelOpen = true;
  const panel = document.createElement('div');
  panel.id = 'searchPanel';
  panel.className = 'search-panel';
  panel.innerHTML = '<div class="search-panel-inner"><div class="search-panel-heading"><strong>Search</strong><button class="search-panel-close" id="closeSearchPanel" type="button">&times;</button></div><input class="search-panel-input" id="searchPanelInput" type="search" placeholder="Search jobs, customers, services..." autofocus /><div class="search-panel-results" id="searchPanelResults"><div class="search-panel-empty">Type to search across jobs, customers, and services.</div></div></div>';
  document.querySelector('.app-shell').appendChild(panel);
  document.getElementById('closeSearchPanel')?.addEventListener('click', () => { panel.remove(); searchPanelOpen = false; });
  const input = document.getElementById('searchPanelInput');
  input?.focus();
  let debounce;
  input?.addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const query = e.target.value.trim();
      const results = document.getElementById('searchPanelResults');
      if (!query) { results.innerHTML = '<div class="search-panel-empty">Type to search across jobs, customers, and services.</div>'; return; }
      try {
        const response = await fetchJson(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();
        if (!response.ok) { results.innerHTML = `<div class="search-panel-empty">${escapeHTML(data.error || 'Search unavailable')}</div>`; return; }
        if (!data.results.length) { results.innerHTML = '<div class="search-panel-empty">No matching records found.</div>'; return; }
        results.innerHTML = data.results.map((item) => `<button class="search-result-row" data-type="${escapeHTML(item.type)}" data-id="${escapeHTML(item.id)}"><span class="search-result-type">${escapeHTML(item.type)}</span><div class="search-result-info"><strong>${escapeHTML(item.label)}</strong><small>${escapeHTML(item.status)}</small></div></button>`).join('');
        results.querySelectorAll('.search-result-row').forEach((row) => row.addEventListener('click', () => {
          panel.remove(); searchPanelOpen = false;
          if (row.dataset.type === 'job') { window.location.hash = 'dispatch'; setTimeout(() => openJobDetail(row.dataset.id), 200); }
          else if (row.dataset.type === 'customer') { window.location.hash = 'crm'; }
          else if (row.dataset.type === 'service') { window.location.hash = 'services'; }
        }));
      } catch (error) {
        results.innerHTML = `<div class="search-panel-empty">${escapeHTML(error.message)}</div>`;
      }
    }, 300);
  });
}

let notificationsPanelOpen = false;

function toggleNotificationsPanel() {
  const existing = document.getElementById('notificationsPanel');
  if (existing) { existing.remove(); notificationsPanelOpen = false; return; }
  notificationsPanelOpen = true;
  const panel = document.createElement('div');
  panel.id = 'notificationsPanel';
  panel.className = 'notifications-panel';
  panel.innerHTML = '<div class="notifications-panel-inner"><div class="notifications-panel-heading"><strong>Notifications</strong><button class="search-panel-close" id="closeNotificationsPanel" type="button">&times;</button></div><div class="notifications-panel-body" id="notificationsPanelBody"><div class="search-panel-empty">Loading notifications...</div></div></div>';
  document.querySelector('.app-shell').appendChild(panel);
  document.getElementById('closeNotificationsPanel')?.addEventListener('click', () => { panel.remove(); notificationsPanelOpen = false; });
  loadNotificationsPanel();
}

async function loadNotificationsPanel() {
  const body = document.getElementById('notificationsPanelBody');
  if (!body) return;
  try {
    const response = await fetchJson('/api/notifications');
    const result = await response.json();
    if (!response.ok) { body.innerHTML = `<div class="search-panel-empty">${escapeHTML(result.error || 'Notifications unavailable')}</div>`; return; }
    updateNotificationBadge(result.unread);
    if (!result.notifications.length) { body.innerHTML = '<div class="search-panel-empty">No unread notifications.</div>'; return; }
    body.innerHTML = result.notifications.map((item) => `<div class="notification-row" data-id="${escapeHTML(item.id)}"><span class="notification-dot"></span><div class="notification-info"><strong>${escapeHTML(item.subject)}</strong><small>${escapeHTML(item.body.slice(0, 80))}${item.body.length > 80 ? '...' : ''}</small></div><span class="notification-type">${escapeHTML(item.type)}</span></div>`).join('');
    body.querySelectorAll('.notification-row').forEach((row) => row.addEventListener('click', async () => {
      try {
        await fetchJson(`/api/messages/${encodeURIComponent(row.dataset.id)}/read`, { method: 'PATCH' });
        row.classList.remove('is-unread');
        const dot = row.querySelector('.notification-dot');
        if (dot) dot.style.background = 'transparent';
        refreshNotificationBadge();
      } catch (error) { /* ignore */ }
    }));
  } catch (error) {
    body.innerHTML = `<div class="search-panel-empty">${escapeHTML(error.message)}</div>`;
  }
}

function updateNotificationBadge(count) {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  badge.textContent = count || '0';
  badge.classList.toggle('has-unread', count > 0);
}

async function refreshNotificationBadge() {
  try {
    const response = await fetchJson('/api/notifications');
    const result = await response.json();
    updateNotificationBadge(result.unread || 0);
  } catch (error) { /* ignore */ }
}

function updateMapZoom(delta) {
  const mapCanvas = document.getElementById('mapCanvas');
  if (!mapCanvas) return;
  const current = Number(mapCanvas.dataset.zoom || 1);
  const next = Math.min(1.35, Math.max(.8, current + delta));
  mapCanvas.dataset.zoom = next.toFixed(2);
  mapCanvas.style.transform = `scale(${next})`;
  mapCanvas.style.transformOrigin = 'center';
}

function openJobModal() {
  const modal = document.getElementById('jobModal');
  const form = document.getElementById('jobForm');
  modal.hidden = false;
  document.getElementById('jobFrom').focus();
}

function closeJobModal() {
  const modal = document.getElementById('jobModal');
  modal.hidden = true;
  document.getElementById('jobForm').reset();
  document.getElementById('jobFormError').textContent = '';
}

async function createJob(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const type = form.get('type');
  const from = String(form.get('from') || '').trim();
  const to = String(form.get('to') || '').trim();
  const error = document.getElementById('jobFormError');
  if (!from || !to) { error.textContent = 'Add both pickup and delivery addresses.'; return; }
  try {
    const response = await fetchJson('/api/jobs', { method: 'POST', body: JSON.stringify({ type, from, to }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not create this job');
    closeJobModal();
    await requestOverview();
    renderView('dispatch');
    showToast(`${result.job.id} created`);
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function renderFleet() {
  main.innerHTML = '<div class="schedule-loading">Loading fleet...</div>';
  try {
    const response = await fetchJson('/api/vehicles');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Vehicles unavailable');
    const vehicles = payload.vehicles;
    const total = vehicles.length;
    const available = vehicles.filter((vehicle) => vehicle.status === 'available').length;
    const onRoute = vehicles.filter((vehicle) => vehicle.status === 'on-route').length;
    const maintenance = vehicles.filter((vehicle) => vehicle.status === 'maintenance').length;

    main.innerHTML = `<div class="view-header"><div><p class="eyebrow">OPERATIONS</p><h1>Fleet</h1><p class="view-subtitle">Live vehicle availability, status, and assignments.</p></div><div class="view-actions"><button class="outline-button" id="fleetRefresh">Refresh fleet</button><button class="dispatch-button" id="addVehicle">+ Add vehicle</button></div></div><section class="metric-grid compact-grid"><article class="metric-card"><div class="metric-top"><span>VEHICLES</span><span class="metric-icon blue">◉</span></div><strong>${total}</strong><div class="metric-foot">West Coast fleet</div></article><article class="metric-card"><div class="metric-top"><span>ON ROUTE</span><span class="metric-icon orange">↗</span></div><strong>${onRoute}</strong><div class="metric-foot">Active vehicles</div></article><article class="metric-card"><div class="metric-top"><span>AVAILABLE</span><span class="metric-icon green">✓</span></div><strong>${available}</strong><div class="metric-foot">Ready for dispatch</div></article><article class="metric-card"><div class="metric-top"><span>MAINTENANCE</span><span class="metric-icon violet">◷</span></div><strong>${maintenance}</strong><div class="metric-foot">In the shop</div></article></section><section class="panel data-panel"><div class="panel-heading"><div><p class="eyebrow">FLEET ROSTER</p><h2>Vehicles</h2></div><span class="live-pill"><i></i> Live</span></div><div class="fleet-list">${vehicles.length ? vehicles.map((vehicle) => `<div class="fleet-row" data-vehicle="${escapeHTML(vehicle.id)}"><span class="fleet-vehicle-icon ${vehicleStatusClass(vehicle.status)}">${vehicleTypeIcon(vehicle.vehicleType)}</span><div class="fleet-vehicle-copy"><strong>${escapeHTML(String(vehicle.make + ' ' + vehicle.model).trim())}</strong><small>${escapeHTML(vehicle.plate)} · ${vehicle.year} · ${vehicle.capacity} seats · ${Number(vehicle.mileage).toLocaleString()} mi</small></div><select class="fleet-status-select ${vehicleStatusClass(vehicle.status)}" data-vehicle="${escapeHTML(vehicle.id)}" title="Change status">${fleetStatusOptions(vehicle.status)}</select><span class="fleet-driver">${escapeHTML(vehicle.driverName || 'Unassigned')}</span><div class="fleet-row-actions"><button class="small-link" data-edit="${escapeHTML(vehicle.id)}">Edit</button><button class="small-link danger" data-delete="${escapeHTML(vehicle.id)}">Remove</button></div></div>`).join('') : '<div class="empty-state"><strong>No vehicles yet</strong><p>Add your first vehicle to build the fleet roster.</p></div>'}</div></section>`;

    document.getElementById('fleetRefresh')?.addEventListener('click', async () => { await requestOverview(); renderFleet(); showToast('Fleet data refreshed'); });
    document.getElementById('addVehicle')?.addEventListener('click', () => openVehicleModal());
    document.querySelectorAll('.fleet-status-select').forEach((select) => select.addEventListener('change', () => setVehicleStatus(select.dataset.vehicle, select.value)));
    document.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => { const vehicle = vehicles.find((v) => v.id === button.dataset.edit); if (vehicle) openVehicleModal(vehicle); }));
    document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteVehicle(button.dataset.delete)));
  } catch (error) {
    main.innerHTML = `<div class="empty-state"><strong>Fleet unavailable</strong><p>${escapeHTML(error.message)}</p><button class="outline-button" id="fleetRetry">Retry</button></div>`;
    document.getElementById('fleetRetry')?.addEventListener('click', renderFleet);
  }
}

function renderDrivers() {
  main.innerHTML = '<div class="schedule-loading">Loading roster...</div>';
  const render = (drivers) => {
    const total = drivers.length;
    const onRoute = drivers.filter((driver) => driver.status === 'On route').length;
    const available = drivers.filter((driver) => driver.status === 'Available').length;
    const offline = drivers.filter((driver) => driver.status === 'Offline').length;
    const driverStatusClass = (status) => ({ 'On route': 'is-blue', Available: 'is-green', Offline: 'is-muted' }[status] || '');
    main.innerHTML = `<div class="view-header"><div><p class="eyebrow">OPERATIONS</p><h1>Drivers</h1><p class="view-subtitle">Live driver availability and job coverage.</p></div><div class="view-actions"><button class="outline-button" id="driversRefresh">Refresh roster</button><button class="dispatch-button" id="addDriver">+ Add driver</button></div></div><section class="metric-grid compact-grid"><article class="metric-card"><div class="metric-top"><span>DRIVERS</span><span class="metric-icon blue">◎</span></div><strong>${total}</strong><div class="metric-foot">Active roster</div></article><article class="metric-card"><div class="metric-top"><span>ON ROUTE</span><span class="metric-icon orange">↗</span></div><strong>${onRoute}</strong><div class="metric-foot">Drivers assigned</div></article><article class="metric-card"><div class="metric-top"><span>AVAILABLE</span><span class="metric-icon green">✓</span></div><strong>${available}</strong><div class="metric-foot">Ready for dispatch</div></article><article class="metric-card"><div class="metric-top"><span>OFFLINE</span><span class="metric-icon muted">—</span></div><strong>${offline}</strong><div class="metric-foot">Not on duty</div></article></section><section class="panel data-panel"><div class="panel-heading"><div><p class="eyebrow">LIVE ROSTER</p><h2>Drivers</h2></div><span class="live-pill"><i></i> Live</span></div><div class="fleet-list">${drivers.length ? drivers.map((driver) => `<div class="fleet-row" data-driver="${escapeHTML(driver.id)}"><span class="activity-avatar blue-bg">${escapeHTML(driver.initials)}</span><div class="fleet-vehicle-copy"><strong>${escapeHTML(driver.name)}</strong><small>${escapeHTML(driver.vehicle || 'No vehicle assigned')} · ${Number(driver.jobs) || 0} jobs today</small></div><select class="fleet-status-select ${driverStatusClass(driver.status)}" data-driver-status="${escapeHTML(driver.id)}">${driverStatusOptions(driver.status)}</select><strong class="row-rating">★ ${escapeHTML(driver.rating)}</strong><div class="row-actions"><button class="outline-button" data-edit-driver="${escapeHTML(driver.id)}">Edit</button><button class="danger-button" data-delete-driver="${escapeHTML(driver.id)}">Delete</button></div></div>`).join('') : '<div class="empty-state"><strong>No drivers yet</strong><p>Add your first driver to start dispatching.</p></div>'}</div></section>`;
    document.getElementById('driversRefresh')?.addEventListener('click', async () => { await requestOverview(); renderDrivers(); showToast('Roster refreshed'); });
    document.getElementById('addDriver')?.addEventListener('click', () => openDriverModal());
    document.querySelectorAll('.fleet-status-select').forEach((select) => select.addEventListener('change', () => setDriverStatus(select.dataset.driverStatus, select.value)));
    document.querySelectorAll('[data-edit-driver]').forEach((button) => button.addEventListener('click', () => { const driver = drivers.find((d) => d.id === button.dataset.editDriver); if (driver) openDriverModal(driver); }));
    document.querySelectorAll('[data-delete-driver]').forEach((button) => button.addEventListener('click', () => deleteDriver(button.dataset.deleteDriver)));
  };
  (async () => {
    try {
      const response = await fetchJson('/api/drivers');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Roster unavailable');
      render(payload.drivers || []);
    } catch (error) {
      main.innerHTML = `<div class="empty-state"><strong>Roster unavailable</strong><p>${escapeHTML(error.message)}</p><button class="outline-button" id="driversRetry">Retry</button></div>`;
      document.getElementById('driversRetry')?.addEventListener('click', renderDrivers);
    }
  })();
}

function driverStatusOptions(current) {
  if (current === 'On route') {
    return `<option value="On route" disabled selected>On route</option><option value="Available">Available</option><option value="Offline">Offline</option>`;
  }
  return ['Available', 'Offline'].map((status) => `<option value="${status}" ${status === current ? 'selected' : ''}>${status}</option>`).join('');
}

let editingDriverId = null;

function openDriverModal(driver = null) {
  const modal = document.getElementById('driverModal');
  if (!modal) return;
  editingDriverId = driver ? driver.id : null;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set('driverName', driver ? driver.name : '');
  set('driverInitials', driver ? driver.initials : '');
  set('driverPhone', driver ? driver.phone || '' : '');
  set('driverEmail', driver ? driver.email || '' : '');
  set('driverVehicle', driver ? driver.vehicle || '' : '');
  set('driverRating', driver ? driver.rating : 5);
  set('driverStatus', driver ? driver.status : 'Available');
  document.getElementById('driverModalTitle').textContent = driver ? `Edit ${driver.name}` : 'Add a driver';
  const error = document.getElementById('driverFormError');
  if (error) error.textContent = '';
  modal.hidden = false;
  document.getElementById('driverName')?.focus();
}

function closeDriverModal() {
  const modal = document.getElementById('driverModal');
  if (modal) modal.hidden = true;
  editingDriverId = null;
}

async function saveDriver(event) {
  event.preventDefault();
  const errorEl = document.getElementById('driverFormError');
  const form = document.getElementById('driverForm');
  const raw = Object.fromEntries(new FormData(form).entries());
  errorEl.textContent = '';
  if (!raw.name.trim()) {
    errorEl.textContent = 'Driver name is required.';
    return;
  }
  const body = { name: raw.name, initials: raw.initials, phone: raw.phone, email: raw.email, vehicle: raw.vehicle, rating: Number(raw.rating) || 5, status: raw.status };
  try {
    const isEdit = Boolean(editingDriverId);
    const response = await fetchJson(`/api/drivers/${isEdit ? encodeURIComponent(editingDriverId) : ''}`, {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save driver');
    showToast(isEdit ? 'Driver updated' : 'Driver added');
    closeDriverModal();
    renderDrivers();
  } catch (error) {
    errorEl.textContent = error.message || 'Save failed';
  }
}

async function setDriverStatus(id, status) {
  try {
    const response = await fetchJson(`/api/drivers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update status');
    showToast(`${data.driver?.name || id} is now ${status}`);
  } catch (error) {
    showToast(error.message || 'Status update failed');
  }
  renderDrivers();
  await requestOverview();
}

async function deleteDriver(id) {
  if (!window.confirm(`Remove driver ${id} from the roster?`)) return;
  try {
    const response = await fetchJson(`/api/drivers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not remove driver');
    showToast(`Driver ${id} removed`);
  } catch (error) {
    showToast(error.message || 'Removal failed');
  }
  renderDrivers();
  await requestOverview();
}

function fleetStatusOptions(current) {
  return ['available', 'on-route', 'off-duty', 'maintenance'].map((status) => `<option value="${status}" ${status === current ? 'selected' : ''}>${fleetStatusLabel(status)}</option>`).join('');
}

function fleetStatusLabel(status) {
  return { available: 'Available', 'on-route': 'On route', 'off-duty': 'Off duty', maintenance: 'Maintenance' }[status] || status;
}

function vehicleStatusClass(status) {
  return { available: 'is-green', 'on-route': 'is-blue', 'off-duty': 'is-muted', maintenance: 'is-orange' }[status] || '';
}

function vehicleTypeIcon(type) {
  return { sedan: '🚗', suv: '🚙', van: '🚐', truck: '🛻', luxury: '🚘' }[type] || '🚘';
}

function openVehicleModal(vehicle = null) {
  const modal = document.getElementById('vehicleModal');
  if (!modal) return;
  editingVehicleId = vehicle ? vehicle.id : null;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set('vehiclePlate', vehicle ? vehicle.plate : '');
  set('vehicleMake', vehicle ? vehicle.make : '');
  set('vehicleModel', vehicle ? vehicle.model : '');
  set('vehicleYear', vehicle ? vehicle.year : new Date().getFullYear());
  set('vehicleType', vehicle ? vehicle.vehicleType : 'sedan');
  set('vehicleCapacity', vehicle ? vehicle.capacity : 4);
  set('vehicleStatus', vehicle ? vehicle.status : 'available');
  set('vehicleMileage', vehicle ? vehicle.mileage : 0);
  document.getElementById('vehicleModalTitle').textContent = vehicle ? `Edit ${vehicle.plate}` : 'Add a vehicle';
  const error = document.getElementById('vehicleFormError');
  if (error) error.textContent = '';
  modal.hidden = false;
  document.getElementById('vehiclePlate')?.focus();
}

function closeVehicleModal() {
  const modal = document.getElementById('vehicleModal');
  if (modal) modal.hidden = true;
  editingVehicleId = null;
}

async function saveVehicle(event) {
  event.preventDefault();
  const errorEl = document.getElementById('vehicleFormError');
  const form = document.getElementById('vehicleForm');
  const raw = Object.fromEntries(new FormData(form).entries());
  errorEl.textContent = '';
  if (!raw.plate.trim() || !raw.make.trim() || !raw.model.trim()) {
    errorEl.textContent = 'Plate, make, and model are required.';
    return;
  }
  const body = { plate: raw.plate, make: raw.make, model: raw.model, year: Number(raw.year) || 2025, vehicleType: raw.vehicleType, capacity: Number(raw.capacity) || 4, status: raw.status, mileage: Number(raw.mileage) || 0 };
  try {
    const isEdit = Boolean(editingVehicleId);
    const response = await fetchJson(`/api/vehicles/${isEdit ? encodeURIComponent(editingVehicleId) : ''}`, {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save vehicle');
    showToast(isEdit ? 'Vehicle updated' : 'Vehicle added');
    closeVehicleModal();
    renderFleet();
  } catch (error) {
    errorEl.textContent = error.message || 'Save failed';
  }
}

async function setVehicleStatus(id, status) {
  try {
    const response = await fetchJson(`/api/vehicles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update status');
    showToast(`Vehicle set to ${fleetStatusLabel(status)}`);
  } catch (error) {
    showToast(error.message || 'Status update failed');
  }
  renderFleet();
}

async function deleteVehicle(id) {
  if (!window.confirm(`Remove vehicle ${id} from the fleet?`)) return;
  try {
    const response = await fetchJson(`/api/vehicles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not remove vehicle');
    showToast(`Vehicle ${id} removed`);
  } catch (error) {
    showToast(error.message || 'Removal failed');
  }
  renderFleet();
}

function renderAnalytics() {
  const analytics = state.analytics;
  main.innerHTML = `<div class="view-header"><div><p class="eyebrow">PERFORMANCE</p><h1>Analytics</h1><p class="view-subtitle">A live readout of the same dispatch activity.</p></div><button class="small-filter" id="analyticsRefresh">Today⌄</button></div><section class="metric-grid compact-grid"><article class="metric-card"><div class="metric-top"><span>COMPLETED</span><span class="metric-icon green">✓</span></div><strong>${analytics.completed}</strong><div class="metric-foot"><span class="up">↑ 6.4%</span> vs yesterday</div></article><article class="metric-card"><div class="metric-top"><span>ON-TIME RATE</span><span class="metric-icon blue">◈</span></div><strong>${analytics.onTimeRate}<em>%</em></strong><div class="metric-foot">Target 90%</div></article><article class="metric-card"><div class="metric-top"><span>UTILIZATION</span><span class="metric-icon violet">◷</span></div><strong>${analytics.utilization}<em>%</em></strong><div class="metric-foot">Fleet capacity used</div></article><article class="metric-card"><div class="metric-top"><span>DISTANCE</span><span class="metric-icon orange">↗</span></div><strong>${escapeHTML(analytics.distance)}</strong><div class="metric-foot">Across active jobs</div></article></section><section class="panel data-panel"><div class="panel-heading"><div><p class="eyebrow">OPERATIONS LOG</p><h2>Recent activity</h2></div></div><div class="activity-list">${state.activity.slice(0, 8).map((item, index) => `<div class="activity-row"><span class="activity-avatar ${['orange-bg', 'blue-bg', 'violet-bg'][index % 3]}">${escapeHTML(item.initials)}</span><div><strong>${escapeHTML(item.name)} <span>${escapeHTML(item.action)}</span></strong><small>${escapeHTML(item.detail)}</small></div><time>${escapeHTML(item.time)}</time></div>`).join('')}</div></section>`;
  document.getElementById('analyticsRefresh')?.addEventListener('click', async () => { await requestOverview(); renderAnalytics(); showToast('Analytics refreshed'); });
}

let inboxState = { filter: 'all', search: '', selected: null };

async function renderInbox(keepOpen = false) {
  main.innerHTML = '<div class="schedule-loading">Loading communication center...</div>';
  let messages = [];
  let unread = 0;
  try {
    const query = new URLSearchParams({ filter: inboxState.filter });
    if (inboxState.search) query.set('search', inboxState.search);
    const response = await fetchJson(`/api/messages?${query.toString()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Messages unavailable');
    messages = payload.messages;
    unread = payload.unread;
  } catch (error) {
    main.innerHTML = `<div class="empty-state"><strong>Communication center unavailable</strong><p>${escapeHTML(error.message)}</p><button class="outline-button" id="messagesRetry">Retry</button></div>`;
    document.getElementById('messagesRetry')?.addEventListener('click', renderInbox);
    return;
  }
  const firstMessage = messages[0] || null;
  if (keepOpen && inboxState.selected) {
    const keep = messages.find((message) => message.id === inboxState.selected);
    if (keep) { messages = [keep, ...messages.filter((message) => message.id !== keep.id)]; }
  }
  const listHtml = messages.length ? messages.map((message) => `<button class="message-row ${message.isRead ? '' : 'is-unread'}" data-message="${escapeHTML(message.id)}"><span class="activity-avatar ${message.type === 'fleet' ? 'blue-bg' : message.type === 'system' ? 'violet-bg' : 'orange-bg'}">${escapeHTML(message.initials)}</span><span class="message-row-copy"><strong>${escapeHTML(message.subject)}</strong><small>${escapeHTML(message.sender)}${message.type === 'customer' ? ' <em class="inbox-customer-tag">customer</em>' : ''} · ${escapeHTML(message.body.slice(0, 58))}${message.body.length > 58 ? '...' : ''}</small></span><span class="message-time">${formatMessageTime(message.createdAt)}</span></button>`).join('') : `<div class="empty-state">${inboxState.filter === 'unread' && !inboxState.search ? 'You are all caught up.' : 'No messages match your search.'}</div>`;
  main.innerHTML = `<div class="view-header"><div><p class="eyebrow">OPERATIONS COMMS</p><h1>Communication center</h1><p class="view-subtitle">Keep dispatch, fleet, and customer conversations in one place.</p></div><button class="dispatch-button" id="composeMessage" type="button">+ New message</button></div><section class="communication-layout"><div class="panel message-list-panel"><div class="message-list-heading"><strong>Inbox</strong><span>${unread} unread</span></div><div class="inbox-toolbar"><span class="inbox-tabs"><button class="inbox-tab ${inboxState.filter === 'all' ? 'is-active' : ''}" data-inbox-filter="all" type="button">All</button><button class="inbox-tab ${inboxState.filter === 'unread' ? 'is-active' : ''}" data-inbox-filter="unread" type="button">Unread</button></span><span class="inbox-search"><input id="inboxSearchInput" type="search" placeholder="Search messages..." value="${escapeHTML(inboxState.search)}" /><button class="icon-button" id="inboxRefresh" type="button" aria-label="Refresh">↻</button></span></div><div class="presence-strip" id="presenceStrip"></div><div class="message-list" id="messageList">${listHtml}</div></div><article class="panel message-reader" id="messageReader">${firstMessage && keepOpen && inboxState.selected ? renderMessageReader(firstMessage) : firstMessage ? renderMessageReader(firstMessage) : '<div class="empty-state"><strong>Your inbox is clear</strong><p>New operational messages will appear here.</p></div>'}</article></section>`;
  const unreadBadge = document.querySelector('.alert-count');
  if (unreadBadge) unreadBadge.textContent = unread;
  updateNotificationBadge(unread);
  rtRenderPresenceStrip();
  document.querySelectorAll('.message-row').forEach((row) => row.addEventListener('click', () => openInboxMessage(messages.find((message) => message.id === row.dataset.message), messages)));
  document.getElementById('composeMessage')?.addEventListener('click', () => renderComposeMessage());
  document.getElementById('inboxRefresh')?.addEventListener('click', () => { showToast('Inbox refreshed'); renderInbox(true); });
  document.getElementById('inboxSearchInput')?.addEventListener('input', debounce((event) => { inboxState.search = event.target.value.trim(); renderInbox(); }, 250));
  document.querySelectorAll('.inbox-tab').forEach((tab) => tab.addEventListener('click', () => { inboxState.filter = tab.dataset.inboxFilter; renderInbox(); }));
}

function debounce(fn, wait) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

function formatMessageTime(value) {
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderMessageReader(message) {
  const isCustomerThread = Boolean(message.customerEmail);
  return `<div class="message-reader-heading"><div><span class="eyebrow">${escapeHTML(message.type)}</span><h2>${escapeHTML(message.subject)}</h2><p>From ${escapeHTML(message.sender)} · ${formatFullMessageTime(message.createdAt)}</p></div><span class="activity-avatar orange-bg">${escapeHTML(message.initials)}</span></div>${isCustomerThread ? `<div class="customer-context-strip"><div><strong>Customer</strong>${message.customerName ? `<span>${escapeHTML(message.customerName)}</span>` : ''}<em>${escapeHTML(message.customerEmail)}</em></div><button class="outline-button" id="customerThreadView" type="button">View thread</button></div>` : ''}<div class="message-body">${escapeHTML(message.body)}</div><div class="message-reader-actions"><button class="dispatch-button" id="replyMessage" type="button">${isCustomerThread ? 'Reply to customer' : 'Reply'}</button><button class="outline-button" id="markUnreadMessage" type="button">Mark unread</button><button class="danger-button" id="deleteMessage" type="button">Delete</button></div>`;
}

async function openInboxMessage(message, messages) {
  if (!message) return;
  inboxState.selected = message.id;
  const reader = document.getElementById('messageReader');
  if (reader) reader.innerHTML = renderMessageReader(message);
  if (!message.isRead) {
    try {
      await fetchJson(`/api/messages/${encodeURIComponent(message.id)}/read`, { method: 'PATCH', body: '{}' });
    } catch (error) { /* ignore */ }
    message.isRead = 1;
    document.querySelector(`.message-row[data-message="${CSS.escape(message.id)}"]`)?.classList.remove('is-unread');
    refreshInboxBadges();
  }
  document.getElementById('replyMessage')?.addEventListener('click', () => renderComposeMessage(message, Boolean(message.customerEmail)));
  document.getElementById('customerThreadView')?.addEventListener('click', () => showCustomerThreadOverlay(message.customerEmail));
  document.getElementById('markUnreadMessage')?.addEventListener('click', async () => {
    try {
      await fetchJson(`/api/messages/${encodeURIComponent(message.id)}/read`, { method: 'PATCH', body: JSON.stringify({ isRead: 0 }) });
    } catch (error) { /* ignore */ }
    message.isRead = 0;
    document.querySelector(`.message-row[data-message="${CSS.escape(message.id)}"]`)?.classList.add('is-unread');
    refreshInboxBadges();
    showToast('Message marked as unread');
  });
  document.getElementById('deleteMessage')?.addEventListener('click', () => deleteInboxMessage(message, messages));
}

async function deleteInboxMessage(message, messages) {
  if (!window.confirm('Delete this message permanently?')) return;
  try {
    const response = await fetchJson(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not delete message');
    const index = messages.findIndex((m) => m.id === message.id);
    if (index !== -1) messages.splice(index, 1);
    if (inboxState.selected === message.id) inboxState.selected = null;
    refreshInboxBadges();
    showToast('Message deleted');
    renderInbox(true);
  } catch (error) {
    showToast(error.message || 'Delete failed');
  }
}

async function refreshInboxBadges() {
  try {
    const response = await fetchJson('/api/messages?filter=unread');
    const payload = await response.json();
    const unreadBadge = document.querySelector('.alert-count');
    if (unreadBadge) unreadBadge.textContent = payload.unread;
    const headingCount = document.querySelector('.message-list-heading span');
    if (headingCount) headingCount.textContent = payload.unread + ' unread';
    updateNotificationBadge(payload.unread);
  } catch (error) { /* ignore */ }
}

function formatFullMessageTime(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

async function showCustomerThreadOverlay(email) {
  const existing = document.getElementById('customerThreadOverlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'customerThreadOverlay';
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `<div class="modal-card customer-thread-card" role="dialog" aria-modal="true"><div class="modal-head"><div><p class="eyebrow">CUSTOMER THREAD</p><h2>Conversation</h2><p class="view-subtitle">${escapeHTML(email || '')}</p></div><button class="icon-button" id="customerThreadOverlayClose" type="button" aria-label="Close">✕</button></div><div class="customer-thread customer-thread-compact" id="customerThreadOverlayBody"><div class="schedule-loading">Loading conversation...</div></div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
  document.getElementById('customerThreadOverlayClose')?.addEventListener('click', () => overlay.remove());
  const body = document.getElementById('customerThreadOverlayBody');
  try {
    const response = await fetchJson(`/api/customer/messages?email=${encodeURIComponent(email || '')}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load thread');
    if (!payload.messages.length) {
      body.innerHTML = '<div class="empty-state"><strong>No messages yet</strong><p>This customer has not messaged the team yet.</p></div>';
      return;
    }
    body.innerHTML = payload.messages.map(renderCustomerThreadMessage).join('');
  } catch (error) {
    body.innerHTML = `<div class="empty-state"><strong>Could not load thread</strong><p>${escapeHTML(error.message)}</p></div>`;
  }
}

function renderComposeMessage(replyTo = null, isCustomerReply = false) {
  const reader = document.getElementById('messageReader');
  if (!reader) return;
  inboxState.selected = null;
  reader.innerHTML = `<div class="message-reader-heading"><div><span class="eyebrow">${isCustomerReply ? 'CUSTOMER REPLY' : 'NEW MESSAGE'}</span><h2>${isCustomerReply ? `Reply to customer${replyTo.customerName ? ` (${escapeHTML(replyTo.customerName)})` : ''}` : replyTo ? `Reply to ${escapeHTML(replyTo.sender)}` : 'Compose message'}</h2><p>${isCustomerReply ? 'Your reply lands in the customer conversation and is visible to them under their email address.' : 'Send an update to the operations inbox.'}</p></div></div><form id="messageForm" class="message-form">${isCustomerReply ? `<input type="hidden" name="customerEmail" value="${escapeHTML(replyTo.customerEmail)}" />` : ''}<label>Subject<input name="subject" value="${escapeHTML(replyTo ? `Re: ${isCustomerReply ? replyTo.subject.replace(/^Re:\s*/i, '') : replyTo.subject}` : '')}" maxlength="160" required /></label><label>Message<textarea name="body" rows="7" maxlength="1000" placeholder="Write a message..." required>${replyTo ? `\n\n--- Original message ---\n${escapeHTML(replyTo.body)}` : ''}</textarea></label><p class="form-error" id="messageFormError" role="alert"></p><div class="detail-actions"><button class="outline-button" id="cancelMessage" type="button">Cancel</button><button class="dispatch-button" type="submit">Send message <span>→</span></button></div></form>`;
  document.getElementById('cancelMessage')?.addEventListener('click', () => renderInbox(true));
  document.getElementById('messageForm')?.addEventListener('submit', sendMessage);
}

async function sendMessage(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const error = document.getElementById('messageFormError');
  const payload = { subject: form.get('subject'), body: form.get('body') };
  const customerEmail = String(form.get('customerEmail') || '').trim();
  if (customerEmail) payload.customerEmail = customerEmail;
  try {
    const response = await fetchJson('/api/messages', { method: 'POST', body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not send message');
    inboxState.selected = result.message?.id || null;
    if (typeof rtRecentSent !== 'undefined' && result.message) rtRecentSent.add(result.message.id);
    showToast('Message sent');
    await refreshInboxBadges();
    await renderInbox(true);
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

function renderSimpleView(title, subtitle, content) {
  main.innerHTML = `<div class="view-header"><div><p class="eyebrow">WORKSPACE</p><h1>${title}</h1><p class="view-subtitle">${subtitle}</p></div></div><section class="panel data-panel empty-panel">${content}</section>`;
}

async function renderCustomerHome() {
  setAppMode('customer');
  localStorage.setItem(MODE_KEY, 'customer');
  if (!main) return;
  const isSignedIn = Boolean(getAuthToken());
  rtSetupSession();
  main.innerHTML = `
    <div class="customer-shell">
      <div class="customer-topbar"><div class="brand"><span class="brand-mark">R</span><span>RZ DISPATCH</span></div><div class="customer-top-actions"><button class="outline-button" id="customerSettings" type="button">My preferences</button>${isSignedIn ? '<button class="outline-button" id="customerSignOut" type="button">Sign out</button>' : '<button class="dispatch-button" id="customerSignIn" type="button">Sign in</button>'}</div></div>
      <section class="customer-hero">
        <div class="customer-hero-copy">
          <p class="eyebrow">RZ travel services</p>
          <h1>Private transport that feels effortless.</h1>
          <p>Book airport rides, same-day trips, executive travel, and hourly charters with dispatch coordination and up-to-date trip status.</p>
          <div class="customer-hero-actions">
            <button class="dispatch-button" type="button" id="customerBookNow">Book a trip</button>
            <button class="outline-button" type="button" id="customerTrackOrder">Track an order</button>
          </div>
          <div class="customer-hero-badges">
            <span>✔ Fully insured</span>
            <span>✔ Live support</span>
            <span>✔ Verified drivers</span>
          </div>
        </div>
        <div class="customer-hero-panel panel">
          <p class="eyebrow">Popular routes</p>
          <ul>
            <li><strong>SFO → Downtown</strong><span>From $79</span></li>
            <li><strong>OAK → Business district</strong><span>From $68</span></li>
            <li><strong>SJC → Bayfront</strong><span>From $88</span></li>
            <li><strong>Hourly charter</strong><span>From $120/hr</span></li>
          </ul>
        </div>
      </section>
      <section class="customer-service-grid">
        <article class="customer-card panel">
          <p class="eyebrow">Airport transfers</p>
          <h3>Flight-aware service</h3>
          <p>On-time pickups coordinated around your flight schedule.</p>
        </article>
        <article class="customer-card panel">
          <p class="eyebrow">Same-day rides</p>
          <h3>Fast local trips</h3>
          <p>Last-minute rides, errands, and quick business pickups with up-to-date ETAs.</p>
        </article>
        <article class="customer-card panel">
          <p class="eyebrow">Hourly charter</p>
          <h3>Flexible by the hour</h3>
          <p>Multi-stop trips, events, and group travel tailored to your schedule.</p>
        </article>
      </section>
      <section class="customer-trust panel">
        <div class="trust-row">
          <div><strong data-field="orders">—</strong><span>Orders handled</span></div>
          <div><strong data-field="customers">—</strong><span>Riders served</span></div>
          <div><strong data-field="drivers">—</strong><span>Verified drivers</span></div>
          <div><strong>24/7</strong><span>Support</span></div>
        </div>
      </section>
      <section class="customer-options panel">
        <div><p class="eyebrow">WE'RE HERE TO HELP</p><h2>Talk to the dispatch team</h2><p>Message our dispatchers about a booking, ride, or question — replies show up in your conversation.</p></div>
        <div class="customer-option-actions"><button class="dispatch-button" id="customerContact" type="button">Message the team</button><button class="outline-button" id="customerSettingsSecondary" type="button">Manage profile and preferences</button></div>
      </section>
    </div>
  `;

  document.getElementById('customerBookNow')?.addEventListener('click', () => {
    openQuoteModal();
  });
  document.getElementById('customerTrackOrder')?.addEventListener('click', () => {
    renderCustomerPortal();
  });
  document.getElementById('customerSettings')?.addEventListener('click', renderCustomerSettings);
  document.getElementById('customerSettingsSecondary')?.addEventListener('click', renderCustomerSettings);
  document.getElementById('customerContact')?.addEventListener('click', () => renderCustomerContact());
  document.getElementById('customerSignIn')?.addEventListener('click', () => {
    setAppMode('dispatcher');
    renderAuthScreen();
  });
  document.getElementById('customerSignOut')?.addEventListener('click', signOutToCustomer);

  await fillCustomerTrustStats();
}

function signOutToCustomer() {
  if (window.RZRealtime) window.RZRealtime.disconnect();
  setAuthToken('');
  localStorage.setItem(MODE_KEY, 'customer');
  setAppMode('customer');
  renderCustomerHome();
}

async function fillCustomerTrustStats() {
  const apply = (field, value) => {
    document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => { el.textContent = value > 0 ? value.toLocaleString() : '—'; });
  };
  try {
    const response = await fetch(apiUrl('/api/customer/stats'));
    const payload = await response.json();
    if (response.ok && payload.stats) {
      apply('orders', Number(payload.stats.orders) || 0);
      apply('customers', Number(payload.stats.customers) || 0);
      apply('drivers', Number(payload.stats.drivers) || 0);
      return;
    }
  } catch (error) {
    // Keep the neutral placeholders when the backend is unreachable.
  }
  ['orders', 'customers', 'drivers'].forEach((field) => apply(field, 0));
}

function signOutToDispatcher() {
  if (window.RZRealtime) window.RZRealtime.disconnect();
  setAuthToken('');
  localStorage.setItem(MODE_KEY, 'dispatcher');
  setAppMode('dispatcher');
  window.location.hash = 'dispatch';
  renderAuthScreen();
}

async function renderOperatorPortal() {
  setAppMode('operator');
  if (!main) return;
  main.innerHTML = '<div class="operator-loading">Loading your route...</div>';
  try {
    const response = await fetchJson('/api/operator/jobs');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Operator portal unavailable');
    const jobs = payload.jobs || [];
    const vehiclesRes = await fetchJson('/api/vehicles');
    const vehiclesPayload = await vehiclesRes.json();
    if (vehiclesRes.ok) state.vehicles = vehiclesPayload.vehicles || [];
    main.innerHTML = `<div class="operator-shell"><header class="operator-topbar"><div><p class="eyebrow">OPERATOR PORTAL</p><h1>Good to go, ${escapeHTML(payload.operator.name.split(' ')[0])}</h1><p>${escapeHTML(payload.operator.driverId)} · Your assigned route</p></div><button class="operator-icon-button" id="operatorSignOut" type="button" aria-label="Sign out">↪</button></header><section class="operator-summary"><div><span>ASSIGNED LOADS</span><strong>${jobs.length}</strong></div><div><span>ACTIVE</span><strong>${jobs.filter((job) => !['completed', 'cancelled'].includes(job.status)).length}</strong></div><div><span>VEHICLE</span><strong>${escapeHTML(getOperatorVehicle(payload.operator.driverId))}</strong></div></section><section class="operator-section"><div class="operator-section-heading"><div><p class="eyebrow">TODAY'S ROUTE</p><h2>Assigned jobs</h2></div><button class="operator-refresh" id="operatorRefresh" type="button">Refresh</button></div><div class="operator-job-list">${jobs.length ? jobs.map((job) => renderOperatorJobCard(job)).join('') : '<div class="operator-empty"><strong>No assigned jobs</strong><p>Your dispatcher will add jobs to your route here.</p></div>'}</div></section><section class="operator-section"><div class="operator-section-heading"><div><p class="eyebrow">DISPATCH COMMS</p><h2>Messages</h2></div><button class="operator-refresh" id="operatorMessagesRefresh" type="button">↻</button></div><div class="operator-msgs" id="operatorMessagesBox"><div class="operator-empty"><p>Loading messages...</p></div></div><form id="operatorMessageForm" class="operator-msg-form"><p class="eyebrow">SEND A MESSAGE</p><input name="subject" maxlength="160" placeholder="Subject, e.g. Delay on JO-8421" required /><textarea name="body" rows="3" maxlength="1000" placeholder="Message for the dispatch team..." required></textarea><p class="form-error" id="operatorMessageError" role="alert"></p><button class="operator-primary" type="submit">Send to dispatch <span>→</span></button></form></section></div>`;
    document.getElementById('operatorSignOut')?.addEventListener('click', signOutToDispatcher);
    document.getElementById('operatorRefresh')?.addEventListener('click', renderOperatorPortal);
    document.getElementById('operatorMessagesRefresh')?.addEventListener('click', loadOperatorMessages);
    document.getElementById('operatorMessageForm')?.addEventListener('submit', sendOperatorMessage);
    document.querySelectorAll('.operator-job-card').forEach((card) => card.addEventListener('click', () => openOperatorJob(card.dataset.job)));
    loadOperatorMessages();
    rtSetupSession();
  } catch (error) {
    const needsOperatorSignIn = /(access required|authentication required|session expired|invalid session)/i.test(String(error.message || ''));
    const signInHint = needsOperatorSignIn
      ? '<p>This browser is signed in with a non-operator account. Use the operator account (operator@rzdispatch.local) to open the operator portal.</p>'
      : '';
    main.innerHTML = `<div class="operator-empty"><strong>Could not load route</strong><p>${escapeHTML(error.message)}</p>${signInHint}<button class="operator-primary" id="operatorRetry" type="button">Retry</button></div>`;
    document.getElementById('operatorRetry')?.addEventListener('click', renderOperatorPortal);
  }
}

function getOperatorVehicle(driverId) {
  return { 'DR-101': 'Van 12', 'DR-102': 'Van 08', 'DR-103': 'Truck 21', 'DR-104': 'Van 04' }[driverId] || 'Assigned vehicle';
}

function renderOperatorJobCard(job) {
  const statusLabel = job.status.replace(/_/g, ' ');
  const vehicleLabel = job.vehicleId ? ((state.vehicles || []).find((v) => v.id === job.vehicleId)?.plate || job.vehicleId) : '';
  return `<button class="operator-job-card" data-job="${escapeHTML(job.id)}" type="button"><div class="operator-job-card-top"><strong>${escapeHTML(job.id)}</strong><span class="operator-status ${job.status}">${escapeHTML(statusLabel)}</span></div><div class="operator-route"><span class="operator-route-dot pickup"></span><div><small>PICKUP</small><strong>${escapeHTML(job.from)}</strong></div><span class="operator-route-line"></span><span class="operator-route-dot dropoff"></span><div><small>DROPOFF</small><strong>${escapeHTML(job.to)}</strong></div></div><div class="operator-job-meta"><span>${escapeHTML(job.time)}</span><span>${escapeHTML(job.distance)}</span><span>${escapeHTML(job.priority)}</span>${vehicleLabel ? `<span>${escapeHTML(vehicleLabel)}</span>` : ''}</div></button>`;
}

async function openOperatorJob(id) {
  const response = await fetchJson(`/api/operator/jobs/${encodeURIComponent(id)}`);
  const payload = await response.json();
  if (!response.ok) return showToast(payload.error || 'Job unavailable');
  const job = payload.job;
  const nextStatus = { assigned: 'en_route', en_route: 'arrived', arrived: 'picked_up', picked_up: 'delivered' }[job.status];
  main.innerHTML = `<div class="operator-shell operator-detail-shell"><header class="operator-topbar"><button class="operator-back" id="operatorBack" type="button">←</button><div><p class="eyebrow">JOB DETAIL</p><h1>${escapeHTML(job.id)}</h1><p>${escapeHTML(job.priority)} · ${escapeHTML(job.time)}</p></div><button class="operator-icon-button" id="operatorSignOut" type="button" aria-label="Sign out">↪</button></header><section class="operator-detail-card"><span class="operator-status ${job.status}">${escapeHTML(job.status.replace(/_/g, ' '))}</span><div class="operator-detail-route"><div><small>PICKUP</small><strong>${escapeHTML(job.from)}</strong></div><div class="operator-detail-connector"></div><div><small>DROPOFF</small><strong>${escapeHTML(job.to)}</strong></div></div><div class="operator-facts"><div><span>DISTANCE</span><strong>${escapeHTML(job.distance)}</strong></div><div><span>FARE</span><strong>${escapeHTML(job.price)}</strong></div><div><span>DRIVER</span><strong>${escapeHTML(job.driver || 'Assigned to you')}</strong></div></div></section><section class="operator-action-card"><p class="eyebrow">JOB PROGRESS</p><h2>Update delivery status</h2><p class="operator-muted">Status changes are sequential and recorded for dispatch.</p>${nextStatus ? `<button class="operator-primary" id="operatorAdvance" type="button">Mark ${nextStatus.replace(/_/g, ' ')} <span>→</span></button>` : '<div class="operator-complete">Delivery complete</div>'}</section><section class="operator-action-card"><p class="eyebrow">PROOF OF DELIVERY</p><h2>Scan or upload document</h2><p class="operator-muted">Capture a signed document or delivery photo. JPG, PNG, and PDF up to 3 MB.</p><input class="operator-file-input" id="operatorProofFile" type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" /><div id="operatorProofList">${payload.proof.length ? payload.proof.map((proof) => `<div class="operator-proof-row"><span>✓</span><strong>${escapeHTML(proof.fileName)}</strong><small>${Math.round(proof.byteSize / 1024)} KB</small></div>`).join('') : '<p class="operator-muted">No proof uploaded yet.</p>'}</div></section></div>`;
  document.getElementById('operatorBack')?.addEventListener('click', renderOperatorPortal);
  document.getElementById('operatorSignOut')?.addEventListener('click', signOutToDispatcher);
  document.getElementById('operatorAdvance')?.addEventListener('click', () => advanceOperatorStatus(job.id, nextStatus));
  document.getElementById('operatorProofFile')?.addEventListener('change', (event) => uploadOperatorProof(job.id, event.target.files[0]));
}

async function advanceOperatorStatus(id, status) {
  const response = await fetchJson(`/api/operator/jobs/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Could not update status');
  showToast(result.message);
  openOperatorJob(id);
}

async function uploadOperatorProof(jobId, file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) return showToast('Proof document must be smaller than 3 MB');
  const reader = new FileReader();
  reader.onload = async () => {
    const response = await fetchJson(`/api/operator/jobs/${encodeURIComponent(jobId)}/proof`, { method: 'POST', body: JSON.stringify({ fileName: file.name, mimeType: file.type, data: reader.result }) });
    const result = await response.json();
    if (!response.ok) return showToast(result.error || 'Could not upload proof');
    showToast(result.message);
    openOperatorJob(jobId);
  };
  reader.readAsDataURL(file);
}

function renderCustomerSettings() {
  if (!getAuthToken()) {
    renderCustomerSettingsLocal();
    const banner = document.createElement('div');
    banner.className = 'customer-guest-banner';
    banner.textContent = 'Saved here stays in this browser. Sign in to keep your profile, places, and receipts on your account.';
    const panel = main?.querySelector('.customer-settings-panel');
    if (panel) panel.prepend(banner);
    return;
  }
  renderCustomerAccountPortal();
}

let customerAccountTab = 'profile';
let customerAccountCache = null;

async function renderCustomerAccountPortal(tab) {
  if (tab) customerAccountTab = tab;
  if (!main) return;
  setAppMode('customer');
  if (!customerAccountCache) {
    main.innerHTML = `<div class="customer-shell customer-panel-shell"><button type="button" class="outline-button" id="customerAccountBack">← Back home</button><section class="panel customer-settings-panel"><div class="schedule-loading">Loading your account...</div></section></div>`;
    document.getElementById('customerAccountBack')?.addEventListener('click', renderCustomerHome);
    try {
      const [meRes, addrRes, recRes] = await Promise.all([
        fetchJson('/api/customer/me'),
        fetchJson('/api/customer/addresses'),
        fetchJson('/api/customer/receipts')
      ]);
      const [meData, addrData, recData] = await Promise.all([meRes.json(), addrRes.json(), recRes.json()]);
      if (!meRes.ok) throw new Error(meData.error || 'Could not load your profile.');
      customerAccountCache = {
        profile: meData.profile || {},
        addresses: addrData.addresses || [],
        receipts: recData.receipts || []
      };
    } catch (error) {
      main.innerHTML = `<div class="customer-shell customer-panel-shell"><button type="button" class="outline-button" id="customerAccountBack">← Back home</button><section class="panel customer-settings-panel"><p class="form-error" role="alert">${escapeHTML(error.message || 'Could not load your account.')}</p></section></div>`;
      document.getElementById('customerAccountBack')?.addEventListener('click', renderCustomerHome);
      return;
    }
  }
  renderCustomerAccountTab();
}

function renderCustomerAccountTab() {
  const { profile, addresses, receipts } = customerAccountCache;
  const intl = customerIntl(profile);
  const tabs = [['profile', 'Profile & preferences'], ['places', 'Saved places'], ['receipts', 'Receipts']];
  const tabButtons = tabs.map(([key, label]) => `<button type="button" class="account-tab${customerAccountTab === key ? ' account-tab-active' : ''}" data-tab="${key}">${escapeHTML(label)}</button>`).join('');
  let tabBody = '';
  if (customerAccountTab === 'profile') tabBody = customerProfileTabHTML(profileSprout(profile));
  if (customerAccountTab === 'places') tabBody = customerPlacesTabHTML(addresses || []);
  if (customerAccountTab === 'receipts') tabBody = customerReceiptsTabHTML(receipts || [], profile);
  main.innerHTML = `<div class="customer-shell customer-panel-shell"><div class="customer-back-row"><button type="button" class="outline-button" id="customerAccountBack">← Back home</button><button type="button" class="outline-button" id="customerAccountSignOut">Sign out</button></div><section class="panel customer-settings-panel customer-account-panel"><div class="account-tabs" role="tablist">${tabButtons}</div><div class="account-tab-body">${tabBody}</div></section></div>`;
  document.getElementById('customerAccountBack')?.addEventListener('click', renderCustomerHome);
  document.getElementById('customerAccountSignOut')?.addEventListener('click', signOutToCustomer);
  main.querySelectorAll('.account-tab').forEach((button) => {
    button.addEventListener('click', () => renderCustomerAccountPortal(button.dataset.tab));
  });
  wireCustomerAccountTab(customerAccountTab);
}

function profileSprout(profile) {
  return {
    name: profile.name || '',
    email: profile.email || '',
    phone: profile.phone || '',
    vehicleType: profile.vehicleType || 'car',
    passengers: profile.passengers || '2',
    notifyEmail: profile.notifyEmail === undefined ? 1 : Number(profile.notifyEmail),
    notifySms: profile.notifySms === undefined ? 0 : Number(profile.notifySms),
    notifyInapp: profile.notifyInapp === undefined ? 1 : Number(profile.notifyInapp),
    country: profile.country || '',
    locale: profile.locale || 'en-US',
    currency: profile.currency || 'USD',
    timezone: profile.timezone || 'UTC'
  };
}

function customerIntl(profile) {
  const preferredLocale = (profile && profile.locale) || (navigator.language) || 'en-US';
  const currency = (profile && profile.currency) || 'USD';
  const timezone = (profile && profile.timezone) || 'UTC';
  const moneyFormatter = new Intl.NumberFormat(preferredLocale, { style: 'currency', currency, maximumFractionDigits: 0 });
  const dateFormatter = new Intl.DateTimeFormat(preferredLocale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone });
  return { locale: preferredLocale, currency, timezone, money: (value) => moneyFormatter.format(Number(value) || 0), date: (iso) => { try { return dateFormatter.format(new Date(iso)); } catch (error) { return String(iso || ''); } } };
}

const CUSTOMER_COUNTRIES = [['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['MX', 'Mexico'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['IE', 'Ireland'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['SE', 'Sweden'], ['CH', 'Switzerland'], ['AE', 'United Arab Emirates']];

const CUSTOMER_CURRENCIES = ['USD', 'GBP', 'CAD', 'MXN', 'AUD', 'NZD', 'EUR', 'CHF', 'AED'];

const CUSTOMER_LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-NZ', 'en-IE', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'sv-SE', 'fr-CH', 'de-CH'];

const CUSTOMER_TIMEZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Zurich', 'Asia/Dubai'];

function customerOptions(list, selected) {
  return list.map(([value, label]) => `<option value="${escapeHTML(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHTML(label)}</option>`).join('');
}

function customerProfileTabHTML(p) {
  return `<div class="view-header account-view-header"><div><p class="eyebrow">CUSTOMER PROFILE</p><h2>Profile &amp; preferences</h2><p class="view-subtitle">These details are reused on your quotes, saved places, and receipts.</p></div></div><form id="customerAccountProfileForm" class="customer-settings-form"><div class="customer-settings-grid"><label>Full name<input name="name" value="${escapeHTML(p.name)}" placeholder="Maria Lopez" required /></label><label>Email<input name="email" type="email" value="${escapeHTML(p.email)}" placeholder="maria@company.com" required /></label><label>Phone<input name="phone" type="tel" value="${escapeHTML(p.phone)}" placeholder="(415) 555-0191" /></label><label>Country<select name="country">${customerOptions(CUSTOMER_COUNTRIES, p.country)}</select></label><label>Language<select name="locale">${customerOptions(CUSTOMER_LOCALES.map((l) => [l, l]), p.locale)}</select></label><label>Currency<select name="currency">${CUSTOMER_CURRENCIES.map((c) => `<option value="${c}"${p.currency === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label><label>Time zone<select name="timezone">${CUSTOMER_TIMEZONES.map((tz) => `<option value="${escapeHTML(tz)}"${p.timezone === tz ? ' selected' : ''}>${escapeHTML(tz)}</option>`).join('')}</select></label><label>Preferred vehicle<select name="vehicleType"><option value="car"${p.vehicleType === 'car' ? ' selected' : ''}>Car</option><option value="suv"${p.vehicleType === 'suv' ? ' selected' : ''}>SUV</option><option value="van"${p.vehicleType === 'van' ? ' selected' : ''}>Van</option><option value="luxury"${p.vehicleType === 'luxury' ? ' selected' : ''}>Luxury</option></select></label><label>Passengers<input name="passengers" type="number" min="1" max="12" value="${escapeHTML(p.passengers)}" required /></label></div><fieldset class="customer-preferences"><legend>Notifications</legend><label class="customer-checkbox"><input name="notifyEmail" type="checkbox" ${p.notifyEmail ? 'checked' : ''} /> Email updates</label><label class="customer-checkbox"><input name="notifySms" type="checkbox" ${p.notifySms ? 'checked' : ''} /> SMS / text updates</label><label class="customer-checkbox"><input name="notifyInapp" type="checkbox" ${p.notifyInapp ? 'checked' : ''} /> In-app updates</label></fieldset><p class="form-error" id="customerAccountProfileError" role="alert"></p><div class="modal-actions"><button type="button" class="outline-button" id="customerAccountProfileCancel">Back home</button><button type="submit" class="dispatch-button">Save preferences</button></div></form><p class="customer-account-note">Profile, saved places, and receipts are saved to your account and available on any device.</p>`;
}

function customerPlacesTabHTML(addresses) {
  const cards = addresses.length ? addresses.map((address) => ` <div class="saved-place-card"><div class="saved-place-top"><div><strong>${escapeHTML(address.label || 'Saved place')}</strong>${Number(address.isDefault) ? '<span class="saved-place-default">Default</span>' : ''}</div><div class="saved-place-actions"><button type="button" class="small-filter" data-edit-address="${escapeHTML(address.id)}">Edit</button>${Number(address.isDefault) ? '' : `<button type="button" class="small-filter" data-default-address="${escapeHTML(address.id)}">Set default</button>`}<button type="button" class="small-filter danger-link" data-delete-address="${escapeHTML(address.id)}">Delete</button></div></div><p>${escapeHTML([address.lineOne, address.lineTwo, address.city].filter(Boolean).join(', '))}</p>${address.postalCode || address.country ? `<p class="saved-place-meta">${escapeHTML([address.postalCode, address.country].filter(Boolean).join(' · '))}</p>` : ''}</div>`).join('') : '<p class="empty-note">No saved places yet. Add a spot you use often to book faster.</p>';
  return `<div class="view-header account-view-header"><div><p class="eyebrow">ADDRESS BOOK</p><h2>Saved places</h2><p class="view-subtitle">Trade-offs: home, office, airport gates — pick a saved place when booking.</p></div><button type="button" class="dispatch-button" id="customerAddAddress">+ Add place</button></div><div class="saved-places-list">${cards}</div><div id="customerAddressEditor" class="address-editor" hidden></div>`;
}

function customerReceiptsTabHTML(receipts, profile) {
  if (!receipts.length) return `<div class="view-header account-view-header"><div><p class="eyebrow">CUSTOMER DOCUMENTS</p><h2>Receipts</h2><p class="view-subtitle">A voucher and invoice for every quote and booking on your address.</p></div></div><p class="empty-note">No receipts yet. Send a booking request or a quote to see them here.</p>`;
  const intl = customerIntl(profile);
  const rows = receipts.map((receipt) => `<button type="button" class="receipt-row" data-receipt="${escapeHTML(receipt.id)}"><div><strong>${escapeHTML(receipt.label || receipt.id)}</strong><small>${escapeHTML(intl.date(receipt.issuedAt))} · ${escapeHTML(String(receipt.kind || '').toUpperCase() === 'BOOKING' ? 'Booking' : 'Quote')}</small></div><div class="receipt-amounts"><span class="receipt-status ${escapeHTML(String(receipt.status || 'draft').toLowerCase())}">${escapeHTML(receipt.status || 'draft')}</span><strong>${escapeHTML(intl.money(receipt.total))}</strong></div></button>`).join('');
  return `<div class="view-header account-view-header"><div><p class="eyebrow">CUSTOMER DOCUMENTS</p><h2>Receipts</h2><p class="view-subtitle">A voucher and invoice for every quote and booking on your address.</p></div></div><div class="receipts-list">${rows}</div>`;
}

function wireCustomerAccountTab(tab) {
  if (tab === 'places') {
    document.getElementById('customerAddAddress')?.addEventListener('click', () => openCustomerAddressEditor());
    document.querySelectorAll('[data-edit-address]').forEach((button) => button.addEventListener('click', () => openCustomerAddressEditor(button.dataset.editAddress)));
    document.querySelectorAll('[data-default-address]').forEach((button) => button.addEventListener('click', () => setCustomerDefaultAddress(button.dataset.defaultAddress)));
    document.querySelectorAll('[data-delete-address]').forEach((button) => button.addEventListener('click', () => deleteCustomerAddress(button.dataset.deleteAddress)));
    return;
  }
  if (tab === 'receipts') {
    document.querySelectorAll('[data-receipt]').forEach((button) => button.addEventListener('click', () => openCustomerReceipt(button.dataset.receipt)));
    return;
  }
  const form = document.getElementById('customerAccountProfileForm');
  document.getElementById('customerAccountProfileCancel')?.addEventListener('click', renderCustomerHome);
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      email: String(formData.get('email') || '').trim().toLowerCase(),
      phone: String(formData.get('phone') || '').trim(),
      country: String(formData.get('country') || '').trim(),
      locale: String(formData.get('locale') || '').trim(),
      currency: String(formData.get('currency') || '').trim(),
      timezone: String(formData.get('timezone') || '').trim(),
      vehicleType: String(formData.get('vehicleType') || 'car').trim(),
      passengers: String(formData.get('passengers') || '2').trim(),
      notifyEmail: formData.get('notifyEmail') ? 1 : 0,
      notifySms: formData.get('notifySms') ? 1 : 0,
      notifyInapp: formData.get('notifyInapp') ? 1 : 0
    };
    const errorBox = document.getElementById('customerAccountProfileError');
    try {
      const response = await fetchJson('/api/customer/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save your preferences');
      customerAccountCache = null;
      showToast('Preferences saved');
      renderCustomerAccountPortal('profile');
    } catch (error) {
      if (errorBox) errorBox.textContent = error.message;
    }
  });
}

function openCustomerAddressEditor(id) {
  const editor = document.getElementById('customerAddressEditor');
  if (!editor) return;
  const existing = (customerAccountCache.addresses || []).find((address) => String(address.id) === String(id));
  const p = profileSprout(customerAccountCache.profile || {});
  editor.hidden = false;
  editor.innerHTML = `<form id="customerAddressForm" class="customer-settings-form address-editor-form"><h3>${existing ? 'Edit saved place' : 'Add a saved place'}</h3><div class="customer-settings-grid"><label>Label<input name="label" value="${escapeHTML(existing ? existing.label : '')}" placeholder="Home, Office, Airport" required maxlength="40" /></label><label>Address line 1<input name="lineOne" value="${escapeHTML(existing ? existing.lineOne : '')}" placeholder="1234 Market St" required maxlength="120" /></label><label>Address line 2<input name="lineTwo" value="${escapeHTML(existing ? existing.lineTwo : '')}" placeholder="Apt, floor, building" maxlength="120" /></label><label>City<input name="city" value="${escapeHTML(existing ? existing.city : '')}" placeholder="San Francisco" maxlength="80" /></label><label>State / Region<input name="region" value="${escapeHTML(existing ? existing.region : '')}" placeholder="CA" maxlength="80" /></label><label>Postal code<input name="postalCode" value="${escapeHTML(existing ? existing.postalCode : '')}" placeholder="94103" maxlength="20" /></label><label>Country<select name="country">${customerOptions(CUSTOMER_COUNTRIES, existing ? existing.country : p.country)}</select></label><label>Phone for this place<input name="phone" value="${escapeHTML(existing ? existing.phone : '')}" placeholder="Optional" maxlength="30" /></label></div><label class="customer-checkbox"><input name="isDefault" type="checkbox" ${existing && Number(existing.isDefault) ? 'checked' : ''} /> Make this my default place</label><p class="form-error" id="customerAddressFormError" role="alert"></p><div class="modal-actions"><button type="button" class="outline-button" id="customerAddressCancel">Cancel</button><button type="submit" class="dispatch-button">${existing ? 'Save changes' : 'Add place'}</button></div></form>`;
  document.getElementById('customerAddressCancel')?.addEventListener('click', () => { editor.hidden = true; editor.innerHTML = ''; });
  document.getElementById('customerAddressForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      label: String(formData.get('label') || '').trim(),
      lineOne: String(formData.get('lineOne') || '').trim(),
      lineTwo: String(formData.get('lineTwo') || '').trim(),
      city: String(formData.get('city') || '').trim(),
      region: String(formData.get('region') || '').trim(),
      postalCode: String(formData.get('postalCode') || '').trim(),
      country: String(formData.get('country') || '').trim(),
      phone: String(formData.get('phone') || '').trim(),
      isDefault: formData.get('isDefault') ? true : false
    };
    const errorBox = document.getElementById('customerAddressFormError');
    try {
      const response = await fetchJson(existing ? `/api/customer/addresses/${encodeURIComponent(existing.id)}` : '/api/customer/addresses', {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save this place');
      customerAccountCache = null;
      showToast(existing ? 'Saved place updated' : 'Saved place added');
      renderCustomerAccountPortal('places');
    } catch (error) {
      if (errorBox) errorBox.textContent = error.message;
    }
  });
}

async function setCustomerDefaultAddress(id) {
  try {
    const response = await fetchJson(`/api/customer/addresses/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isDefault: true }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update default place');
    customerAccountCache = null;
    showToast('Default place updated');
    renderCustomerAccountPortal('places');
  } catch (error) {
    showToast(error.message || 'Could not update default place');
  }
}

async function deleteCustomerAddress(id) {
  if (!window.confirm('Remove this saved place?')) return;
  try {
    const response = await fetchJson(`/api/customer/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not remove this place');
    customerAccountCache = null;
    showToast('Saved place removed');
    renderCustomerAccountPortal('places');
  } catch (error) {
    showToast(error.message || 'Could not remove this place');
  }
}

async function openCustomerReceipt(id) {
  try {
    const response = await fetchJson(`/api/customer/receipts/${encodeURIComponent(id)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Receipt not found');
    showReceiptModal(result.receipt);
  } catch (error) {
    showToast(error.message || 'Could not open receipt');
  }
}

function showReceiptModal(receipt) {
  const intl = customerIntl(customerAccountCache && customerAccountCache.profile);
  const detailRows = [
    ['Service', receipt.serviceType],
    ['Date', receipt.issuedAt ? intl.date(receipt.issuedAt) : ''],
    ['Status', receipt.status]
  ];
  if (receipt.kind === 'booking') {
    detailRows.push(['Drop-off', receipt.dropoffAddress]);
  } else {
    detailRows.push(['Drop-off', receipt.dropoffAddress || '']);
  }
  detailRows.push(['Vehicle', receipt.vehicleType]);
  detailRows.push(['Distance', receipt.miles ? `${receipt.miles} mi` : '']);
  detailRows.push(['Passengers', receipt.passengers ? String(receipt.passengers) : '']);
  const rowsMarkup = detailRows.filter(([, value]) => value).map(([label, value]) => `<tr><th>${escapeHTML(label)}</th><td>${escapeHTML(value)}</td></tr>`).join('');
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `<div class="modal receipt-modal" role="dialog" aria-modal="true" aria-label="Receipt ${escapeHTML(receipt.id)}"><div class="receipt-print-area"><header class="receipt-head"><div><p class="eyebrow">RZ DISPATCH</p><h2>${escapeHTML(receipt.kind === 'booking' ? 'Booking receipt' : 'Quote voucher')}</h2><p class="receipt-id">${escapeHTML(receipt.id)}</p></div><div class="receipt-amount"><span>Total</span><strong>${escapeHTML(intl.money(receipt.total))}</strong></div></header><table class="receipt-table"><tbody>${rowsMarkup}<tr class="receipt-total"><th>Total</th><td>${escapeHTML(intl.money(receipt.total))}</td></tr></tbody></table><footer class="receipt-foot"><p>Thank you for choosing RZ Dispatch.</p><button type="button" class="outline-button" id="receiptPrint">Print receipt</button></footer></div><div class="modal-actions"><button type="button" class="outline-button" id="receiptClose">Close</button></div></div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeReceiptModal(); });
  modal.querySelector('#receiptClose')?.addEventListener('click', closeReceiptModal);
  modal.querySelector('#receiptPrint')?.addEventListener('click', () => {
    const printArea = modal.querySelector('.receipt-print-area');
    const originalTitle = document.title;
    document.title = `Receipt ${receipt.id}`;
    window.print();
    document.title = originalTitle;
  });
}

function closeReceiptModal() {
  document.querySelectorAll('.receipt-modal').forEach((element) => element.closest('.modal-backdrop')?.remove());
}

function renderCustomerSettingsLocal() {
  const profile = getCustomerProfile();
  if (!main) return;
  setAppMode('customer');
  main.innerHTML = `<div class="customer-shell customer-panel-shell"><div class="customer-back-row"><button type="button" class="outline-button" id="customerSettingsBack">← Back home</button><button type="button" class="outline-button" id="customerSignOut">Sign out</button></div><section class="panel customer-settings-panel"><div class="view-header"><div><p class="eyebrow">CUSTOMER PROFILE</p><h1>My preferences</h1><p class="view-subtitle">Keep your booking details ready and choose how RZ Dispatch supports you.</p></div></div><form id="customerSettingsForm" class="customer-settings-form"><div class="customer-settings-grid"><label>Full name<input name="name" value="${escapeHTML(profile.name || '')}" placeholder="Maria Lopez" required /></label><label>Email<input name="email" type="email" value="${escapeHTML(profile.email || '')}" placeholder="maria@company.com" required /></label><label>Phone<input name="phone" type="tel" value="${escapeHTML(profile.phone || '')}" placeholder="(415) 555-0191" required /></label><label>Preferred vehicle<select name="vehicleType"><option value="car" ${profile.vehicleType === 'car' ? 'selected' : ''}>Car</option><option value="suv" ${profile.vehicleType === 'suv' ? 'selected' : ''}>SUV</option><option value="van" ${profile.vehicleType === 'van' ? 'selected' : ''}>Van</option><option value="luxury" ${profile.vehicleType === 'luxury' ? 'selected' : ''}>Luxury</option></select></label><label>Passengers<input name="passengers" type="number" min="1" max="12" value="${escapeHTML(profile.passengers || '2')}" required /></label></div><label class="customer-checkbox"><input name="notifications" type="checkbox" ${profile.notifications !== false ? 'checked' : ''} /> Send me booking and driver updates</label><p class="form-error" id="customerSettingsError" role="alert"></p><div class="modal-actions"><button type="button" class="outline-button" id="customerSettingsCancel">Cancel</button><button type="submit" class="dispatch-button">Save preferences <span>✓</span></button></div></form></section></div>`;
  document.getElementById('customerSettingsBack')?.addEventListener('click', renderCustomerHome);
  document.getElementById('customerSettingsCancel')?.addEventListener('click', renderCustomerHome);
  document.getElementById('customerSignOut')?.addEventListener('click', signOutToCustomer);
  document.getElementById('customerSettingsForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    saveCustomerProfile({ name: String(form.get('name') || '').trim(), email: String(form.get('email') || '').trim(), phone: String(form.get('phone') || '').trim(), vehicleType: String(form.get('vehicleType') || 'car'), passengers: String(form.get('passengers') || '2'), notifications: form.get('notifications') === 'on' });
    showToast('Preferences saved');
    renderCustomerHome();
  });
}

function renderCustomerContact(prefillEmail = '') {
  const profile = getCustomerProfile();
  if (!main) return;
  setAppMode('customer');
  const currentEmail = prefillEmail || profile.email || '';
  main.innerHTML = `
    <div class="customer-shell customer-panel-shell">
      <div class="customer-back-row">
        <button type="button" class="outline-button" id="contactBackHome">← Back home</button>
        <button type="button" class="outline-button" id="customerSignOut">Sign out</button>
      </div>
      <section class="panel data-panel customer-contact-panel">
        <div class="view-header">
          <div>
            <p class="eyebrow">CUSTOMER SUPPORT</p>
            <h1>Message the team</h1>
            <p class="view-subtitle">Talk to our dispatchers about a booking, pickup, or anything else. Use the same email for every message and the conversation stays linked.</p>
          </div>
        </div>
        <form id="customerContactForm" class="customer-contact-form">
          <div class="customer-contact-grid">
            <label>Your name<input name="name" value="${escapeHTML(profile.name || '')}" placeholder="Maria Lopez" autocomplete="name" /></label>
            <label>Email<input name="email" type="email" value="${escapeHTML(currentEmail)}" placeholder="maria@company.com" autocomplete="email" required /></label>
          </div>
          <label>Subject<input name="subject" placeholder="Question about my booking" maxlength="160" required /></label>
          <label>Message<textarea name="body" rows="4" maxlength="1000" placeholder="How can we help?" required></textarea></label>
          <p class="form-error" id="customerContactError" role="alert"></p>
          <div class="modal-actions"><button class="dispatch-button" type="submit">Send message <span>→</span></button></div>
        </form>
      </section>
      <section class="panel data-panel customer-messages-panel">
        <div class="panel-heading"><div><p class="eyebrow">YOUR CONVERSATIONS</p><h2>Recent messages</h2></div></div>
        <div class="customer-thread-search-row">
          <label>Show messages for this email<input id="threadEmail" type="email" value="${escapeHTML(currentEmail)}" placeholder="maria@company.com" /></label>
          <button class="dispatch-button thread-load" id="loadThread" type="button">Load my messages</button>
        </div>
        <div id="customerThread"><div class="empty-state"><strong>No messages loaded yet</strong><p>Send a message above or load a conversation with your email.</p></div></div>
      </section>
    </div>
  `;

  document.getElementById('contactBackHome')?.addEventListener('click', renderCustomerHome);
  document.getElementById('customerSignOut')?.addEventListener('click', signOutToCustomer);
  document.getElementById('loadThread')?.addEventListener('click', () => {
    const threadEmail = String(document.getElementById('threadEmail')?.value || '').trim().toLowerCase();
    if (!threadEmail) return showToast('Enter your email address first');
    loadCustomerThread(threadEmail);
  });

  const contactForm = document.getElementById('customerContactForm');
  const errorBox = document.getElementById('customerContactError');
  contactForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(contactForm);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      email: String(formData.get('email') || '').trim().toLowerCase(),
      subject: String(formData.get('subject') || '').trim(),
      body: String(formData.get('body') || '').trim()
    };
    try {
      const response = await fetch(apiUrl('/api/customer/contact'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not send your message');
      if (errorBox) errorBox.textContent = '';
      contactForm.reset();
      contactForm.querySelector('[name="name"]').value = payload.name;
      contactForm.querySelector('[name="email"]').value = payload.email;
      saveCustomerProfile({ ...getCustomerProfile(), name: payload.name, email: payload.email });
      rtSetupSession();
      showToast('Message sent to the dispatch team');
      const threadInput = document.getElementById('threadEmail');
      if (threadInput) threadInput.value = payload.email;
      await loadCustomerThread(payload.email);
    } catch (error) {
      if (errorBox) errorBox.textContent = error.message;
    }
  });

  if (currentEmail) loadCustomerThread(currentEmail);
}

async function loadCustomerThread(email) {
  const container = document.getElementById('customerThread');
  if (!container) return;
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return;
  rtActiveThreadEmail = normalized;
  container.innerHTML = '<div class="schedule-loading">Loading messages...</div>';
  try {
    const response = await fetch(apiUrl(`/api/customer/messages?email=${encodeURIComponent(normalized)}`));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load your messages');
    if (!payload.messages.length) {
      container.innerHTML = '<div class="empty-state"><strong>No messages yet</strong><p>Send a message above and the conversation will appear here.</p></div>';
      return;
    }
    const lastReplySubject = [...payload.messages].reduceRight((acc, m) => acc || (m.type !== 'customer' ? m.subject : ''), '');
    container.innerHTML = `
      <div class="customer-thread">${payload.messages.map(renderCustomerThreadMessage).join('')}</div>
      <form id="customerReplyForm" class="customer-thread-reply">
        <p class="eyebrow">REPLY</p>
        <input name="subject" value="${escapeHTML(lastReplySubject ? `Re: ${lastReplySubject.replace(/^Re:\s*/i, '')}` : 'Reply to the team')}" maxlength="160" placeholder="Subject" aria-label="Subject" />
        <textarea name="body" rows="3" maxlength="1000" placeholder="Type your reply..." required></textarea>
        <p class="form-error" id="customerReplyError" role="alert"></p>
        <button class="dispatch-button" type="submit">Send reply <span>→</span></button>
      </form>
    `;
    document.getElementById('customerReplyForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const replyError = document.getElementById('customerReplyError');
      const profileName = getCustomerProfile().name || 'Valued customer';
      try {
        const response = await fetch(apiUrl('/api/customer/contact'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: profileName, email: normalized, subject: String(formData.get('subject') || '').trim(), body: String(formData.get('body') || '').trim() }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not send your reply');
        if (replyError) replyError.textContent = '';
        await loadCustomerThread(normalized);
      } catch (error) {
        if (replyError) replyError.textContent = error.message;
      }
    });
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><strong>Could not load messages</strong><p>${escapeHTML(error.message)}</p></div>`;
  }
}

function renderCustomerThreadMessage(message) {
  const fromDispatch = message.type !== 'customer';
  return `<div class="customer-thread-message ${fromDispatch ? 'is-in' : 'is-out'}">
    <div class="customer-thread-meta"><strong>${escapeHTML(fromDispatch ? 'RZ Dispatch team' : (message.sender || 'You'))}</strong>${message.sender && fromDispatch ? `<em>${escapeHTML(message.sender)}</em>` : ''}<span>${formatFullMessageTime(message.createdAt)}</span></div>
    <div class="customer-thread-subject">${escapeHTML(message.subject)}</div>
    <div class="customer-thread-body">${escapeHTML(message.body)}</div>
  </div>`;
}

function renderCustomerPortal(prefill = null) {
  if (!main) return;
  main.innerHTML = `
    <div class="customer-shell customer-panel-shell">
      <div class="customer-back-row">
        <button type="button" class="outline-button" id="customerBackHome">← Back home</button>
        <button type="button" class="outline-button" id="customerSignOut">Sign out</button>
      </div>
      <section class="panel data-panel customer-tracking-panel">
        <div class="view-header" style="margin-bottom:18px;">
          <div>
            <p class="eyebrow">CUSTOMER PORTAL</p>
            <h1>Track your order</h1>
            <p class="view-subtitle">Look up your quote or booking using your order ID and email.</p>
          </div>
        </div>
        <form id="customerPortalForm" class="customer-tracking-form">
          <label>Order ID
            <input name="orderId" type="text" placeholder="Q-AB12CD34 or BK-A1B2C3D4" required autocomplete="off" />
          </label>
          <label>Email
            <input name="email" type="email" placeholder="customer@example.com" required autocomplete="off" />
          </label>
          <button class="dispatch-button" type="submit">Track order</button>
          <p id="customerPortalError" class="form-error" role="alert"></p>
        </form>
        <div id="customerPortalResult" class="booking-grid" style="margin-top:18px;"></div>
      </section>
    </div>
  `;

  document.getElementById('customerBackHome')?.addEventListener('click', renderCustomerHome);
  document.getElementById('customerSignOut')?.addEventListener('click', signOutToCustomer);

  document.getElementById('customerPortalForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const orderId = String(new FormData(form).get('orderId') || '').trim();
    const email = String(new FormData(form).get('email') || '').trim();
    const error = document.getElementById('customerPortalError');
    const resultBox = document.getElementById('customerPortalResult');
    if (!orderId || !email) {
      if (error) error.textContent = 'Enter both an order ID and email.';
      return;
    }
    rtTrackedBooking = { orderId, email };

    try {
      const response = await fetch(apiUrl(`/api/customer/order?orderId=${encodeURIComponent(orderId)}&email=${encodeURIComponent(email)}`));
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'We could not find that order.');
      if (error) error.textContent = '';
      saveCustomerProfile({ ...getCustomerProfile(), email });
      rtSetupSession();
      resultBox.innerHTML = renderCustomerOrderCard(payload) + `<p class="customer-contact-link"><button class="text-button" id="trackContact" type="button">Need help? Message the dispatch team</button></p>`;
      document.getElementById('trackContact')?.addEventListener('click', () => renderCustomerContact(email));
    } catch (err) {
      if (error) error.textContent = err.message;
      resultBox.innerHTML = '';
    }
  });

  if (prefill && prefill.orderId) {
    const form = document.getElementById('customerPortalForm');
    if (form) {
      const orderField = form.querySelector('[name="orderId"]');
      const emailField = form.querySelector('[name="email"]');
      if (orderField) orderField.value = prefill.orderId;
      if (emailField) emailField.value = prefill.email || '';
      form.requestSubmit();
    }
  }
}

function renderCustomerOrderCard(payload) {
  const statusLabel = capitalize(payload.status);
  const hasTotal = Number(payload.quoteTotal) > 0;
  const tracking = payload.tracking || {};
  const progress = Math.max(0, Math.min(100, Number(tracking.progress) || 0));
  const driver = payload.driver || null;
  const vehicle = payload.vehicle || null;
  return `
    <article class="booking-card">
      <div class="booking-card-top">
        <div>
          <strong>${escapeHTML(payload.customerName)}</strong>
          <small>${escapeHTML(String(payload.serviceType || '').replace(/-/g, ' ').toUpperCase())} · ${escapeHTML(payload.id)}</small>
        </div>
        <span class="booking-badge">${escapeHTML(statusLabel)}</span>
      </div>
      <div class="booking-meta">
        <div><span>Pickup</span><strong>${escapeHTML(payload.pickupAddress || '—')}</strong></div>
        <div><span>Dropoff</span><strong>${escapeHTML(payload.dropoffAddress || '—')}</strong></div>
        <div><span>${hasTotal ? 'Total' : 'Status'}</span><strong>${hasTotal ? `$${Number(payload.quoteTotal).toFixed(2)}` : escapeHTML(statusLabel)}</strong></div>
      </div>
      <div class="booking-meta">
        <div><span>Date</span><strong>${escapeHTML(formatOrderDate(payload.serviceDate))}</strong></div>
        <div><span>Vehicle type</span><strong>${escapeHTML(capitalize(payload.vehicleType || 'car'))}</strong></div>
        <div><span>Passengers</span><strong>${escapeHTML(String(payload.passengers || 1))}</strong></div>
      </div>
      <div class="quote-estimate">
        <div class="quote-lines">
          <div><strong>Tracking status:</strong> ${escapeHTML(tracking.step || 'In review')}</div>
          <div>${escapeHTML(tracking.message || '')}</div>
        </div>
        <div class="quote-total">
          <span>Progress</span>
          <span>${progress}%</span>
        </div>
      </div>
      <div class="tracking-progress" style="--progress:${progress}%"></div>
      ${tracking.etaLabel ? `<div class="tracking-eta"><span>ETA</span><strong>${escapeHTML(tracking.etaLabel)}</strong></div>` : ''}
      ${driver ? `<div class="tracking-driver"><div class="tracking-driver-copy"><span class="eyebrow">YOUR DRIVER</span><strong>${escapeHTML(driver.name)}</strong>${driver.phone ? `<a href="tel:${escapeHTML(driver.phone)}">${escapeHTML(driver.phone)}</a>` : ''}</div>${vehicle ? `<div class="tracking-vehicle"><span class="eyebrow">VEHICLE</span><strong>${escapeHTML(vehicle.label)}</strong><small>${escapeHTML(vehicle.plate || '')}</small></div>` : ''}</div>` : ''}
      ${payload.notes ? `<p class="tracking-notes"><span>Notes:</span> ${escapeHTML(payload.notes)}</p>` : ''}
    </article>
  `;
}

function capitalize(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatOrderDate(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

async function renderServicePages() {
  main.innerHTML = '<div class="schedule-loading">Loading service configuration...</div>';
  try {
    const response = await fetchJson('/api/services');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Service configuration unavailable');
    const services = payload.services || [];
    main.innerHTML = `<div class="view-header"><div><p class="eyebrow">ADMIN CONFIGURATION</p><h1>Services and pricing</h1><p class="view-subtitle">Create service offerings, control availability, and manage the pricing rules used by quotes.</p></div><button class="dispatch-button" id="newServiceButton" type="button">+ New service</button></div><section class="service-admin-summary"><article class="panel"><strong>${services.length}</strong><span>configured services</span></article><article class="panel"><strong>${services.filter((service) => service.active).length}</strong><span>customer-visible</span></article><article class="panel"><strong>$${services.reduce((sum, service) => sum + service.basePrice, 0).toFixed(2)}</strong><span>base price portfolio</span></article></section><section class="panel service-admin-panel"><div class="panel-heading"><div><p class="eyebrow">CATALOG</p><h2>Service catalog</h2></div><button class="small-filter" id="refreshServices" type="button">Refresh</button></div><div class="service-admin-list">${services.length ? services.map((service) => `<div class="service-admin-row"><div class="service-admin-name"><span class="service-state ${service.active ? 'active' : ''}"></span><div><strong>${escapeHTML(service.name)}</strong><small>${escapeHTML(service.key)} · ${escapeHTML(service.description)}</small></div></div><div class="service-admin-prices"><span>Base <strong>$${service.basePrice.toFixed(2)}</strong></span><span>Per mile <strong>$${service.distanceRate.toFixed(2)}</strong></span><span>Hourly <strong>$${service.hourlyRate.toFixed(2)}</strong></span></div><span class="service-admin-status ${service.active ? 'is-active' : ''}">${service.active ? 'Active' : 'Hidden'}</span><div class="service-admin-actions"><button class="outline-button service-edit" data-service="${escapeHTML(service.key)}" type="button">Edit</button><button class="danger-button service-delete" data-service="${escapeHTML(service.key)}" type="button">Delete</button></div></div>`).join('') : '<div class="empty-state">No services configured.</div>'}</div></section><section class="panel service-editor" id="serviceEditor" hidden></section>`;
    document.getElementById('newServiceButton')?.addEventListener('click', () => renderServiceEditor());
    document.getElementById('refreshServices')?.addEventListener('click', renderServicePages);
    document.querySelectorAll('.service-edit').forEach((button) => button.addEventListener('click', () => renderServiceEditor(services.find((service) => service.key === button.dataset.service))));
    document.querySelectorAll('.service-delete').forEach((button) => button.addEventListener('click', () => deleteService(button.dataset.service)));
  } catch (error) {
    main.innerHTML = `<div class="empty-state"><strong>Services unavailable</strong><p>${escapeHTML(error.message)}</p><button class="outline-button" id="servicesRetry" type="button">Retry</button></div>`;
    document.getElementById('servicesRetry')?.addEventListener('click', renderServicePages);
  }
}

function renderServiceEditor(service = {}) {
  const editor = document.getElementById('serviceEditor');
  if (!editor) return;
  editor.hidden = false;
  const editing = Boolean(service.key);
  editor.innerHTML = `<div class="service-editor-header"><div><p class="eyebrow">${editing ? 'EDIT SERVICE' : 'NEW SERVICE'}</p><h2>${editing ? escapeHTML(service.name) : 'Create service'}</h2></div><button class="modal-close" id="cancelServiceEdit" type="button">&times;</button></div><form id="serviceForm" class="service-form"><label>Service key<input name="key" value="${escapeHTML(service.key || '')}" ${editing ? 'readonly' : ''} placeholder="corporate-shuttle" required /></label><label>Display name<input name="name" value="${escapeHTML(service.name || '')}" placeholder="Corporate shuttle" required /></label><label>Description<textarea name="description" rows="3" maxlength="300" required>${escapeHTML(service.description || '')}</textarea></label><div class="service-price-grid"><label>Base price<input name="basePrice" type="number" min="0" step="0.01" value="${service.basePrice ?? 0}" required /></label><label>Per-mile rate<input name="distanceRate" type="number" min="0" step="0.01" value="${service.distanceRate ?? 0}" required /></label><label>Hourly rate<input name="hourlyRate" type="number" min="0" step="0.01" value="${service.hourlyRate ?? 0}" required /></label></div><label class="service-active-toggle"><input name="active" type="checkbox" ${service.active !== false ? 'checked' : ''} /> Available to customers</label><p class="form-error" id="serviceFormError" role="alert"></p><div class="detail-actions"><button class="outline-button" id="cancelServiceButton" type="button">Cancel</button><button class="dispatch-button" type="submit">Save service <span>✓</span></button></div></form>`;
  document.getElementById('cancelServiceEdit')?.addEventListener('click', () => { editor.hidden = true; });
  document.getElementById('cancelServiceButton')?.addEventListener('click', () => { editor.hidden = true; });
  document.getElementById('serviceForm')?.addEventListener('submit', (event) => saveService(event, service.key));
  editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveService(event, originalKey = '') {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const data = Object.fromEntries(form.entries());
  data.active = form.get('active') === 'on';
  const method = originalKey ? 'PATCH' : 'POST';
  const endpoint = originalKey ? `/api/services/${encodeURIComponent(originalKey)}` : '/api/services';
  const error = document.getElementById('serviceFormError');
  try {
    const response = await fetchJson(endpoint, { method, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save service');
    showToast('Service configuration saved');
    await renderServicePages();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function deleteService(key) {
  if (!window.confirm(`Delete the ${key} service configuration?`)) return;
  const response = await fetchJson(`/api/services/${encodeURIComponent(key)}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Could not delete service');
  showToast('Service deleted');
  renderServicePages();
}

async function renderCoveragePage() {
  main.innerHTML = '<div class="schedule-loading">Loading coverage rules...</div>';
  try {
    const response = await fetchJson('/api/coverage/zones');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Coverage configuration unavailable');
    const zones = payload.zones || [];
    main.innerHTML = `<div class="view-header"><div><p class="eyebrow">OPERATIONS CONFIGURATION</p><h1>Coverage management</h1><p class="view-subtitle">Configure geofenced service regions, regional pricing, and fleet availability rules.</p></div><button class="dispatch-button" id="newZoneButton" type="button">+ Add region</button></div><section class="coverage-admin-summary"><article class="panel"><strong>${zones.length}</strong><span>configured regions</span></article><article class="panel"><strong>${zones.filter((zone) => zone.active).length}</strong><span>active regions</span></article><article class="panel"><strong>$${zones.reduce((sum, zone) => sum + zone.baseSurcharge, 0).toFixed(2)}</strong><span>base surcharge exposure</span></article></section><section class="panel coverage-admin-panel"><div class="panel-heading"><div><p class="eyebrow">GEOFENCE RULES</p><h2>Service zones</h2></div><button class="small-filter" id="refreshZones" type="button">Refresh</button></div><div class="zone-admin-list">${zones.length ? zones.map((zone) => `<div class="zone-admin-row"><div class="zone-admin-name"><span class="zone-state ${zone.active ? 'active' : ''}"></span><div><strong>${escapeHTML(zone.name)}</strong><small>${escapeHTML(zone.key)} · ${escapeHTML(zone.boundary)}</small></div></div><div class="zone-admin-prices"><span>Base <strong>+$${zone.baseSurcharge.toFixed(2)}</strong></span><span>Per mile <strong>+$${zone.distanceSurcharge.toFixed(2)}</strong></span></div><span class="zone-admin-status ${zone.active ? 'is-active' : ''}">${zone.active ? 'Active' : 'Inactive'}</span><div class="zone-admin-actions"><button class="outline-button zone-edit" data-zone="${escapeHTML(zone.key)}" type="button">Edit</button><button class="danger-button zone-delete" data-zone="${escapeHTML(zone.key)}" type="button">Delete</button></div></div>`).join('') : '<div class="empty-state">No service zones configured.</div>'}</div></section><section class="panel zone-editor" id="zoneEditor" hidden></section>`;
    document.getElementById('newZoneButton')?.addEventListener('click', () => renderZoneEditor());
    document.getElementById('refreshZones')?.addEventListener('click', renderCoveragePage);
    document.querySelectorAll('.zone-edit').forEach((button) => button.addEventListener('click', () => renderZoneEditor(zones.find((zone) => zone.key === button.dataset.zone))));
    document.querySelectorAll('.zone-delete').forEach((button) => button.addEventListener('click', () => deleteZone(button.dataset.zone)));
  } catch (error) {
    main.innerHTML = `<div class="empty-state"><strong>Coverage unavailable</strong><p>${escapeHTML(error.message)}</p><button class="outline-button" id="coverageRetry" type="button">Retry</button></div>`;
    document.getElementById('coverageRetry')?.addEventListener('click', renderCoveragePage);
  }
}

function renderZoneEditor(zone = {}) {
  const editor = document.getElementById('zoneEditor');
  if (!editor) return;
  editor.hidden = false;
  const editing = Boolean(zone.key);
  editor.innerHTML = `<div class="zone-editor-header"><div><p class="eyebrow">${editing ? 'EDIT GEOFENCE' : 'NEW GEOFENCE'}</p><h2>${editing ? escapeHTML(zone.name) : 'Create service region'}</h2></div><button class="modal-close" id="cancelZoneEdit" type="button">&times;</button></div><form id="zoneForm" class="zone-form"><label>Region key<input name="key" value="${escapeHTML(zone.key || '')}" ${editing ? 'readonly' : ''} placeholder="peninsula-east" required /></label><label>Region name<input name="name" value="${escapeHTML(zone.name || '')}" placeholder="Peninsula East" required /></label><label>Boundary / geofence coordinates<textarea name="boundary" rows="3" placeholder="lat,lng;lat,lng" required>${escapeHTML(zone.boundary || '')}</textarea><small>Use semicolon-separated latitude,longitude points or a polygon identifier.</small></label><div class="zone-price-grid"><label>Base surcharge<input name="baseSurcharge" type="number" min="0" step="0.01" value="${zone.baseSurcharge ?? 0}" required /></label><label>Per-mile surcharge<input name="distanceSurcharge" type="number" min="0" step="0.01" value="${zone.distanceSurcharge ?? 0}" required /></label></div><label class="zone-active-toggle"><input name="active" type="checkbox" ${zone.active !== false ? 'checked' : ''} /> Region is active for dispatch and quoting</label><p class="form-error" id="zoneFormError" role="alert"></p><div class="detail-actions"><button class="outline-button" id="cancelZoneButton" type="button">Cancel</button><button class="dispatch-button" type="submit">Save region <span>✓</span></button></div></form>`;
  document.getElementById('cancelZoneEdit')?.addEventListener('click', () => { editor.hidden = true; });
  document.getElementById('cancelZoneButton')?.addEventListener('click', () => { editor.hidden = true; });
  document.getElementById('zoneForm')?.addEventListener('submit', (event) => saveZone(event, zone.key));
  editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveZone(event, originalKey = '') {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const data = Object.fromEntries(form.entries());
  data.active = form.get('active') === 'on';
  const method = originalKey ? 'PATCH' : 'POST';
  const endpoint = originalKey ? `/api/coverage/zones/${encodeURIComponent(originalKey)}` : '/api/coverage/zones';
  const error = document.getElementById('zoneFormError');
  try {
    const response = await fetchJson(endpoint, { method, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save region');
    showToast('Coverage rules saved');
    await renderCoveragePage();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function deleteZone(key) {
  if (!window.confirm(`Delete the ${key} geofence?`)) return;
  const response = await fetchJson(`/api/coverage/zones/${encodeURIComponent(key)}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'Could not delete region');
  showToast('Region deleted');
  renderCoveragePage();
}

function renderQuoteEstimate(estimate) {
  if (!quoteEstimateSummary || !estimate) return;
  quoteEstimateSummary.innerHTML = `
    <div class="quote-lines">
      <div><strong>${escapeHTML(estimate.serviceType.replace(/-/g, ' '))}</strong> · ${escapeHTML(estimate.vehicleType)} · ${escapeHTML(String(estimate.miles))} miles</div>
      <div>Base: $${estimate.breakdown.base.toFixed(2)}</div>
      <div>Distance: $${estimate.breakdown.distanceRate.toFixed(2)}</div>
      <div>Passengers: $${estimate.breakdown.passengerSurcharge.toFixed(2)}</div>
      <div>Service fee: $${estimate.breakdown.serviceFee.toFixed(2)}</div>
      <div>Tax: $${estimate.breakdown.tax.toFixed(2)}</div>
    </div>
    <div class="quote-total"><span>Estimated total</span><span>$${estimate.total.toFixed(2)}</span></div>
  `;
}

function openQuoteModal() {
  if (!quoteModal) return;
  quoteModal.hidden = false;
  const profile = getCustomerProfile();
  const profileFields = {
    customerName: profile.name,
    email: profile.email,
    phone: profile.phone,
    vehicleType: profile.vehicleType,
    passengers: profile.passengers
  };
  Object.entries(profileFields).forEach(([name, value]) => {
    const field = document.querySelector(`#quoteForm [name="${name}"]`);
    if (field && value && !field.value) field.value = value;
  });
  const dateInput = document.querySelector('#quoteForm input[name="serviceDate"]');
  if (dateInput && !dateInput.value) {
    const nextDate = new Date(Date.now() + 86400000);
    dateInput.value = nextDate.toISOString().slice(0, 10);
  }
  const firstField = document.querySelector('#quoteForm input[name="customerName"]');
  if (firstField) firstField.focus();
}

function closeQuoteModal() {
  if (!quoteModal) return;
  quoteModal.hidden = true;
  if (quoteForm) quoteForm.reset();
  if (quoteError) quoteError.textContent = '';
  if (quoteEstimateSummary) quoteEstimateSummary.innerHTML = '';
}

async function estimateQuoteFromForm(event) {
  event.preventDefault();
  const form = quoteForm || document.getElementById('quoteForm');
  if (!form) return null;
  const payload = Object.fromEntries(new FormData(form).entries());
  const miles = Number(payload.miles || 0);
  const passengers = Number(payload.passengers || 1);
  const hours = Number(payload.hours || 1);

  try {
    const response = await fetchJson('/api/quotes/estimate', {
      method: 'POST',
      body: JSON.stringify({ ...payload, miles, passengers, hours })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to estimate quote');
    renderQuoteEstimate(result.estimate);
    return result.estimate;
  } catch (error) {
    if (quoteError) quoteError.textContent = error.message;
    return null;
  }
}

async function autoEstimateMiles() {
  const form = quoteForm || document.getElementById('quoteForm');
  if (!form) return;
  const from = String(form.querySelector('[name="pickupAddress"]')?.value || '').trim();
  const to = String(form.querySelector('[name="dropoffAddress"]')?.value || '').trim();
  const button = document.getElementById('autoMilesButton');
  if (!from || !to) { showToast('Add a pickup and dropoff address first'); return; }
  if (button) { button.disabled = true; button.textContent = 'Looking up…'; }
  try {
    const response = await fetchJson('/api/quotes/distance', { method: 'POST', body: JSON.stringify({ from, to }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Distance lookup failed');
    const milesInput = form.querySelector('[name="miles"]');
    if (milesInput) milesInput.value = Number(payload.miles);
    showToast(`Distance estimated at ${payload.miles} miles`);
    estimateQuoteFromForm(new Event('submit'));
  } catch (error) {
    showToast(error.message || 'Enter miles manually');
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Auto'; }
  }
}

async function submitBooking(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const miles = Number(payload.miles || 0);
  const passengers = Number(payload.passengers || 1);
  const hours = Number(payload.hours || 1);

  try {
    const response = await fetchJson('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ ...payload, miles, passengers, hours })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to create booking');
    closeQuoteModal();
    if (!getAuthToken()) {
      saveCustomerProfile({ name: String(payload.customerName || '').trim(), email: String(payload.email || '').trim(), phone: String(payload.phone || '').trim(), vehicleType: String(payload.vehicleType || 'car'), passengers: String(payload.passengers || '2'), notifications: true });
      renderBookingConfirmation(result.booking);
      return;
    }
    await requestOverview();
    renderView('bookings');
    showToast(`Booking ${result.booking.id} confirmed`);
  } catch (error) {
    if (quoteError) quoteError.textContent = error.message;
  }
}

function renderBookingConfirmation(booking) {
  setAppMode('customer');
  if (!main) return;
  const total = Number(booking.quoteTotal || booking.total || 0);
  main.innerHTML = `
    <div class="customer-shell customer-panel-shell">
      <div class="customer-back-row">
        <button type="button" class="outline-button" id="confirmationHome">← Back home</button>
      </div>
      <section class="panel data-panel customer-confirm-panel">
        <div class="customer-confirm-head">
          <span class="customer-confirm-check">✓</span>
          <p class="eyebrow">BOOKING RECEIVED</p>
          <h1>Your trip is confirmed.</h1>
          <p class="view-subtitle">We'll be in touch before pickup. Keep your order ID handy — you can use it any time to check your trip status.</p>
        </div>
        <div class="customer-confirm-grid">
          <div><span>Order ID</span><strong>${escapeHTML(booking.id)}</strong><small>Keep this safe for tracking.</small></div>
          <div><span>Service</span><strong>${escapeHTML(capitalize(booking.serviceType))}</strong></div>
          <div><span>Date</span><strong>${escapeHTML(formatOrderDate(booking.serviceDate))}</strong></div>
        </div>
        <div class="customer-confirm-route">
          <div class="route-stop"><span class="route-dot from"></span><div><small>PICKUP</small><strong>${escapeHTML(booking.pickupAddress || '—')}</strong></div></div>
          <div class="confirm-route-line"></div>
          <div class="route-stop"><span class="route-dot to"></span><div><small>DROPOFF</small><strong>${escapeHTML(booking.dropoffAddress || '—')}</strong></div></div>
        </div>
        <div class="customer-confirm-foot">
          <div><span>Vehicle</span><strong>${escapeHTML(capitalize(booking.vehicleType || 'car'))}</strong></div>
          <div><span>Passengers</span><strong>${escapeHTML(String(booking.passengers || 1))}</strong></div>
          <div><span>Total</span><strong>${total > 0 ? `$${total.toFixed(2)}` : 'Confirmed on request'}</strong></div>
        </div>
        ${booking.notes ? `<p class="tracking-notes"><span>Notes:</span> ${escapeHTML(booking.notes)}</p>` : ''}
        <div class="customer-confirm-actions">
          <button class="dispatch-button" id="confirmationTrack" type="button">Track this order <span>→</span></button>
          <button class="outline-button" id="confirmationBookAnother" type="button">Book another trip</button>
          <button class="outline-button" id="confirmationContact" type="button">Message the team</button>
        </div>
      </section>
    </div>
  `;
  document.getElementById('confirmationHome')?.addEventListener('click', renderCustomerHome);
  document.getElementById('confirmationBookAnother')?.addEventListener('click', () => { openQuoteModal(); });
  document.getElementById('confirmationContact')?.addEventListener('click', () => renderCustomerContact(booking.email));
  document.getElementById('confirmationTrack')?.addEventListener('click', () => { renderCustomerPortal({ orderId: booking.id, email: booking.email }); });
}

async function renderBookings() {
  let quotes = [];
  let bookings = [];

  try {
    const quotesResponse = await fetchJson('/api/quotes');
    const quotesPayload = await quotesResponse.json();
    if (quotesResponse.ok) quotes = Array.isArray(quotesPayload.quotes) ? quotesPayload.quotes : [];
  } catch (error) {
    quotes = [];
  }

  try {
    const bookingsResponse = await fetchJson('/api/bookings');
    const bookingsPayload = await bookingsResponse.json();
    if (bookingsResponse.ok) bookings = Array.isArray(bookingsPayload.bookings) ? bookingsPayload.bookings : [];
  } catch (error) {
    bookings = [];
  }

  main.innerHTML = `
    <div class="view-header">
      <div>
        <p class="eyebrow">BOOKINGS</p>
        <h1>Booking and quote engine</h1>
        <p class="view-subtitle">Track estimates, confirm reservations, and manage customer requests.</p>
      </div>
      <button class="outline-button" id="newQuoteButton" type="button">New quote</button>
    </div>
    <section class="booking-grid">
      <article class="panel data-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">BOOKINGS</p><h2>Confirmed reservations</h2></div>
          <button class="small-filter" id="refreshBookings">Refresh</button>
        </div>
        <div class="data-table">
          ${bookings.length ? bookings.map((booking) => `
            <div class="booking-card">
              <div class="booking-card-top">
                <div>
                  <strong>${escapeHTML(booking.customerName)}</strong>
                  <small>${escapeHTML(booking.serviceType.replace(/-/g, ' '))} · ${escapeHTML(booking.vehicleType)}</small>
                </div>
                <span class="booking-badge">${escapeHTML(booking.status)}</span>
              </div>
              <div class="booking-meta">
                <div><span>ID</span><strong>${escapeHTML(booking.id)}</strong></div>
                <div><span>Pickup</span><strong>${escapeHTML(booking.pickupAddress)}</strong></div>
                <div><span>Total</span><strong>$${Number(booking.quoteTotal || 0).toFixed(2)}</strong></div>
              </div>
              <div class="booking-actions">${booking.dispatchedJobId
                ? `<span class="booking-dispatched">Dispatched as ${escapeHTML(booking.dispatchedJobId)}</span>`
                : `<button class="dispatch-button booking-dispatch" data-booking="${escapeHTML(booking.id)}" type="button">Dispatch <span>→</span></button>`}</div>
            </div>
          `).join('') : '<div class="empty-list">No bookings have been created yet.</div>'}
        </div>
      </article>
      <article class="panel data-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">QUOTES</p><h2>Pending estimates</h2></div>
        </div>
        <div class="data-table">
          ${quotes.length ? quotes.map((quote) => `
            <div class="booking-card">
              <div class="booking-card-top">
                <div>
                  <strong>${escapeHTML(quote.customerName)}</strong>
                  <small>${escapeHTML(quote.serviceType.replace(/-/g, ' '))} · ${escapeHTML(quote.serviceDate)}</small>
                </div>
                <span class="booking-badge">${escapeHTML(quote.status)}</span>
              </div>
              <div class="booking-meta">
                <div><span>Route</span><strong>${escapeHTML(quote.pickupAddress)}</strong></div>
                <div><span>To</span><strong>${escapeHTML(quote.dropoffAddress)}</strong></div>
                <div><span>Estimate</span><strong>$${Number(quote.quoteTotal || 0).toFixed(2)}</strong></div>
              </div>
            </div>
          `).join('') : '<div class="empty-list">No quotes are waiting for approval.</div>'}
        </div>
      </article>
    </section>
  `;

  document.getElementById('newQuoteButton')?.addEventListener('click', openQuoteModal);
  document.getElementById('refreshBookings')?.addEventListener('click', () => renderBookings());
  document.querySelectorAll('.booking-dispatch').forEach((button) => button.addEventListener('click', async (event) => {
    const bookingId = event.currentTarget.dataset.booking;
    const original = event.currentTarget.innerHTML;
    event.currentTarget.innerHTML = 'Dispatching…';
    event.currentTarget.disabled = true;
    try {
      const response = await fetchJson(`/api/bookings/${encodeURIComponent(bookingId)}/dispatch`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to dispatch booking');
      showToast(`${bookingId} dispatched as ${payload.job.id}`);
      await requestOverview();
      await renderBookings();
    } catch (error) {
      event.currentTarget.innerHTML = original;
      event.currentTarget.disabled = false;
      showToast(error.message || 'Unable to dispatch booking');
    }
  }));
}

async function renderCRM() {
  main.innerHTML = '<div class="schedule-loading">Loading customer relationship management...</div>';
  try {
    const response = await fetchJson('/api/crm/customers');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'CRM data unavailable');
    const customers = payload.customers || [];
    main.innerHTML = `<div class="view-header"><div><p class="eyebrow">RELATIONSHIP MANAGEMENT</p><h1>Customer CRM</h1><p class="view-subtitle">Manage your team’s customer relationships, contacts, and service history.</p></div><button class="outline-button" id="crmRefresh" type="button">Refresh directory</button></div><section class="crm-toolbar panel"><div><strong>${customers.length}</strong><span>registered customers</span></div><div><strong>${customers.reduce((sum, customer) => sum + customer.bookings, 0)}</strong><span>completed bookings</span></div><div><strong>$${customers.reduce((sum, customer) => sum + customer.totalSpend, 0).toFixed(2)}</strong><span>customer revenue</span></div><label class="crm-search"><span>Search</span><input id="crmSearch" type="search" placeholder="Name, email, or phone" /></label></section><section class="crm-layout"><article class="panel crm-directory"><div class="panel-heading"><div><p class="eyebrow">CUSTOMER DIRECTORY</p><h2>Registered customers</h2></div><span class="live-pill"><i></i> Live</span></div><div class="crm-customer-list" id="crmCustomerList">${customers.length ? customers.map((customer, index) => `<button class="crm-customer-row ${index === 0 ? 'selected' : ''}" data-customer="${escapeHTML(customer.id)}"><span class="activity-avatar ${['orange-bg', 'blue-bg', 'violet-bg'][index % 3]} ">${escapeHTML(customer.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase())}</span><span><strong>${escapeHTML(customer.name)}</strong><small>${escapeHTML(customer.email)} · ${customer.bookings} bookings</small></span><span class="crm-customer-total">$${customer.totalSpend.toFixed(2)}</span></button>`).join('') : '<div class="empty-state"><strong>No customers yet</strong><p>Customers appear after quotes or bookings are created.</p></div>'}</div></article><article class="panel crm-profile" id="crmProfile">${customers[0] ? renderCRMProfile(customers[0]) : '<div class="empty-state">Select a customer to view their relationship history.</div>'}</article></section>`;
    const renderSelectedCustomer = (customer) => {
      document.querySelectorAll('.crm-customer-row').forEach((row) => row.classList.toggle('selected', row.dataset.customer === customer.id));
      const profile = document.getElementById('crmProfile');
      if (profile) profile.innerHTML = renderCRMProfile(customer);
    };
    document.querySelectorAll('.crm-customer-row').forEach((row) => row.addEventListener('click', () => renderSelectedCustomer(customers.find((customer) => customer.id === row.dataset.customer))));
    document.getElementById('crmSearch')?.addEventListener('input', (event) => {
      const query = event.target.value.toLowerCase().trim();
      document.querySelectorAll('.crm-customer-row').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
    });
    document.getElementById('crmRefresh')?.addEventListener('click', renderCRM);
  } catch (error) {
    main.innerHTML = `<div class="empty-state"><strong>CRM unavailable</strong><p>${escapeHTML(error.message)}</p><button class="outline-button" id="crmRetry" type="button">Retry</button></div>`;
    document.getElementById('crmRetry')?.addEventListener('click', renderCRM);
  }
}

function renderCRMProfile(customer) {
  return `<div class="crm-profile-header"><div><p class="eyebrow">CUSTOMER PROFILE</p><h2>${escapeHTML(customer.name)}</h2><p>${escapeHTML(customer.id)} · Last contact ${formatMessageTime(customer.lastContact)}</p></div><span class="activity-avatar blue-bg">${escapeHTML(customer.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase())}</span></div><div class="crm-contact-grid"><div><small>EMAIL</small><a href="mailto:${escapeHTML(customer.email)}">${escapeHTML(customer.email)}</a></div><div><small>PHONE</small><a href="tel:${escapeHTML(customer.phone)}">${escapeHTML(customer.phone || 'Not provided')}</a></div><div><small>BOOKINGS</small><strong>${customer.bookings}</strong></div><div><small>QUOTES</small><strong>${customer.quotes}</strong></div><div><small>TOTAL SPEND</small><strong>$${customer.totalSpend.toFixed(2)}</strong></div></div><div class="crm-history"><div class="panel-heading"><div><p class="eyebrow">RELATIONSHIP HISTORY</p><h3>Customer activity</h3></div></div>${customer.history.length ? customer.history.map((item) => `<div class="crm-history-row"><span class="crm-history-marker ${item.kind === 'booking' ? 'is-booking' : ''}"></span><div><strong>${escapeHTML(item.kind === 'booking' ? 'Booking' : 'Quote')} · ${escapeHTML(item.id)}</strong><small>${escapeHTML(item.serviceType.replace(/-/g, ' '))} · ${escapeHTML(item.date)}</small><p>${escapeHTML(item.route)}</p></div><span class="booking-badge">${escapeHTML(item.status)}</span></div>`).join('') : '<div class="empty-state">No relationship history yet.</div>'}</div>`;
}

async function renderSettings() {
  main.innerHTML = '<div class="schedule-loading">Loading workspace settings...</div>';
  let summary = {
    plan: 'Lifetime',
    licenseStatus: 'Active',
    role: 'owner',
    billing: { type: 'Lifetime', status: 'Active', amount: '$499.00', cycle: 'One-time purchase' },
    workspace: 'West Coast Fleet',
    email: 'owner@company.com'
  };

  try {
    const response = await fetchJson('/api/account/summary');
    if (response.ok) summary = await response.json();
  } catch (error) {
    // keep default summary if the backend is not available
  }
  summary.workspace = getCurrentWorkspace();

  let settings = { name: '', phone: '', email: summary.email || '', role: summary.role || 'owner', notifyEmail: 1, notifySms: 0, notifyInapp: 1 };
  try {
    const response = await fetchJson('/api/settings');
    const payload = await response.json();
    if (response.ok && payload.settings) settings = { ...settings, ...payload.settings };
  } catch (error) {
    // settings defaults remain
  }

  let adminOverview = null;
  if (summary.role === 'admin') {
    try {
      const response = await fetchJson('/api/admin/overview');
      if (response.ok) adminOverview = await response.json();
    } catch (error) {
      // admin overview is optional for a failed request
    }
  }

  let billingSummary = null;
  if (summary.role === 'admin') {
    try {
      const response = await fetchJson('/api/admin/billing');
      if (response.ok) billingSummary = await response.json();
    } catch (error) {
      // billing summary is optional
    }
  }

  let pendingUsers = [];
  if (summary.role === 'admin') {
    try {
      const response = await fetchJson('/api/admin/users?status=pending');
      if (response.ok) pendingUsers = (await response.json()).users || [];
    } catch (error) {
      // pending approvals list is optional
    }
  }

  let drivers = [];
  if (summary.role === 'admin') {
    try {
      const response = await fetchJson('/api/drivers');
      if (response.ok) drivers = (await response.json()).drivers || [];
    } catch (error) {
      // driver picker is optional
    }
  }

  const billingCards = billingSummary ? `
    <div class="metric-grid compact-grid" style="margin-top:20px;">
      <article class="metric-card"><div class="metric-top"><span>BILLING PLAN</span><span class="metric-icon blue">◉</span></div><strong>${escapeHTML(billingSummary.plan)}</strong><div class="metric-foot">${escapeHTML(billingSummary.amount)}</div></article>
      <article class="metric-card"><div class="metric-top"><span>MRR</span><span class="metric-icon green">✓</span></div><strong>${escapeHTML(billingSummary.monthlyRecurringRevenue)}</strong><div class="metric-foot">Monthly recurring</div></article>
      <article class="metric-card"><div class="metric-top"><span>ACTIVE CUSTOMERS</span><span class="metric-icon violet">◷</span></div><strong>${escapeHTML(String(billingSummary.activeCustomers))}</strong><div class="metric-foot">Collection: ${escapeHTML(billingSummary.collectionStatus)}</div></article>
    </div>
  ` : '';

  const adminCards = adminOverview ? `
    <div class="metric-grid compact-grid premium-metrics" style="margin-top:20px;">
      <article class="metric-card premium-metric"><div class="metric-top"><span>TOTAL USERS</span><span class="metric-icon blue">◉</span></div><strong>${adminOverview.totalUsers}</strong><div class="metric-foot">Active tenant accounts</div></article>
      <article class="metric-card premium-metric"><div class="metric-top"><span>ACTIVE LICENSES</span><span class="metric-icon green">✓</span></div><strong>${adminOverview.activeLicenses}</strong><div class="metric-foot">Paid customers</div></article>
      <article class="metric-card premium-metric"><div class="metric-top"><span>REVENUE</span><span class="metric-icon violet">◷</span></div><strong>$${adminOverview.totalRevenue}</strong><div class="metric-foot">${adminOverview.currency}</div></article>
    </div>
  ` : '';

  const approvalsPanel = summary.role === 'admin' ? `
    <article class="panel settings-panel" style="margin-top:20px;">
      <div class="panel-heading compact-heading">
        <div>
          <p class="eyebrow">APPROVALS</p>
          <h2>Pending account approvals</h2>
          <p class="view-subtitle">New registrations cannot sign in until you approve them.</p>
        </div>
      </div>
      ${pendingUsers.length ? `
        <div class="data-table approvals-table">
          ${pendingUsers.map((u) => `
            <div class="approvals-row" data-id="${escapeHTML(u.id)}">
              <div class="approvals-copy">
                <strong>${escapeHTML(u.email)}</strong>
                <small>${escapeHTML(String(u.createdAt || '').replace('T', ' ').slice(0, 16))}</small>
              </div>
              <div class="approvals-pickers">
                <select class="approvals-role" aria-label="Approval role">
                  <option value="customer">Customer</option>
                  <option value="owner">Dispatcher</option>
                  <option value="operator">Driver</option>
                </select>
                <select class="approvals-driver" aria-label="Link driver" style="display:none;">
                  ${drivers.length ? drivers.map((d) => `<option value="${escapeHTML(d.id)}">${escapeHTML(d.name)}</option>`).join('') : '<option value="">Add a driver first</option>'}
                </select>
              </div>
              <div class="approvals-actions">
                <button type="button" class="dispatch-button approvals-approve">Approve</button>
                <button type="button" class="outline-button approvals-reject">Reject</button>
              </div>
            </div>`).join('')}
        </div>
      ` : `
        <p class="muted" style="margin:0;">No registrations waiting for approval.</p>
      `}
      <p class="form-error" id="approvalsError" role="alert" style="margin-top:12px;"></p>
    </article>
  ` : '';

  main.innerHTML = `
    <div class="view-header">
      <div>
        <p class="eyebrow">ACCOUNT</p>
        <h1>Workspace settings</h1>
        <p class="view-subtitle">Your ${summary.workspace} SaaS details and operating status.</p>
      </div>
      <div class="header-actions">
        <button class="outline-button" id="verifyEmailButton" type="button">Verify email</button>
        <button class="dispatch-button" id="purchaseLicenseButton" type="button" ${paymentsConfigured ? '' : 'hidden'}>Purchase license</button>
        <button class="outline-button" id="signOutButton" type="button">Sign out</button>
      </div>
    </div>

    <section class="settings-shell">
      <div class="settings-hero panel">
        <div class="settings-hero-copy">
          <p class="eyebrow">PLAN STATUS</p>
          <h2>${summary.plan}</h2>
          <p class="settings-hero-text">Your workspace is online and fully provisioned for operational dispatch. Update your profile, notification preferences, and security settings below.</p>
        </div>
        <div class="settings-hero-meta">
          <span class="live-pill"><i></i> ${summary.licenseStatus}</span>
          <div class="hero-badge">${escapeHTML(summary.billing.amount)}</div>
        </div>
      </div>

      <div class="settings-grid">
        <article class="panel settings-panel">
          <div class="panel-heading compact-heading">
            <div>
              <p class="eyebrow">PROFILE</p>
              <h2>Account details</h2>
            </div>
          </div>
          <form id="profileForm" class="settings-form">
            <div class="settings-form-grid">
              <label>Display name<input id="settingName" name="name" type="text" value="${escapeHTML(settings.name)}" maxlength="60" required /></label>
              <label>Email<input type="email" value="${escapeHTML(settings.email)}" disabled /></label>
              <label>Phone<input id="settingPhone" name="phone" type="tel" value="${escapeHTML(settings.phone)}" maxlength="30" placeholder="(415) 555-0100" /></label>
              <label>Role<input type="text" value="${escapeHTML(settings.role)}" disabled /></label>
            </div>
            <div class="settings-form-actions"><button class="dispatch-button" id="saveProfile" type="submit">Save profile <span>→</span></button></div>
            <p class="form-error" id="settingsFormError" role="alert"></p>
          </form>
        </article>

        <article class="panel settings-panel accent-panel">
          <div class="panel-heading compact-heading">
            <div>
              <p class="eyebrow">NOTIFICATIONS</p>
              <h2>Preferences</h2>
            </div>
          </div>
          <form id="notifyForm" class="settings-form">
            <label class="settings-checkbox"><input id="notifyEmail" type="checkbox" ${Number(settings.notifyEmail) ? 'checked' : ''} /> Email updates <small>Dispatch summaries and billing alerts.</small></label>
            <label class="settings-checkbox"><input id="notifySms" type="checkbox" ${Number(settings.notifySms) ? 'checked' : ''} /> SMS alerts <small>Urgent job and vehicle alerts.</small></label>
            <label class="settings-checkbox"><input id="notifyInapp" type="checkbox" ${Number(settings.notifyInapp) ? 'checked' : ''} /> In-app notifications <small>Show alerts in the notification bell.</small></label>
            <div class="settings-form-actions"><button class="dispatch-button" id="saveNotify" type="submit">Save preferences <span>→</span></button></div>
            <p class="form-error" id="notifyFormError" role="alert"></p>
          </form>
        </article>

        <article class="panel settings-panel">
          <div class="panel-heading compact-heading">
            <div>
              <p class="eyebrow">WORKSPACE</p>
              <h2>Overview</h2>
            </div>
          </div>
          <div class="data-table settings-table">
            <div class="data-row"><span>Workspace</span><strong>${escapeHTML(summary.workspace)}</strong></div>
            <div class="data-row"><span>Billing</span><strong>${escapeHTML(summary.billing.type)} · ${escapeHTML(summary.billing.amount)} ${escapeHTML(summary.billing.cycle)}</strong></div>
            <div class="data-row"><span>Role</span><strong>${escapeHTML(settings.role)}</strong></div>
            <div class="data-row"><span>Email</span><strong>${escapeHTML(settings.email)}</strong></div>
          </div>
        </article>

        <article class="panel settings-panel">
          <div class="panel-heading compact-heading">
            <div>
              <p class="eyebrow">SECURITY</p>
              <h2>Change password</h2>
            </div>
          </div>
          <form id="passwordForm" class="settings-form">
            <div class="settings-form-grid">
              <label>Current password<input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required /></label>
              <label>New password<input id="newPassword" name="newPassword" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required /></label>
            </div>
            <div class="settings-form-actions"><button class="danger-button" id="savePassword" type="submit">Update password <span>→</span></button></div>
            <p class="form-error" id="passwordFormError" role="alert"></p>
          </form>
          <ul class="security-list">
            <li><span class="security-dot green"></span> JWT authentication enabled</li>
            <li><span class="security-dot blue"></span> License enforcement active</li>
            <li><span class="security-dot violet"></span> Role-based access ready</li>
          </ul>
        </article>
      </div>

      ${approvalsPanel}
      ${billingCards || adminCards}
    </section>
  `;

  document.getElementById('verifyEmailButton')?.addEventListener('click', async () => {
    try {
      const response = await fetchJson('/api/auth/verify-email', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to generate verification token');
      showToast('Verification token generated');
      console.log('Verification token:', result.token);
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('signOutButton')?.addEventListener('click', () => {
    setAuthToken('');
    renderAuthScreen();
    showToast('Signed out');
  });

  document.getElementById('purchaseLicenseButton')?.addEventListener('click', beginLifetimePurchase);

  document.querySelectorAll('.approvals-role').forEach((select) => {
    select.addEventListener('change', () => {
      const driverSelect = select.closest('.approvals-row')?.querySelector('.approvals-driver');
      if (driverSelect) driverSelect.style.display = select.value === 'operator' ? '' : 'none';
    });
  });

  const setApproval = async (userId, action) => {
    const error = document.getElementById('approvalsError');
    if (error) error.textContent = '';
    try {
      const role = String(document.querySelector(`.approvals-row[data-id="${userId}"] .approvals-role`)?.value || 'customer');
      const driverSelect = document.querySelector(`.approvals-row[data-id="${userId}"] .approvals-driver`);
      const driverId = driverSelect ? String(driverSelect.value || '') : '';
      const body = (action === 'approve')
        ? JSON.stringify({ role, driverId })
        : JSON.stringify({});
      const response = await fetchJson(`/api/admin/users/${userId}/${action}`, { method: 'PATCH', body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not update account status');
      showToast(action === 'approve' ? 'Account approved' : 'Registration declined');
      renderSettings();
    } catch (requestError) {
      if (error) error.textContent = requestError.message;
    }
  };

  document.querySelectorAll('.approvals-approve').forEach((button) => {
    button.addEventListener('click', () => setApproval(button.closest('.approvals-row')?.dataset?.id || '', 'approve'));
  });
  document.querySelectorAll('.approvals-reject').forEach((button) => {
    button.addEventListener('click', () => setApproval(button.closest('.approvals-row')?.dataset?.id || '', 'reject'));
  });

  document.getElementById('profileForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('settingsFormError');
    error.textContent = '';
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetchJson('/api/settings', { method: 'PATCH', body: JSON.stringify({ name: form.get('name'), phone: form.get('phone') }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save profile');
      if (currentUser) currentUser.name = payload.settings.name;
      updateSidebarUser();
      if (payload.settings.phone) setCurrentWorkspace(summary.workspace);
      showToast('Profile updated');
      renderSettings();
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });

  document.getElementById('notifyForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('notifyFormError');
    error.textContent = '';
    try {
      const response = await fetchJson('/api/settings', { method: 'PATCH', body: JSON.stringify({
        name: document.getElementById('settingName')?.value || settings.name,
        notifyEmail: document.getElementById('notifyEmail')?.checked ? 1 : 0,
        notifySms: document.getElementById('notifySms')?.checked ? 1 : 0,
        notifyInapp: document.getElementById('notifyInapp')?.checked ? 1 : 0
      }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save preferences');
      showToast('Notification preferences saved');
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });

  document.getElementById('passwordForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('passwordFormError');
    const formElement = event.currentTarget;
    error.textContent = '';
    const form = new FormData(formElement);
    if (String(form.get('newPassword') || '').length < 8) { error.textContent = 'New password must be at least 8 characters long.'; return; }
    try {
      const response = await fetchJson('/api/settings/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not update password');
      formElement.reset();
      showToast('Password updated');
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });
}

async function renderSupport() {
  main.innerHTML = '<div class="schedule-loading">Loading support centre...</div>';
  try {
    let existingTickets = [];
    try {
      const res = await fetchJson('/api/support/tickets');
      const data = await res.json();
      existingTickets = data.tickets || [];
    } catch (_) { /* tickets fetch is best-effort */ }

    main.innerHTML = `
      <div class="view-header">
        <div>
          <p class="eyebrow">HELP</p>
          <h1>Support centre</h1>
          <p class="view-subtitle">Get help with your RZ Dispatch workspace, billing, or fleet operations.</p>
        </div>
      </div>

      <section class="support-grid">

        <article class="panel support-contact-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">CONTACT</p><h2>Submit a ticket</h2></div>
          </div>
          <form id="supportTicketForm" class="support-form">
            <label>Subject
              <select name="subject" id="supportSubject" required>
                <option value="">Choose a topic...</option>
                <option value="Billing & Payments">Billing & Payments</option>
                <option value="Account Access">Account Access</option>
                <option value="Dispatch / Routing">Dispatch / Routing</option>
                <option value="Fleet & Drivers">Fleet & Drivers</option>
                <option value="Booking Issue">Booking Issue</option>
                <option value="Bug Report">Bug Report</option>
                <option value="Feature Request">Feature Request</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <label>Message
              <textarea name="message" id="supportMessage" rows="5" maxlength="1000" placeholder="Describe your issue or request..." required></textarea>
            </label>
            <p class="form-error" id="supportFormError" role="alert"></p>
            <button class="dispatch-button" type="submit">Send ticket <span>→</span></button>
          </form>
        </article>

        <article class="panel support-status-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">SYSTEM STATUS</p><h2>Service health</h2></div>
          </div>
          <div class="support-status-list" id="supportStatusList">
            <div class="support-status-row"><span class="support-dot green-dot"></span><strong>Dispatch API</strong><span class="support-badge ok">Operational</span></div>
            <div class="support-status-row"><span class="support-dot green-dot"></span><strong>Live tracking</strong><span class="support-badge ok">Operational</span></div>
            <div class="support-status-row"><span class="support-dot green-dot"></span><strong>Booking engine</strong><span class="support-badge ok">Operational</span></div>
            <div class="support-status-row"><span class="support-dot green-dot"></span><strong>Customer portal</strong><span class="support-badge ok">Operational</span></div>
          </div>
        </article>

        <article class="panel support-faq-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">KNOWLEDGE BASE</p><h2>Frequently asked questions</h2></div>
          </div>
          <div class="support-faq-list">
            <details class="support-faq-item"><summary>How do I assign a driver to a job?</summary><p>Open <strong>Dispatch</strong>, click a job in the queue, and press <em>Assign driver</em>. Choose an available driver and confirm.</p></details>
            <details class="support-faq-item"><summary>How do I add a new vehicle to my fleet?</summary><p>Go to <strong>Fleet</strong> and click <em>+ Add vehicle</em>. Fill in the plate, make, model, and capacity — the vehicle appears immediately.</p></details>
            <details class="support-faq-item"><summary>How do zone surcharges work?</summary><p>Each coverage zone has its own base and per-mile surcharge. They're automatically applied when a booking origin falls inside that zone.</p></details>
            <details class="support-faq-item"><summary>Can customers track their driver in real time?</summary><p>Yes. Once a driver is assigned to a booking, the customer portal shows the current trip status and progress, plus the assigned driver and vehicle.</p></details>
            <details class="support-faq-item"><summary>How do I view or export billing data?</summary><p>Go to <strong>Settings → Workspace</strong> to see your active plan. Full billing history and invoice exports are under <strong>Account</strong>.</p></details>
            <details class="support-faq-item"><summary>What happens if a driver goes offline mid-trip?</summary><p>The trip status changes to <em>delayed</em> automatically. You can reassign to another driver from the dispatch panel at any time.</p></details>
          </div>
        </article>

        <article class="panel support-previous-panel" ${existingTickets.length ? '' : 'hidden'}>
          <div class="panel-heading">
            <div><p class="eyebrow">YOUR TICKETS</p><h2>Previous requests</h2></div>
          </div>
          <div class="support-ticket-list">
            ${existingTickets.map((ticket) => `
              <div class="support-ticket-row">
                <span class="support-dot ${ticket.status === 'open' ? 'orange-dot' : 'green-dot'}"></span>
                <div><strong>${escapeHTML(ticket.subject)}</strong><small>${escapeHTML(ticket.message.slice(0, 80))}${ticket.message.length > 80 ? '...' : ''}</small></div>
                <span class="support-badge ${ticket.status === 'open' ? 'pending' : 'ok'}">${ticket.status}</span>
              </div>
            `).join('')}
          </div>
        </article>

      </section>
    `;

    document.getElementById('supportTicketForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errEl = document.getElementById('supportFormError');
      const subject = document.getElementById('supportSubject').value;
      const message = document.getElementById('supportMessage').value.trim();
      if (!subject || !message) { errEl.textContent = 'Pick a subject and write a message.'; return; }
      errEl.textContent = '';
      try {
        const res = await fetchJson('/api/support/ticket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject, message })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not submit ticket');
        showToast(`Ticket ${data.ticket.id} submitted`);
        document.getElementById('supportMessage').value = '';
        document.getElementById('supportSubject').selectedIndex = 0;
        renderSupport();
      } catch (error) {
        errEl.textContent = error.message || 'Submission failed';
      }
    });
  } catch (error) {
    main.innerHTML = `<div class="empty-state"><strong>Support centre unavailable</strong><p>${escapeHTML(error.message)}</p></div>`;
  }
}

function renderView(view) {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.getAttribute('href') === `#${view}`));
  if (view === 'dispatch') { destroyLeafletMap(); main.innerHTML = dispatchMarkup; main.id = 'dispatch'; bindDispatch(); return; }
  if (view !== 'dispatch') destroyLeafletMap();
  main.id = view;
  if (view === 'schedule') renderSchedule();
  else if (view === 'fleet') renderFleet();
  else if (view === 'drivers') renderDrivers();
  else if (view === 'bookings') renderBookings();
  else if (view === 'services') renderServicePages();
  else if (view === 'coverage') renderCoveragePage();
  else if (view === 'crm') renderCRM();
  else if (view === 'analytics') renderAnalytics();
  else if (view === 'inbox') renderInbox();
  else if (view === 'settings') renderSettings();
  else if (view === 'support') renderSupport();
  else renderSimpleView('Settings', 'Workspace preferences for West Coast Fleet.', '<div class="empty-state"><strong>Workspace is live</strong><p>Fleet data is connected to the Relay backend.</p></div>');
}

document.querySelectorAll('.nav-item[href^="#"]').forEach((item) => item.addEventListener('click', (event) => { event.preventDefault(); window.location.hash = item.getAttribute('href').slice(1); }));
window.addEventListener('hashchange', () => {
  closeWorkspaceMenu();
  const sp = document.getElementById('searchPanel');
  if (sp) { sp.remove(); searchPanelOpen = false; }
  const np = document.getElementById('notificationsPanel');
  if (np) { np.remove(); notificationsPanelOpen = false; }
  if (!getAuthToken() && currentMode !== 'customer') { renderAuthScreen(); return; }
  // Role-based navigation guard: a signed-in user can only ever see the portal
  // their account role is allowed to use.
  if (currentUser) {
    if (currentUser.role === 'operator' && currentUser.driverId) { setAppMode('operator'); renderOperatorPortal(); return; }
    if (currentUser.role === 'customer') { setAppMode('customer'); renderCustomerHome(); return; }
  }
  renderView(window.location.hash.slice(1) || 'dispatch');
});
window.addEventListener('load', () => renderLiveDateAndGreeting());
setInterval(() => {
  renderLiveDateAndGreeting();
  if (document.getElementById('dispatch') && state.jobs.length) {
    renderMapPins();
    renderQueue();
  }
}, 30000);

document.getElementById('closeJobModal')?.addEventListener('click', closeJobModal);
document.getElementById('cancelJob')?.addEventListener('click', closeJobModal);
document.getElementById('jobForm')?.addEventListener('submit', createJob);
document.getElementById('jobModal')?.addEventListener('click', (event) => { if (event.target.id === 'jobModal') closeJobModal(); });
document.getElementById('closeVehicleModal')?.addEventListener('click', closeVehicleModal);
document.getElementById('cancelVehicle')?.addEventListener('click', closeVehicleModal);
document.getElementById('vehicleForm')?.addEventListener('submit', saveVehicle);
document.getElementById('vehicleModal')?.addEventListener('click', (event) => { if (event.target.id === 'vehicleModal') closeVehicleModal(); });
document.getElementById('closeDriverModal')?.addEventListener('click', closeDriverModal);
document.getElementById('cancelDriver')?.addEventListener('click', closeDriverModal);
document.getElementById('driverForm')?.addEventListener('submit', saveDriver);
document.getElementById('driverModal')?.addEventListener('click', (event) => { if (event.target.id === 'driverModal') closeDriverModal(); });
document.getElementById('requestQuoteButton')?.addEventListener('click', openQuoteModal);
document.getElementById('closeQuoteModal')?.addEventListener('click', closeQuoteModal);
document.getElementById('estimateQuoteButton')?.addEventListener('click', estimateQuoteFromForm);
document.getElementById('autoMilesButton')?.addEventListener('click', autoEstimateMiles);
quoteForm?.addEventListener('submit', submitBooking);
document.getElementById('quoteModal')?.addEventListener('click', (event) => { if (event.target.id === 'quoteModal') closeQuoteModal(); });
document.getElementById('closeLicenseModal')?.addEventListener('click', closeLicenseModal);
document.getElementById('cancelLicense')?.addEventListener('click', closeLicenseModal);
document.getElementById('purchaseLicenseModal')?.addEventListener('click', beginLifetimePurchase);
licenseForm?.addEventListener('submit', activateLicense);
document.getElementById('closeJobDetail')?.addEventListener('click', closeJobDetail);
document.getElementById('jobDetailModal')?.addEventListener('click', (event) => { if (event.target.id === 'jobDetailModal') closeJobDetail(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById('jobModal') && !document.getElementById('jobModal').hidden) closeJobModal();
  if (event.key === 'Escape' && licenseModal && !licenseModal.hidden) closeLicenseModal();
  if (event.key === 'Escape' && quoteModal && !quoteModal.hidden) closeQuoteModal();
  if (event.key === 'Escape' && document.getElementById('jobDetailModal') && !document.getElementById('jobDetailModal').hidden) closeJobDetail();
  if (event.key === 'Escape' && document.getElementById('driverModal') && !document.getElementById('driverModal').hidden) closeDriverModal();
});

// ---------------------------------------------------------------------------
// Realtime communication between the three portals (dispatch, operator,
// customer). The client (realtime.js) runs a single WebSocket that the server
// feeds with message/job/presence events. These handlers keep every portal
// in sync without a page reload and degrade to plain REST when the socket is
// unavailable.
// ---------------------------------------------------------------------------
let rtActiveThreadEmail = null;
let rtTrackedBooking = null;
const rtRecentSent = new Set();

function rtConfigure(apiBaseOverride) {
  if (window.RZRealtime) window.RZRealtime.configure({ apiBase: apiBaseOverride || apiBase });
}

function rtSetupSession() {
  if (!window.RZRealtime) return;
  if (!currentUser) {
    if (currentMode === 'customer') {
      const profile = getCustomerProfile();
      if (profile && profile.email) {
        window.RZRealtime.identify({ role: 'customer', email: profile.email, name: profile.name || 'Customer' });
        return;
      }
    }
    window.RZRealtime.identify(null);
    return;
  }
  const token = getAuthToken();
  if (currentUser.role === 'operator' && currentUser.driverId) {
    window.RZRealtime.identify({ role: 'operator', driverId: currentUser.driverId, email: currentUser.email, name: currentUser.name, token });
    return;
  }
  if (currentUser.role === 'customer') {
    window.RZRealtime.identify({ role: 'customer', email: currentUser.email, name: currentUser.name || currentUser.email, token });
    return;
  }
  window.RZRealtime.identify({ role: 'staff', email: currentUser.email, name: currentUser.name || currentUser.email, token });
}

function rtWatchCustomer(email) {
  if (!window.RZRealtime) return;
  const formatted = String(email || '').trim().toLowerCase();
  if (!formatted) return;
  window.RZRealtime.subscribe({ type: 'customer', email: formatted });
}

function rtRegisterHandlers() {
  if (!window.RZRealtime) return;
  window.RZRealtime.on('message.new', rtHandleNewMessage);
  window.RZRealtime.on('message.read', (payload) => {
    if (payload && !window.RZRealtime) return;
    if (document.getElementById('messageList') && currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner')) {
      refreshInboxBadges();
    }
  });
  window.RZRealtime.on('message.deleted', () => {
    if (document.getElementById('messageList') && currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner')) {
      renderInbox(true);
    }
  });
  window.RZRealtime.on('job.status', rtHandleJobEvent);
  window.RZRealtime.on('job.assigned', rtHandleJobEvent);
  window.RZRealtime.on('activity', () => {
    if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner') && document.getElementById('dispatch')) {
      requestOverview().then(() => renderView(window.location.hash.slice(1) || 'dispatch'));
    }
  });
  window.RZRealtime.on('presence', rtRenderPresenceStrip);
}

function rtHandleNewMessage(message) {
  if (!message) return;
  if (message.id && rtRecentSent.has(message.id)) { rtRecentSent.delete(message.id); return; }
  const isStaff = Boolean(currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner'));
  const msgForMe = (driverMe) => {
    if (message.recipientDriverId) return Boolean(driverMe && message.recipientDriverId === driverMe);
    return false;
  };

  if (isStaff) {
    if (document.getElementById('messageList')) {
      refreshInboxBadges();
      if (!inboxState.search) renderInbox(true);
    } else {
      refreshNotificationBadge();
      const from = message.sender || 'Dispatch';
      const tag = message.operatorDriverId ? 'driver' : message.customerEmail ? 'customer' : '';
      showToast(`${from}${tag ? ` (${tag})` : ''} · ${message.subject}`);
    }
    return;
  }
  if (currentUser && currentUser.role === 'operator') {
    if (!msgForMe(currentUser.driverId)) return;
    if (document.getElementById('operatorMessagesBox')) loadOperatorMessages();
    else showToast(`Dispatch · ${message.subject}`);
    return;
  }
  if (currentMode === 'customer') {
    const profileEmail = String(getCustomerProfile().email || '').toLowerCase();
    const msgEmail = String(message.customerEmail || '').toLowerCase();
    if (!msgEmail || !(msgEmail === profileEmail || msgEmail === String(rtActiveThreadEmail || '').toLowerCase())) return;
    if (document.getElementById('customerThread')) {
      loadCustomerThread(msgEmail);
    } else {
      showToast(`RZ Dispatch team · ${message.subject}`);
    }
  }
}

function rtHandleJobEvent(payload) {
  const job = payload && payload.job;
  if (!job) return;
  if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner')) {
    if (['dispatch', 'schedule', 'fleet', 'drivers', 'inbox'].includes(String(main.id || '')) && state.jobs.length) {
      requestOverview().then(() => renderView(window.location.hash.slice(1) || 'dispatch'));
    }
    return;
  }
  if (currentUser && currentUser.role === 'operator') {
    if (document.getElementById('operatorJobCardList') || document.querySelector('.operator-job-list')) {
      // Only refresh the route list, never clobber the job-detail screen.
      if (!document.getElementById('operatorAdvance')) renderOperatorPortal();
    }
    return;
  }
  if (currentMode === 'customer' && rtTrackedBooking) {
    const bookingId = String(rtTrackedBooking.orderId || '').toLowerCase();
    if (job.bookingId && String(job.bookingId).toLowerCase() === bookingId) {
      rtRefreshTrackedBooking();
    }
  }
}

async function rtRefreshTrackedBooking() {
  if (!rtTrackedBooking) return;
  const resultBox = document.getElementById('customerPortalResult');
  if (!resultBox) return;
  try {
    const response = await fetch(apiUrl(`/api/customer/order?orderId=${encodeURIComponent(rtTrackedBooking.orderId)}&email=${encodeURIComponent(rtTrackedBooking.email)}`));
    const payload = await response.json();
    if (!response.ok) return;
    resultBox.innerHTML = renderCustomerOrderCard(payload) + `<p class="customer-contact-link"><button class="text-button" id="trackContact" type="button">Need help? Message the dispatch team</button></p>`;
    document.getElementById('trackContact')?.addEventListener('click', () => renderCustomerContact(rtTrackedBooking.email));
  } catch (_) { /* keep previous card on failure */ }
}

function rtRenderPresenceStrip() {
  const strip = document.getElementById('presenceStrip');
  if (!strip) return;
  const online = (window.RZRealtime && window.RZRealtime.getPresence()) || [];
  if (!online.length) { strip.innerHTML = ''; strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = `<span class="presence-label">ONLINE NOW</span>` + online.filter((p) => p.kind !== 'staff').slice(0, 8).map((p) => {
    const badge = p.kind === 'driver' ? `<em>${escapeHTML(p.driverId || '')}</em>` : '';
    return `<span class="presence-chip ${escapeHTML(p.kind)}"><span class="presence-dot"></span>${escapeHTML(p.name || '')}${badge}</span>`;
  }).join('');
}

async function loadOperatorMessages() {
  const box = document.getElementById('operatorMessagesBox');
  if (!box) return;
  try {
    const response = await fetchJson('/api/operator/messages');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load messages');
    if (!payload.messages.length) {
      box.innerHTML = '<div class="operator-empty"><p>No messages yet. Say hi to your dispatch team from the box below.</p></div>';
      return;
    }
    box.innerHTML = payload.messages.map(rtRenderOperatorMessage).join('');
  } catch (error) {
    box.innerHTML = `<div class="operator-empty"><p>${escapeHTML(error.message)}</p></div>`;
  }
}

function rtRenderOperatorMessage(message) {
  const fromMe = message.operatorDriverId !== null && message.operatorDriverId !== undefined && currentUser && message.operatorDriverId === currentUser.driverId;
  const fromDispatch = message.recipientDriverId ? Boolean(currentUser && message.recipientDriverId === currentUser.driverId) : false;
  const isOut = fromMe;
  return `<div class="operator-msg-row ${isOut ? 'is-out' : 'is-in'}"><div class="operator-msg-meta"><strong>${escapeHTML(isOut ? 'You' : (message.sender || 'Dispatch'))}</strong><span>${escapeHTML(formatFullMessageTime(message.createdAt))}</span></div><div class="operator-msg-subject">${escapeHTML(message.subject)}</div><div class="operator-msg-body">${escapeHTML(message.body)}</div></div>`;
}

async function sendOperatorMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const error = document.getElementById('operatorMessageError');
  const subject = String(formData.get('subject') || '').trim();
  const body = String(formData.get('body') || '').trim();
  if (!subject || !body) {
    if (error) error.textContent = 'Add a subject and a message.';
    return;
  }
  if (error) error.textContent = '';
  const button = form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.textContent = 'Sending...'; }
  try {
    const response = await fetchJson('/api/operator/messages', { method: 'POST', body: JSON.stringify({ subject, body }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not send message');
    if (result.message) rtRecentSent.add(result.message.id);
    form.reset();
    showToast('Message sent to dispatch');
    await loadOperatorMessages();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Send to dispatch →'; }
  }
}

async function initializeApp() {
  await detectApiBase();
  rtConfigure();
  rtRegisterHandlers();
  updateDispatcherSidebar();
  document.querySelectorAll('.sidebar .nav-item[href^="#"]').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      window.location.hash = item.getAttribute('href').slice(1);
    });
  });
  document.querySelector('.workspace-switcher')?.addEventListener('click', toggleWorkspaceMenu);
  document.querySelector('.help-card')?.addEventListener('click', () => { window.location.hash = 'support'; });
  document.addEventListener('click', (event) => {
    const workspaceMenu = document.getElementById('workspaceMenu');
    if (workspaceMenu && workspaceMenuOpen && !workspaceMenu.contains(event.target) && !event.target.closest('.workspace-switcher')) {
      workspaceMenu.remove();
      workspaceMenuOpen = false;
    }
    const searchPanel = document.getElementById('searchPanel');
    if (searchPanel && searchPanelOpen && !searchPanel.contains(event.target) && event.target.id !== 'dashboardSearch' && !event.target.closest('#dashboardSearch')) {
      searchPanel.remove();
      searchPanelOpen = false;
    }
    const notificationsPanel = document.getElementById('notificationsPanel');
    if (notificationsPanel && notificationsPanelOpen && !notificationsPanel.contains(event.target) && event.target.id !== 'dashboardNotifications' && !event.target.closest('#dashboardNotifications')) {
      notificationsPanel.remove();
      notificationsPanelOpen = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeWorkspaceMenu();
      const sp = document.getElementById('searchPanel');
      if (sp) { sp.remove(); searchPanelOpen = false; }
      const np = document.getElementById('notificationsPanel');
      if (np) { np.remove(); notificationsPanelOpen = false; }
    }
  });
  const resetToken = new URLSearchParams(window.location.search).get('reset');
  if (resetToken) {
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
    renderResetPassword(resetToken);
    return;
  }

  // Stripe Checkout redirects back to ${PUBLIC_URL}/?purchase=success&session_id=cs_...
  // (or ?purchase=cancelled). Confirm the paid session and issue the license key,
  // then scrub the query string so the state is not reused on refresh.
  const purchaseStr = new URLSearchParams(window.location.search).get('purchase');
  const pendingSession = sessionStorage.getItem('rz_pending_purchase') || '';
  const purchaseSession = new URLSearchParams(window.location.search).get('session_id') || '';
  if (purchaseStr === 'success' && (purchaseSession || pendingSession)) {
    await completeLifetimePurchase(purchaseSession || pendingSession);
  } else if (purchaseStr === 'cancelled') {
    sessionStorage.removeItem('rz_pending_purchase');
    showToast('Checkout cancelled');
  }
  if (purchaseStr) {
    const cleanUrl = window.location.origin + window.location.pathname + (window.location.hash || '');
    window.history.replaceState({}, document.title, cleanUrl);
  }

  const token = getAuthToken();
  if (!token) {
    rtSetupSession();
    renderCustomerHome();
    return;
  }

  // Route the session by the account's role, not by whatever portal the user
  // last visited. Drivers land in the operator portal, customers in the
  // customer portal, and dispatchers (admin/owner) in the dispatch dashboard.
  let identity = null;
  try {
    const meResponse = await fetchJson('/api/auth/me');
    if (meResponse.ok) identity = (await meResponse.json()).user || null;
  } catch (error) {
    // Unreachable backend — fall through to try the dispatch dashboard below.
  }
  if (identity) {
    currentUser = identity;
    updateSidebarUser();
    if (identity.role === 'operator' && identity.driverId) {
      setAppMode('operator');
      renderOperatorPortal();
      return;
    }
    if (identity.role === 'customer') {
      setAppMode('customer');
      rtSetupSession();
      renderCustomerHome();
      return;
    }
    const allowed = await checkLicenseStatus();
    if (!allowed) return;
    rtSetupSession();
    try {
      await requestOverview();
      renderView(window.location.hash.slice(1) || 'dispatch');
    } catch (error) {
      showToast('Start the backend with npm start to load live data');
    }
    return;
  }

  // No usable session identity (expired token, declined account, or reflection
  // of a role the browser should not be in): drop the token and show sign-in.
  setAuthToken('');
  if (localStorage.getItem(MODE_KEY) === 'operator') {
    setAppMode('operator');
    renderAuthScreen();
    selectAuthMode('operator');
    return;
  }
  renderAuthScreen();
}

initializeApp();
