'use strict';

/**
 * @fileoverview SQLite schema setup, shared by every Store instance.
 */

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS entries (
  key BLOB PRIMARY KEY,
  value BLOB NOT NULL,
  version TEXT NOT NULL,
  expires_at INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_entries_expires_at
  ON entries(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value BLOB NOT NULL,
  enqueued_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  backoff_schedule TEXT,
  keys_if_undelivered TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_available_at ON queue(available_at);
`;

/**
 * Creates the database schema if it does not already exist.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function schemaInit(db) {
  db.exec(SCHEMA_SQL);
}

module.exports = { schemaInit };
