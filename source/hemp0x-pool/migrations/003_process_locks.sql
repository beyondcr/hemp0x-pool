CREATE TABLE IF NOT EXISTS process_locks (
    lock_name   TEXT PRIMARY KEY,
    locked_at   INTEGER NOT NULL,
    locked_by   TEXT NOT NULL,
    expires_at  INTEGER
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  INTEGER NOT NULL,
    checksum    TEXT
);
