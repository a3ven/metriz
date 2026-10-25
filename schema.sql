CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY,
 code TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 password_salt TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 role TEXT NOT NULL DEFAULT 'user',
 active INTEGER NOT NULL DEFAULT 1,
 device_id TEXT,
 last_login INTEGER,
 max_devices INTEGER DEFAULT 1,
 device_ids TEXT DEFAULT '[]',
 password_enc TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 name TEXT NOT NULL,
 data TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 analysis_data TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON projects(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS presence (
 cid TEXT PRIMARY KEY,
 kind TEXT NOT NULL,
 user_id TEXT,
 first_seen INTEGER NOT NULL,
 last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS presence_seen_idx ON presence(last_seen);
