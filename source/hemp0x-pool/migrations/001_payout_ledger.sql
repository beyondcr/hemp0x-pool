CREATE TABLE IF NOT EXISTS payout_runs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at            INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'planned',
    block_height_start    INTEGER,
    block_height_end      INTEGER,
    total_blocks          INTEGER NOT NULL DEFAULT 0,
    total_miners          INTEGER NOT NULL DEFAULT 0,
    total_amount_sats     INTEGER NOT NULL DEFAULT 0,
    fee_amount_sats       INTEGER NOT NULL DEFAULT 0,
    net_amount_sats       INTEGER NOT NULL DEFAULT 0,
    error                 TEXT,
    completed_at          INTEGER
);

CREATE TABLE IF NOT EXISTS payout_block_credits (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            INTEGER NOT NULL REFERENCES payout_runs(id),
    height            INTEGER NOT NULL,
    hash              TEXT NOT NULL,
    finder            TEXT NOT NULL,
    mode              TEXT NOT NULL DEFAULT 'pool',
    reward_sats       INTEGER NOT NULL,
    fee_deducted_sats INTEGER NOT NULL,
    finder_bonus_sats INTEGER NOT NULL,
    remainder_sats    INTEGER NOT NULL,
    miner_count       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(run_id, height)
);

CREATE TABLE IF NOT EXISTS payout_miner_credits (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    block_credit_id   INTEGER NOT NULL REFERENCES payout_block_credits(id),
    miner             TEXT NOT NULL,
    category          TEXT NOT NULL CHECK(category IN ('finder','pool','finder_fallback')),
    amount_sats       INTEGER NOT NULL,
    UNIQUE(block_credit_id, miner, category)
);

CREATE TABLE IF NOT EXISTS payout_batches (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            INTEGER NOT NULL REFERENCES payout_runs(id),
    batch_index       INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'created',
    txid              TEXT,
    output_count      INTEGER NOT NULL DEFAULT 0,
    total_amount_sats INTEGER NOT NULL DEFAULT 0,
    fee_estimate_sats INTEGER,
    created_at        INTEGER NOT NULL,
    broadcast_at      INTEGER,
    confirmed_at      INTEGER,
    error             TEXT,
    UNIQUE(run_id, batch_index)
);

CREATE TABLE IF NOT EXISTS payout_batch_outputs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id          INTEGER NOT NULL REFERENCES payout_batches(id),
    address           TEXT NOT NULL,
    amount_sats       INTEGER NOT NULL,
    category          TEXT NOT NULL DEFAULT 'pool',
    UNIQUE(batch_id, address, category)
);

CREATE TABLE IF NOT EXISTS payout_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            INTEGER REFERENCES payout_runs(id),
    batch_id          INTEGER REFERENCES payout_batches(id),
    event_type        TEXT NOT NULL,
    detail            TEXT,
    created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payout_runs_status ON payout_runs(status);
CREATE INDEX IF NOT EXISTS idx_payout_block_credits_run ON payout_block_credits(run_id);
CREATE INDEX IF NOT EXISTS idx_payout_block_credits_height ON payout_block_credits(height);
CREATE INDEX IF NOT EXISTS idx_payout_miner_credits_block ON payout_miner_credits(block_credit_id);
CREATE INDEX IF NOT EXISTS idx_payout_miner_credits_miner ON payout_miner_credits(miner);
CREATE INDEX IF NOT EXISTS idx_payout_batches_run ON payout_batches(run_id);
CREATE INDEX IF NOT EXISTS idx_payout_batches_status ON payout_batches(status);
CREATE INDEX IF NOT EXISTS idx_payout_batch_outputs_batch ON payout_batch_outputs(batch_id);
CREATE INDEX IF NOT EXISTS idx_payout_events_run ON payout_events(run_id);
