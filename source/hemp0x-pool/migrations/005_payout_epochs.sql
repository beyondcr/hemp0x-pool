CREATE TABLE IF NOT EXISTS payout_epochs (
    id INTEGER PRIMARY KEY,
    start_height INTEGER NOT NULL,
    start_hash TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_epoch_active
    ON payout_epochs(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS payout_source_claims (
    height INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    run_id INTEGER NOT NULL REFERENCES payout_runs(id),
    epoch_id INTEGER NOT NULL REFERENCES payout_epochs(id)
);

CREATE TRIGGER IF NOT EXISTS payout_claim_source
BEFORE INSERT ON payout_block_credits
WHEN EXISTS (SELECT 1 FROM payout_epochs WHERE active = 1)
BEGIN
    SELECT CASE WHEN NEW.height <= (SELECT start_height FROM payout_epochs WHERE active = 1)
        THEN RAISE(ABORT, 'Source block predates the active payout epoch') END;
    INSERT INTO payout_source_claims(height, hash, run_id, epoch_id)
        SELECT NEW.height, NEW.hash, NEW.run_id, id FROM payout_epochs WHERE active = 1;
END;

CREATE TRIGGER IF NOT EXISTS payout_immutable_source
BEFORE UPDATE ON payout_block_credits
WHEN EXISTS (SELECT 1 FROM payout_epochs WHERE active = 1)
BEGIN
    SELECT RAISE(ABORT, 'Payout source credits are immutable');
END;

CREATE TRIGGER IF NOT EXISTS payout_immutable_claim
BEFORE DELETE ON payout_source_claims
BEGIN
    SELECT RAISE(ABORT, 'Payout source claims cannot be released automatically');
END;
