'use strict';

/**
 * Scoped API keys for machine-to-machine access to the RZ Dispatch API.
 *
 * Keys are shown once at creation and stored only as a SHA-256 hash, so a
 * database leak cannot be used to authenticate. A short readable prefix is kept
 * so users can tell keys apart in the UI. Each key belongs to a user (and thus
 * inherits that user's role/tenant), can be revoked independently, and records
 * when it was last used.
 *
 * Format: rz_<live|test>_<48 hex chars>. The distinctive prefix lets the auth
 * middleware recognise an API key versus a JWT without a database lookup.
 */

const crypto = require('crypto');

const API_KEY_PATTERN = /^rz_(live|test)_[a-f0-9]{48}$/;
const PREFIX_DISPLAY_LENGTH = 12;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    company_account_id TEXT,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scopes TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`
];

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function looksLikeApiKey(value) {
  return API_KEY_PATTERN.test(String(value || '').trim());
}

function generateApiKey({ environment } = {}) {
  const env = String(environment || '').toLowerCase() === 'test' ? 'test' : 'live';
  const key = `rz_${env}_${crypto.randomBytes(24).toString('hex')}`;
  return {
    key,
    prefix: key.slice(0, PREFIX_DISPLAY_LENGTH),
    hash: hashKey(key),
    environment: env
  };
}

function normalizeScopes(scopes) {
  const list = Array.isArray(scopes)
    ? scopes
    : String(scopes || '')
        .split(/[\s,]+/)
        .filter(Boolean);
  const cleaned = [...new Set(list.map((scope) => String(scope).trim().toLowerCase()).filter(Boolean))];
  return cleaned.length ? cleaned : ['read', 'write'];
}

function createApiKeys(db) {
  function publicRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: parseScopes(row.scopes),
      lastUsedAt: row.last_used_at || row.lastUsedAt || null,
      createdAt: row.created_at || row.createdAt || null,
      revokedAt: row.revoked_at || row.revokedAt || null
    };
  }

  async function create(user, { name, scopes, environment } = {}) {
    const label = String(name || '').trim().slice(0, 80);
    if (!label) throw new Error('A name for the API key is required.');
    const generated = generateApiKey({ environment });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const companyAccountId = user.companyAccountId || user.company_account_id || null;
    await db.run(
      'INSERT INTO api_keys (id, user_id, company_account_id, name, prefix, key_hash, scopes, last_used_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, user.id, companyAccountId, label, generated.prefix, generated.hash, JSON.stringify(normalizeScopes(scopes)), null, now, null
    );
    return {
      // The raw key is returned exactly once and never recoverable afterwards.
      key: generated.key,
      apiKey: publicRow({ id, name: label, prefix: generated.prefix, scopes: JSON.stringify(normalizeScopes(scopes)), created_at: now })
    };
  }

  async function list(user) {
    const rows = await db.all(
      'SELECT id, name, prefix, scopes, last_used_at, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      user.id
    );
    return rows.map(publicRow);
  }

  async function revoke(user, id) {
    const row = await db.get('SELECT id, user_id FROM api_keys WHERE id = ?', id);
    if (!row || row.user_id !== user.id) return false;
    await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', new Date().toISOString(), id);
    return true;
  }

  /**
   * Resolve a presented key to its owning user. Returns
   * `{ userId, companyAccountId, scopes, keyId }` or null. Touches last_used_at
   * (best-effort) so the UI can show key activity.
   */
  async function verify(presented) {
    const key = String(presented || '').trim();
    if (!looksLikeApiKey(key)) return null;
    const row = await db.get('SELECT id, user_id, company_account_id, scopes, revoked_at FROM api_keys WHERE key_hash = ?', hashKey(key));
    if (!row || row.revoked_at) return null;
    db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', new Date().toISOString(), row.id).catch(() => {});
    return {
      keyId: row.id,
      userId: row.user_id,
      companyAccountId: row.company_account_id || null,
      scopes: parseScopes(row.scopes)
    };
  }

  return { create, list, revoke, verify };
}

function parseScopes(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  createApiKeys,
  schemaStatements,
  generateApiKey,
  hashKey,
  looksLikeApiKey,
  normalizeScopes,
  API_KEY_PATTERN
};
