CREATE TABLE IF NOT EXISTS consolidation_plans (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id               TEXT UNIQUE NOT NULL,
    created_at            INTEGER NOT NULL,
    status                TEXT NOT NULL CHECK(status IN ('draft','approved','rejected','completed','partial','failed')),
    operator_approved_by  TEXT,
    operator_approved_at  INTEGER,
    config_snapshot       TEXT NOT NULL,
    total_batches         INTEGER NOT NULL DEFAULT 0,
    total_inputs          INTEGER NOT NULL DEFAULT 0,
    total_input_sats      INTEGER NOT NULL DEFAULT 0,
    total_fee_sats        INTEGER NOT NULL DEFAULT 0,
    destination_address   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consolidation_batches (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id                TEXT UNIQUE NOT NULL,
    plan_id                 TEXT NOT NULL,
    batch_index             INTEGER NOT NULL,
    status                  TEXT NOT NULL CHECK(status IN ('draft','approved','broadcasting','broadcasted','confirmed','failed','abandoned')),
    created_at              INTEGER NOT NULL,
    broadcast_at            INTEGER,
    confirmed_at            INTEGER,
    destination_address     TEXT NOT NULL,
    total_input_sats        INTEGER NOT NULL DEFAULT 0,
    estimated_fee_sats      INTEGER NOT NULL DEFAULT 0,
    actual_fee_sats         INTEGER,
    estimated_tx_size_bytes INTEGER NOT NULL DEFAULT 0,
    raw_tx_hex              TEXT,
    txid                    TEXT,
    confirmations           INTEGER DEFAULT 0,
    error_message           TEXT,
    retry_count             INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (plan_id) REFERENCES consolidation_plans(plan_id)
);

CREATE TABLE IF NOT EXISTS consolidation_batch_inputs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT NOT NULL,
    txid          TEXT NOT NULL,
    vout          INTEGER NOT NULL,
    amount_sats   INTEGER NOT NULL,
    confirmations INTEGER NOT NULL,
    address       TEXT NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES consolidation_batches(batch_id)
);

CREATE TABLE IF NOT EXISTS consolidation_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id           TEXT,
    batch_id          TEXT,
    event_type        TEXT NOT NULL CHECK(event_type IN ('plan_created','operator_approved','operator_rejected','broadcast_attempted','broadcast_succeeded','broadcast_failed','confirmation_update','abandoned','retry_scheduled')),
    event_at          INTEGER NOT NULL,
    details           TEXT,
    operator_context  TEXT
);

CREATE INDEX IF NOT EXISTS idx_consolidation_batches_plan_id ON consolidation_batches(plan_id);
CREATE INDEX IF NOT EXISTS idx_consolidation_batches_status ON consolidation_batches(status);
CREATE INDEX IF NOT EXISTS idx_consolidation_batch_inputs_batch_id ON consolidation_batch_inputs(batch_id);
CREATE INDEX IF NOT EXISTS idx_consolidation_events_plan_id ON consolidation_events(plan_id);
CREATE INDEX IF NOT EXISTS idx_consolidation_events_batch_id ON consolidation_events(batch_id);
