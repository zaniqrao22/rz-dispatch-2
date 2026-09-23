'use strict';

/**
 * Production launcher: loads .env.production (overrides dev .env), initializes
 * the database, and starts the app in production mode against PostgreSQL.
 *
 * Prerequisites:
 *   - PostgreSQL must already be running (use `npm run db:start` to start it;
 *     production deployments use an externally managed instance)
 *   - Database schema is created automatically on first start via initializeDatabase
 *
 * Usage:
 *   node scripts/start-production.js
 */

const path = require('path');

// Load .env.production BEFORE server.js loads the dev .env
require('dotenv').config({ path: path.join(__dirname, '..', '.env.production') });

// Ensure production defaults are set
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
if (!process.env.HOST) process.env.HOST = '0.0.0.0';
if (!process.env.PORT) process.env.PORT = '8000';

const { initializeDatabase, app, realtime } = require('../server');

async function main() {
  await initializeDatabase();
  const { runMigrations } = require('./migrate');
  await runMigrations();
  const PORT = Number(process.env.PORT) || 8000;
  const HOST = process.env.HOST || '0.0.0.0';
  const server = app.listen(PORT, HOST, () => {
    console.log(`RZ Dispatch SaaS running at http://${HOST}:${PORT}`);
  });
  realtime.attachRealtime(server, { jwtSecret: process.env.JWT_SECRET });
}

main().catch((error) => {
  console.error('Failed to start in production mode:', error.message);
  process.exit(1);
});