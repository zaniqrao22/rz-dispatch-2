'use strict';

/**
 * One-command developer launcher: starts the embedded PostgreSQL database if
 * it is not already running, initializes the schema, then starts the app.
 *
 * Usage:
 *   npm run dev
 *
 * Production deployments should use `npm start` against an externally managed
 * PostgreSQL instance (see DEPLOYMENT.md).
 */

require('dotenv').config();
const { ensureDatabase } = require('./ensure-database');
const { initializeDatabase, app, realtime } = require('../server');

async function main() {
  await ensureDatabase();
  await initializeDatabase();

  const PORT = Number(process.env.PORT) || 8000;
  const HOST = process.env.HOST || '0.0.0.0';
  const server = app.listen(PORT, HOST, () => {
    console.log(`RZ Dispatch SaaS running at http://${HOST}:${PORT}`);
  });
  realtime.attachRealtime(server, { jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me' });
}

main().catch((error) => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});