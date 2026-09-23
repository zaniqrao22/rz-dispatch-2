'use strict';

/**
 * Creates the PostgreSQL schema and seeds default data.
 *
 * The application normally does this automatically on the first database
 * access; this script is only needed when you want to run it explicitly,
 * for example right after creating a fresh database:
 *
 *   npm run db:init
 */

const { initializeDatabase } = require('../server');

(async () => {
  await initializeDatabase();
  console.log('Database schema is ready.');
  process.exit(0);
})().catch((error) => {
  console.error('Database initialization failed:', error.message);
  process.exit(1);
});