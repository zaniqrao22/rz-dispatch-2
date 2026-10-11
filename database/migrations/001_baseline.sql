-- Baseline: the full schema is maintained idempotently in server.js
-- initializeDatabase(). New schema changes go in numbered .sql files here,
-- e.g. 002_add_column.sql, and are applied once by scripts/migrate.js.
SELECT 1;