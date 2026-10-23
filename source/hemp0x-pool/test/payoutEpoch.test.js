const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const path = require('path');
const { MigrationRunner } = require('../migrations');
const { PayoutLedger } = require('../payoutLedger');
const { startPayoutEpoch, getActivePayoutEpoch } = require('../payoutEpoch');

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
}
function all(db, sql) {
  return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
}
async function setup(t) {
  const db = new sqlite3.Database(':memory:');
  t.after(() => new Promise(resolve => db.close(resolve)));
  await new MigrationRunner(db, path.resolve(__dirname, '../migrations')).applyMigrations();
  await exec(db, `CREATE TABLE blocks(height INTEGER PRIMARY KEY, mode TEXT, paid INTEGER, status TEXT);
    INSERT INTO blocks VALUES(100,'pool',0,'confirmed'),(102,'pool',0,'confirmed');
    CREATE TABLE payouts(id INTEGER PRIMARY KEY, txid TEXT);
    INSERT INTO payouts VALUES(1,'historical-payment');
    CREATE TABLE reward_balances(miner TEXT PRIMARY KEY, pool_amount REAL);`);
  return { db, ledger: new PayoutLedger(db) };
}
function reset(db, overrides = {}) {
  return startPayoutEpoch({ db, startHeight: 100, startHash: 'a'.repeat(64), walletAddress: 'wallet', now: 1000, ...overrides });
}
async function credit(ledger, runId, height = 102, hash = 'b'.repeat(64)) {
  return ledger.createBlockCredit({ runId, height, hash, finder: 'miner', rewardSats: 1000000000,
    feeDeductedSats: 0, finderBonusSats: 200000000, remainderSats: 800000000, minerCount: 1 });
}

test('reset archives old claims and starts empty without erasing evidence', async t => {
  const { db, ledger } = await setup(t);
  const oldRun = await ledger.createRun({});
  await credit(ledger, oldRun.id, 100);
  await reset(db);
  assert.equal((await getActivePayoutEpoch(db)).start_height, 100);
  assert.equal((await all(db, 'SELECT * FROM payout_runs')).length, 0);
  assert.equal((await all(db, 'SELECT * FROM archive_payout_1000_payout_runs')).length, 1);
  assert.equal((await all(db, 'SELECT * FROM archive_payout_1000_payout_block_credits')).length, 1);
  assert.equal((await all(db, 'SELECT * FROM archive_payout_1000_payouts'))[0].txid, 'historical-payment');
  assert.equal((await all(db, 'SELECT * FROM payouts')).length, 0);
  assert.equal((await all(db, 'SELECT status FROM blocks WHERE height=100'))[0].status, 'archived');
  assert.equal((await all(db, 'SELECT status FROM blocks WHERE height=102'))[0].status, 'confirmed');
  assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
});

test('one source cannot fund another run even if the first run failed', async t => {
  const { db, ledger } = await setup(t);
  await reset(db);
  const first = await ledger.createRun({});
  await credit(ledger, first.id);
  await ledger.updateRunStatus(first.id, 'failed');
  const second = await ledger.createRun({});
  await assert.rejects(credit(ledger, second.id), /UNIQUE/);
  assert.equal((await ledger.getBlockCreditsForRun(second.id)).length, 0);
  assert.equal((await all(db, 'SELECT * FROM payout_source_claims')).length, 1);
});

test('old sources stay excluded and claims cannot be edited or released', async t => {
  const { db, ledger } = await setup(t);
  await reset(db);
  const run = await ledger.createRun({});
  await assert.rejects(credit(ledger, run.id, 100), /predates/);
  await credit(ledger, run.id);
  await assert.rejects(exec(db, 'UPDATE payout_block_credits SET height=103'), /immutable/);
  await assert.rejects(exec(db, 'DELETE FROM payout_source_claims'), /cannot be released/);
});

test('uncertain broadcasts abort the reset without changing the ledger', async t => {
  const { db, ledger } = await setup(t);
  const run = await ledger.createRun({});
  const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 1000, outputCount: 1 });
  await ledger.updateBatchStatus(batch.id, 'broadcast_unknown');
  await assert.rejects(reset(db), /uncertain broadcasts/);
  assert.equal((await ledger.getRun(run.id)).id, run.id);
  assert.equal(await getActivePayoutEpoch(db), null);
});
