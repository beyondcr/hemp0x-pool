const fs = require('fs');
const path = require('path');

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

async function getActivePayoutEpoch(db) {
  const exists = await get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payout_epochs'");
  if (!exists) return null;
  return (await get(db, 'SELECT * FROM payout_epochs WHERE active = 1')) || null;
}

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => error ? reject(error) : resolve());
  });
}

function quoteIdentifier(value) {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function startPayoutEpoch({ db, startHeight, startHash, walletAddress, now = Date.now() }) {
  if (!Number.isSafeInteger(startHeight) || startHeight < 0 ||
      !/^[a-fA-F0-9]{64}$/.test(startHash) || typeof walletAddress !== 'string' || !walletAddress) {
    throw new Error('Invalid payout epoch boundary');
  }
  const prefix = `archive_payout_${now}_`;
  const tables = [
    'payout_runs', 'payout_block_credits', 'payout_miner_credits',
    'payout_batches', 'payout_batch_outputs', 'payout_events',
    'payout_source_claims', 'payout_epochs', 'payouts', 'reward_balances',
  ];
  const migrations = path.join(__dirname, 'migrations');
  await exec(db, 'BEGIN IMMEDIATE');
  try {
    const unresolved = await get(db,
      "SELECT COUNT(*) AS count FROM payout_batches WHERE status IN ('broadcasting','broadcast_unknown')");
    if (unresolved.count) throw new Error('Resolve uncertain broadcasts before starting a payout epoch');
    const crossing = await get(db,
      `SELECT 1 FROM payout_block_credits bc JOIN payout_batches pb ON pb.run_id=bc.run_id
       WHERE bc.height>? AND pb.status IN ('broadcasted','confirmed') LIMIT 1`, [startHeight]);
    if (crossing) throw new Error('Boundary overlaps previously broadcast source rewards');
    const locked = await get(db,
      "SELECT lock_name FROM process_locks WHERE lock_name LIKE 'payout_%' AND expires_at > ?", [now]);
    if (locked) throw new Error('Payout worker still holds a live lock; stop it before resetting');

    const legacySchemas = [];
    await exec(db, 'DROP TRIGGER IF EXISTS payout_claim_source; DROP TRIGGER IF EXISTS payout_immutable_source; DROP TRIGGER IF EXISTS payout_immutable_claim;');
    for (const table of tables) {
      const existing = await get(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table]);
      if (!existing) continue;
      if (table === 'payouts' || table === 'reward_balances') legacySchemas.push(existing.sql);
      const indexes = await all(db,
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", [table]);
      for (const index of indexes) await exec(db, `DROP INDEX ${quoteIdentifier(index.name)}`);
      await exec(db, `ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(prefix + table)}`);
    }
    await exec(db, fs.readFileSync(path.join(migrations, '001_payout_ledger.sql'), 'utf8'));
    await exec(db, fs.readFileSync(path.join(migrations, '005_payout_epochs.sql'), 'utf8'));
    for (const schema of legacySchemas) await exec(db, schema);
    await run(db, 'INSERT INTO payout_epochs(start_height,start_hash,wallet_address,created_at,active) VALUES(?,?,?,?,1)',
      [startHeight, startHash, walletAddress, now]);
    // Preserve old source records without allowing them back into settlement.
    await run(db,
      "UPDATE blocks SET status='archived' WHERE mode='pool' AND paid=0 AND height<=? AND status IN ('pending','confirmed')",
      [startHeight]);
    await run(db, "DELETE FROM process_locks WHERE lock_name LIKE 'payout_%' AND expires_at<=?", [now]);
    await run(db, 'INSERT INTO payout_events(event_type,detail,created_at) VALUES(?,?,?)',
      ['epoch_started', JSON.stringify({ startHeight, startHash, archivePrefix: prefix }), now]);
    await exec(db, 'COMMIT');
    return { startHeight, startHash, archivePrefix: prefix };
  } catch (error) {
    await exec(db, 'ROLLBACK');
    throw error;
  }
}

module.exports = { getActivePayoutEpoch, startPayoutEpoch };
