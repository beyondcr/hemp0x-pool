CREATE TABLE IF NOT EXISTS pplns_windows (
    block_height INTEGER NOT NULL,
    miner TEXT NOT NULL,
    total_difficulty REAL NOT NULL,
    share_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (block_height, miner)
);

CREATE INDEX IF NOT EXISTS idx_pplns_windows_block_height ON pplns_windows(block_height);
