const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('node:path');
const { PayoutLedger } = require('../payoutLedger');
const { PayoutWorker } = require('../payoutWorker');
const { MigrationRunner } = require('../migrations');
const { TEST_ADDRESSES } = require('./addressFixtures');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');
const addr = TEST_ADDRESSES.miner1;
let db;
let ledger;

function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
}

async function fixture({ amount = 100, outputs = [100], includeCredits = true } = {}) {
  const runRow = await ledger.createRun({ blockHeightStart: 120, blockHeightEnd: 120, totalBlocks: 1, totalMiners: 1, totalAmountSats: amount, feeAmountSats: 0, netAmountSats: amount });
  const batch = await ledger.createBatch({ runId: runRow.id, batchIndex: 0, totalAmountSats: amount, outputCount: outputs.length });
  for (const [index, value] of outputs.entries()) await ledger.createBatchOutput({ batchId: batch.id, address: addr, amountSats: value, category: index ? 'finder' : 'pool' });
  if (includeCredits) {
    const credit = await ledger.createBlockCredit({ runId: runRow.id, height: 120, hash: 'sourcehash', finder: addr, mode: 'pool', rewardSats: amount, feeDeductedSats: 0, finderBonusSats: 0, remainderSats: amount, minerCount: 1 });
    await ledger.createMinerCredit({ blockCreditId: credit.id, miner: addr, category: 'pool', amountSats: amount });
  }
  return { run: runRow, batch };
}

async function attempt(options) {
  let sends = 0;
  const { run: runRow } = await fixture(options);
  const worker = new PayoutWorker({
    db, ledger,
    config: { payout: { dryRun: false }, automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true }, pool: {} },
    rpc: async (method) => { if (method === 'sendmany') sends++; return { balance: 1 }; },
  });
  const result = await worker.processRun(runRow.id);
  assert.equal(sends, 0);
  assert.equal(result.processed, false);
  return result;
}

describe('payout live preflight safety', () => {
  beforeEach(async () => {
    db = new sqlite3.Database(':memory:');
    await new MigrationRunner(db, migrationsDir).applyMigrations();
    ledger = new PayoutLedger(db);
  });
  afterEach(async () => new Promise((resolve) => db.close(resolve)));

  it('uses full durability on the financial connection before live processing', async () => {
    await run('PRAGMA synchronous = NORMAL');
    const worker = new PayoutWorker({ db, ledger,
      config: { payout: { dryRun: false }, automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true } } });
    await worker.processRun(99999);
    const mode = await new Promise((resolve, reject) => db.get('PRAGMA synchronous', (error, row) => error ? reject(error) : resolve(row)));
    assert.equal(mode.synchronous, 2);
  });

  it('rejects a batch output total that differs from its recorded batch total', async () => {
    const result = await attempt({ amount: 101, outputs: [100] });
    assert.equal(result.error, 'batch_total_mismatch');
  });

  it('rejects duplicate recipient rows rather than collapsing them in sendmany', async () => {
    const result = await attempt({ amount: 200, outputs: [100, 100] });
    assert.equal(result.error, 'duplicate_payout_recipient');
  });

  it('requires nonempty verifiable source credits', async () => {
    const result = await attempt({ includeCredits: false });
    assert.equal(result.error, 'source_credits_missing');
  });

  it('refuses a otherwise valid live run when no active payout epoch exists', async () => {
    const { run: runRow } = await fixture();
    let sends = 0;
    const worker = new PayoutWorker({
      db, ledger,
      config: { payout: { dryRun: false }, automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true }, pool: {} },
      rpc: async (method) => { if (method === 'sendmany') sends++; return { balance: 1 }; },
    });
    const result = await worker.processRun(runRow.id);
    assert.equal(result.error, 'payout_epoch_required');
    assert.equal(sends, 0);
  });

  it('rejects outputs exceeding the aggregate source miner credits', async () => {
    const { run: runRow, batch } = await fixture({ amount: 100, outputs: [100] });
    await run('UPDATE payout_miner_credits SET amount_sats = 99 WHERE block_credit_id IN (SELECT id FROM payout_block_credits WHERE run_id = ?)', [runRow.id]);
    const worker = new PayoutWorker({ db, ledger, config: { payout: { dryRun: false }, automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true } }, rpc: async () => ({ balance: 1 }) });
    const result = await worker.processRun(runRow.id);
    assert.equal(result.error, 'source_block_conservation_mismatch');
    assert.equal((await ledger.getBatch(batch.id)).status, 'created');
  });

  it('rejects inflated miner credits, outputs, and run net above the actual block net reward', async () => {
    const { run: runRow } = await fixture({ amount: 200, outputs: [200] });
    await run('UPDATE payout_block_credits SET reward_sats = 100, remainder_sats = 100 WHERE run_id = ?', [runRow.id]);
    let sends = 0;
    const worker = new PayoutWorker({
      db, ledger,
      config: { payout: { dryRun: false }, automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true } },
      rpc: async (method) => { if (method === 'sendmany') sends++; return method === 'getwalletinfo' ? { balance: 1 } : 'unexpected'; },
    });
    const result = await worker.processRun(runRow.id);
    assert.equal(result.error, 'source_block_conservation_mismatch');
    assert.equal(sends, 0);
  });

  it('rejects an active-epoch claim whose hash does not match the source credit', async () => {
    await run(`CREATE TABLE blocks (
      height INTEGER PRIMARY KEY, hash TEXT, reward REAL, mode TEXT, payout_address TEXT, status TEXT
    )`);
    await run('INSERT INTO payout_epochs (start_height, start_hash, wallet_address, created_at, active) VALUES (100, ?, ?, 1, 1)', ['start-hash', addr]);
    await run("INSERT INTO blocks (height, hash, reward, mode, payout_address, status) VALUES (120, 'sourcehash', 0.000001, 'pool', ?, 'confirmed')", [addr]);
    const { run: runRow } = await fixture();
    await run("UPDATE payout_source_claims SET hash = 'alteredhash' WHERE run_id = ?", [runRow.id]);
    let sends = 0;
    const worker = new PayoutWorker({
      db, ledger,
      config: { payout: { dryRun: false }, automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true }, pool: { wallet: addr } },
      rpc: async (method) => { if (method === 'sendmany') sends++; return { balance: 1 }; },
    });
    const result = await worker.processRun(runRow.id);
    assert.equal(result.error, 'payout_epoch_claim_mismatch');
    assert.equal(sends, 0);
  });
});
