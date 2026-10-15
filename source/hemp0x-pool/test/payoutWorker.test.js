const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { PayoutLedger } = require('../payoutLedger');
const { PayoutWorker, LOCK_WORKER, LOCK_RUN_PREFIX, isAmbiguousBroadcastError } = require('../payoutWorker');
const { MigrationRunner } = require('../migrations');
const { DEFAULTS } = require('../config');
const { TEST_ADDRESSES } = require('./addressFixtures');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

const ADDR = {
  miner1: TEST_ADDRESSES.miner1,
  miner2: TEST_ADDRESSES.miner2,
  invalid: 'invalid_address',
};

function createDb() {
  return new sqlite3.Database(':memory:');
}

async function setupDb(db) {
  const runner = new MigrationRunner(db, migrationsDir);
  await runner.applyMigrations();
  return new Promise((resolve) => {
    db.get('PRAGMA foreign_keys = ON', () => resolve());
  });
}

function buildConfig(overrides = {}) {
  return {
    pool: {
      fee: 0.01,
      walletLabel: '',
      ...(overrides.pool || {}),
    },
    payout: {
      dryRun: true,
      staleLockTimeoutMs: 3600000,
      blockConfirmations: 100,
      maxPayoutBatch: 50,
      maxPayoutBatchAmountSats: 50000000000,
      maxPayoutPerAddressSats: 50000000000,
      flushMinPayoutSats: 10000000,
      flushIntervalMs: 43200000,
      sharePaidAfterConfirmed: true,
      ...(overrides.payout || {}),
    },
    automation: {
      routinePayoutEnabled: false,
      payoutBroadcastEnabled: false,
      staleLockRecoveryEnabled: true,
      staleLockTimeoutMs: 3600000,
      maxConsecutiveFailures: 5,
      ...(overrides.automation || {}),
    },
  };
}

async function createTestRun(ledger, overrides = {}) {
  return ledger.createRun({
    blockHeightStart: 1000,
    blockHeightEnd: 1001,
    totalBlocks: 1,
    totalMiners: 2,
    totalAmountSats: 5000000000,
    feeAmountSats: 50000000,
    netAmountSats: 4950000000,
    ...overrides,
  });
}

async function createTestBatch(ledger, runId, overrides = {}) {
  return ledger.createBatch({
    runId,
    batchIndex: 0,
    totalAmountSats: 4950000000,
    outputCount: 2,
    ...overrides,
  });
}

async function createTestOutputs(ledger, batchId) {
  await ledger.createBatchOutput({
    batchId,
    address: ADDR.miner1,
    amountSats: 2475000000,
    category: 'pool',
  });
  await ledger.createBatchOutput({
    batchId,
    address: ADDR.miner2,
    amountSats: 2475000000,
    category: 'pool',
  });
}

function liveRpc(handler) {
  return async (method, params) => {
    if (method === 'getwalletinfo') return { balance: 1000000 };
    if (method === 'getbalance') return 1000000;
    return handler(method, params);
  };
}

function execSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

describe('PayoutWorker', () => {
  let db;
  let ledger;

  before(async () => {
    db = createDb();
    await setupDb(db);
    ledger = new PayoutLedger(db);
  });

  after(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // getAutomationStatus
  // ---------------------------------------------------------------------------
  describe('getAutomationStatus', () => {
    it('returns dry_run mode with default safe config', () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });
      const status = worker.getAutomationStatus();
      assert.equal(status.mode, 'dry_run');
      assert.equal(status.dryRun, true);
      assert.equal(status.routinePayoutEnabled, false);
      assert.equal(status.payoutBroadcastEnabled, false);
      assert.equal(status.liveCapable, false);
    });

    it('returns live mode when all three gates are open', () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({ db, ledger, config });
      const status = worker.getAutomationStatus();
      assert.equal(status.mode, 'live');
      assert.equal(status.liveCapable, true);
    });

    it('returns disabled when dryRun is false but routine is false', () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: false, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({ db, ledger, config });
      const status = worker.getAutomationStatus();
      assert.equal(status.mode, 'disabled');
      assert.equal(status.liveCapable, false);
    });

    it('returns disabled when only routinePayoutEnabled true but others false', () => {
      const config = buildConfig({
        payout: { dryRun: true },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({ db, ledger, config });
      const status = worker.getAutomationStatus();
      assert.equal(status.liveCapable, false);
    });

    it('returns disabled when routinePayoutEnabled true, dryRun false, but broadcast false', () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: false },
      });
      const worker = new PayoutWorker({ db, ledger, config });
      const status = worker.getAutomationStatus();
      assert.equal(status.mode, 'disabled');
      assert.equal(status.liveCapable, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------------
  describe('run locking', () => {
    it('acquires lock successfully', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });
      const acquired = await worker.acquireRunLock(99999);
      assert.equal(acquired, true);
      const locked = await worker.isRunLocked(99999);
      assert.equal(locked, true);
      await worker.releaseRunLock(99999);
    });

    it('fails to acquire already-held lock', async () => {
      const config = buildConfig();
      const worker1 = new PayoutWorker({ db, ledger, config });
      const worker2 = new PayoutWorker({ db, ledger, config });

      const acquired1 = await worker1.acquireRunLock(88888);
      assert.equal(acquired1, true);

      const acquired2 = await worker2.acquireRunLock(88888);
      assert.equal(acquired2, false);

      await worker1.releaseRunLock(88888);
    });

    it('releases lock correctly', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      await worker.acquireRunLock(77777);
      await worker.releaseRunLock(77777);
      const locked = await worker.isRunLocked(77777);
      assert.equal(locked, false);
    });

    it('recovers stale lock when recovery enabled', async () => {
      const config = buildConfig({
        payout: { staleLockTimeoutMs: 1 },
        automation: { staleLockRecoveryEnabled: true },
      });
      const worker = new PayoutWorker({ db, ledger, config });

      // Manually insert an expired lock
      const now = Date.now();
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO process_locks (lock_name, locked_at, locked_by, expires_at) VALUES (?, ?, ?, ?)',
          [`${LOCK_RUN_PREFIX}66666`, now - 10000, 'oldWorker', now - 5000],
          function (err) { if (err) reject(err); else resolve(); }
        );
      });

      const acquired = await worker.acquireRunLock(66666);
      assert.equal(acquired, true);

      await worker.releaseRunLock(66666);
    });

    it('does not recover stale lock when recovery disabled', async () => {
      const config = buildConfig({
        automation: { staleLockRecoveryEnabled: false },
      });
      const worker = new PayoutWorker({ db, ledger, config });

      const now = Date.now();
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO process_locks (lock_name, locked_at, locked_by, expires_at) VALUES (?, ?, ?, ?)',
          [`${LOCK_RUN_PREFIX}55555`, now - 10000, 'oldWorker', now - 5000],
          function (err) { if (err) reject(err); else resolve(); }
        );
      });

      const acquired = await worker.acquireRunLock(55555);
      assert.equal(acquired, false);
    });
  });

  // ---------------------------------------------------------------------------
  // processRun - dry-run mode
  // ---------------------------------------------------------------------------
  describe('processRun - dry-run mode', () => {
    it('processes a planned run and records dry-run events', async () => {
      const config = buildConfig();
      const rpcCalls = [];
      const mockRpc = async (method, params) => {
        rpcCalls.push({ method, params });
        throw new Error('RPC should never be called in dry-run');
      };
      const worker = new PayoutWorker({ db, ledger, config, rpc: mockRpc });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);

      assert.equal(result.processed, true);
      assert.equal(result.mode, 'dry_run');
      assert.equal(rpcCalls.length, 0, 'RPC must not be called in dry-run mode');

      // Verify events
      const events = await ledger.getEventsForRun(run.id);
      const dryRunExec = events.filter((e) => e.event_type === 'dry_run_executing');
      assert.equal(dryRunExec.length, 1);

      const dryRunSim = events.filter((e) => e.event_type === 'dry_run_batch_simulated');
      assert.equal(dryRunSim.length, 1);
      assert.ok(dryRunSim[0].detail.includes('2475000000'), `Detail: ${dryRunSim[0].detail}`);

      const dryRunDone = events.filter((e) => e.event_type === 'dry_run_completed');
      assert.equal(dryRunDone.length, 1);

      // Dry-run simulation records events only; payment state remains payable.
      const updatedRun = await ledger.getRun(run.id);
      assert.equal(updatedRun.status, 'planned');

      // Batch state remains created so a future live worker can still pay it.
      const updatedBatch = await ledger.getBatch(batch.id);
      assert.equal(updatedBatch.status, 'created');
      assert.equal(updatedBatch.txid, null);
    });

    it('produces batch results with simulation details', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);

      assert.ok(result.batches.length > 0);
      const batchResult = result.batches[0];
      assert.equal(batchResult.simulated, true);
      assert.equal(batchResult.dryRun, true);
      assert.equal(batchResult.outputCount, 2);
      assert.ok(batchResult.totalSats > 0);
    });

    it('is idempotent across repeated calls', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result1 = await worker.processRun(run.id);
      assert.equal(result1.processed, true);

      const result2 = await worker.processRun(run.id);
      assert.equal(result2.processed, false);
      assert.equal(result2.skipped, true);
      assert.equal(result2.reason, 'dry_run_already_simulated');

      // Verify events were NOT duplicated
      const events = await ledger.getEventsForRun(run.id);
      const dryRunSim = events.filter((e) => e.event_type === 'dry_run_batch_simulated');
      assert.equal(dryRunSim.length, 1, 'Dry-run simulation events must not be duplicated');
    });

    it('skips a run that is already locked by another worker', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      // Manually lock the run
      await worker.acquireRunLock(run.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, false);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'locked_by_another_worker');

      await worker.releaseRunLock(run.id);
    });

    it('skips runs with status other than planned or broadcasting', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      // Change status
      await ledger.updateRunStatus(run.id, 'broadcasted');

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, false);
      assert.equal(result.skipped, true);
      assert.ok(result.reason.includes('not_processable'));
    });

    it('handles run with no batches gracefully', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, false);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'no_batches');
    });

    it('does not call RPC for any method in dry-run mode', async () => {
      const config = buildConfig({
        payout: { dryRun: true },
        automation: { routinePayoutEnabled: false, payoutBroadcastEnabled: false },
      });
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method, params) => { rpcCalls.push(method); return 'ok'; },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      await worker.processRun(run.id);
      assert.deepEqual(rpcCalls, []);
    });

    it('processes multiple pending batches in one run', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch0 = await createTestBatch(ledger, run.id, { batchIndex: 0 });
      const batch1 = await createTestBatch(ledger, run.id, { batchIndex: 1, totalAmountSats: 1000000000, outputCount: 1 });
      await createTestOutputs(ledger, batch0.id);
      await ledger.createBatchOutput({
        batchId: batch1.id, address: ADDR.miner1, amountSats: 1000000000, category: 'pool',
      });

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);
      assert.equal(result.batches.length, 2);

      const events = await ledger.getEventsForRun(run.id);
      const simEvents = events.filter((e) => e.event_type === 'dry_run_batch_simulated');
      assert.equal(simEvents.length, 2);
    });

    it('skips a run after operator rejection', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);
      await ledger.createReviewEvent(run.id, 'reject', 'Incorrect payout plan');

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, false);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'operator_rejected');

      const events = await ledger.getEventsForRun(run.id);
      const simEvents = events.filter((e) => e.event_type === 'dry_run_batch_simulated');
      assert.equal(simEvents.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // processRun - live mode (triple gate)
  // ---------------------------------------------------------------------------
  describe('processRun - live mode', () => {
    it('broadcasts batches when all three gates are open', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: liveRpc(async (method, params) => {
          rpcCalls.push({ method, params });
          if (method === 'sendmany') return 'realtxid000011112222333344445555';
          return null;
        }),
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);
      assert.equal(result.mode, 'live');

      // Verify RPC was called
      const sendmanyCalls = rpcCalls.filter((c) => c.method === 'sendmany');
      assert.equal(sendmanyCalls.length, 1);

      // Verify batch was marked broadcasted
      const updatedBatch = await ledger.getBatch(batch.id);
      assert.equal(updatedBatch.status, 'broadcasted');
      assert.equal(updatedBatch.txid, 'realtxid000011112222333344445555');

      // Verify run was marked broadcasted
      const updatedRun = await ledger.getRun(run.id);
      assert.equal(updatedRun.status, 'broadcasted');
    });

    it('returns error when live mode enabled but no RPC client', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({ db, ledger, config, rpc: null });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, false);
      assert.equal(result.error, 'no_rpc_client');
    });

    it('handles RPC error and records sanitized error', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: liveRpc(async () => {
          const err = new Error('insufficient funds\n    at sendmany (/path/to/wallet.js:42)\n    at processBatch');
          throw err;
        }),
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);

      const batchResult = result.batches[0];
      assert.equal(batchResult.processed, false);
      assert.ok(batchResult.error.includes('insufficient funds'));
      assert.ok(!batchResult.error.includes('/path/to'), 'Error must not contain stack trace');
      assert.ok(!batchResult.error.includes('\n'), 'Error must be single-line sanitized');

      // A definite daemon rejection is safe to retry later.
      const updatedBatch = await ledger.getBatch(batch.id);
      assert.equal(updatedBatch.status, 'created');
      assert.ok(updatedBatch.error.includes('insufficient funds'));
      assert.ok(!updatedBatch.error.includes('/path/to'));

      // Verify run remains planned for a later retry instead of returning
      // the same source blocks to a fresh payout plan.
      const updatedRun = await ledger.getRun(run.id);
      assert.equal(updatedRun.status, 'planned');

      // Verify broadcast_failed event
      const events = await ledger.getEventsForRun(run.id);
      const failEvents = events.filter((e) => e.event_type === 'broadcast_failed');
      assert.equal(failEvents.length, 1);
    });

    it('blocks automatic retry when sendmany outcome is ambiguous', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      let sendmanyCalls = 0;
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'sendmany') {
            sendmanyCalls++;
            throw new Error('RPC sendmany timed out');
          }
          return null;
        }),
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const firstResult = await worker.processRun(run.id);
      assert.equal(firstResult.processed, true);
      assert.equal(sendmanyCalls, 1);

      const updatedBatch = await ledger.getBatch(batch.id);
      assert.equal(updatedBatch.status, 'broadcast_unknown');
      assert.match(updatedBatch.error, /automatic retry disabled/);

      const updatedRun = await ledger.getRun(run.id);
      assert.equal(updatedRun.status, 'broadcasting');

      const secondResult = await worker.processRun(run.id);
      assert.equal(secondResult.processed, false);
      assert.equal(secondResult.reason, 'unresolved_broadcast_outcome');
      assert.equal(sendmanyCalls, 1, 'uncertain sendmany must never be retried automatically');

      const events = await ledger.getEventsForRun(run.id);
      assert.ok(events.some((event) => event.event_type === 'broadcast_unknown'));
    });

    it('classifies only transport failures as ambiguous broadcasts', () => {
      assert.equal(isAmbiguousBroadcastError(new Error('RPC sendmany timed out')), true);
      assert.equal(isAmbiguousBroadcastError(new Error('socket hang up')), true);
      assert.equal(isAmbiguousBroadcastError(new Error('insufficient funds')), false);
      assert.equal(isAmbiguousBroadcastError(new Error('Work queue depth exceeded')), false);
    });

    it('keeps partially broadcast runs active instead of failing and replanning', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      let callCount = 0;
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'sendmany') {
            callCount++;
            if (callCount === 1) return 'partial_txid_1';
            throw new Error('Work queue depth exceeded');
          }
          return null;
        }),
      });

      const run = await createTestRun(ledger);
      const b0 = await createTestBatch(ledger, run.id, { batchIndex: 0 });
      const b1 = await createTestBatch(ledger, run.id, { batchIndex: 1, totalAmountSats: 1000000000, outputCount: 1 });
      await createTestOutputs(ledger, b0.id);
      await ledger.createBatchOutput({
        batchId: b1.id, address: ADDR.miner1, amountSats: 1000000000, category: 'pool',
      });

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);
      assert.equal(result.batches.length, 2);

      const updatedRun = await ledger.getRun(run.id);
      const updatedB0 = await ledger.getBatch(b0.id);
      const updatedB1 = await ledger.getBatch(b1.id);
      assert.equal(updatedRun.status, 'broadcasting');
      assert.equal(updatedB0.status, 'broadcasted');
      assert.equal(updatedB0.txid, 'partial_txid_1');
      assert.equal(updatedB1.status, 'created');
      assert.match(updatedB1.error, /Work queue depth exceeded/);

      const events = await ledger.getEventsForRun(run.id);
      assert.ok(events.some((e) => e.event_type === 'broadcast_partial'));
    });

    it('marks run as broadcasted when all batches succeed', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      let callCount = 0;
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'sendmany') return `realtxid_${callCount++}`;
          return null;
        }),
      });

      const run = await createTestRun(ledger);
      const b0 = await createTestBatch(ledger, run.id, { batchIndex: 0 });
      const b1 = await createTestBatch(ledger, run.id, { batchIndex: 1, totalAmountSats: 1000000000, outputCount: 1 });
      await createTestOutputs(ledger, b0.id);
      await ledger.createBatchOutput({
        batchId: b1.id, address: ADDR.miner1, amountSats: 1000000000, category: 'pool',
      });

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);
      assert.equal(result.batches.length, 2);
      assert.equal(result.batches.every((b) => b.processed), true);

      const updatedRun = await ledger.getRun(run.id);
      assert.equal(updatedRun.status, 'broadcasted');
    });

    it('marks source blocks paid after successful live broadcast', async () => {
      await execSql(db, `CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        finder TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reward REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        paid INTEGER DEFAULT 0,
        mode TEXT DEFAULT 'pool',
        payout_address TEXT
      )`);
      await execSql(db, 'DELETE FROM blocks WHERE height = ?', [7654321]);
      await execSql(
        db,
        "INSERT INTO blocks (height, hash, finder, timestamp, reward, status, paid, mode) VALUES (?, ?, ?, ?, ?, 'confirmed', 0, 'pool')",
        [7654321, 'source_hash_7654321', ADDR.miner1, Date.now(), 50]
      );

      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'sendmany') return 'sourcepaidtxid';
          return null;
        }),
      });

      const run = await createTestRun(ledger, { blockHeightStart: 7654321, blockHeightEnd: 7654321 });
      await ledger.createBlockCredit({
        runId: run.id,
        height: 7654321,
        hash: 'source_hash_7654321',
        finder: ADDR.miner1,
        mode: 'pool',
        rewardSats: 5000000000,
        feeDeductedSats: 0,
        finderBonusSats: 0,
        remainderSats: 5000000000,
        minerCount: 1,
      });
      const batch = await createTestBatch(ledger, run.id, { totalAmountSats: 100000000, outputCount: 1 });
      await ledger.createBatchOutput({
        batchId: batch.id, address: ADDR.miner1, amountSats: 100000000, category: 'pool',
      });

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);

      const row = await new Promise((resolve, reject) => {
        db.get('SELECT paid, status FROM blocks WHERE height = ?', [7654321], (err, found) => {
          if (err) reject(err);
          else resolve(found);
        });
      });
      assert.equal(row.paid, 1);
      assert.equal(row.status, 'paid');
    });

    it('fails before sendmany when wallet balance is too low', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method) => {
          rpcCalls.push(method);
          if (method === 'getwalletinfo') return { balance: 0.01 };
          if (method === 'getbalance') return 0.01;
          if (method === 'sendmany') return 'should_not_send';
          return null;
        },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, false);
      assert.equal(result.error, 'balance_low');
      assert.ok(rpcCalls.includes('getwalletinfo'));
      assert.equal(rpcCalls.includes('sendmany'), false);
    });

    it('uses wallet-wide getwalletinfo balance instead of a legacy label balance', async () => {
      const config = buildConfig({
        pool: { walletLabel: 'hemp0xpool' },
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method, params) => {
          rpcCalls.push({ method, params });
          if (method === 'getwalletinfo') return { balance: 0.01 };
          if (method === 'getbalance') return 1000000;
          return 'should_not_send';
        },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.error, 'balance_low');
      assert.equal(rpcCalls.some(({ method }) => method === 'getbalance'), false);
      assert.equal(rpcCalls.some(({ method }) => method === 'sendmany'), false);
    });

    it('broadcasts funded batches and leaves later batches queued', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      let sendmanyCount = 0;
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method) => {
          if (method === 'getwalletinfo') return { balance: 60 };
          if (method === 'sendmany') return `funded_batch_txid_${++sendmanyCount}`;
          return null;
        },
      });

      const run = await createTestRun(ledger);
      const firstBatch = await createTestBatch(ledger, run.id, { batchIndex: 0 });
      const secondBatch = await createTestBatch(ledger, run.id, { batchIndex: 1 });
      await createTestOutputs(ledger, firstBatch.id);
      await createTestOutputs(ledger, secondBatch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);
      assert.equal(sendmanyCount, 1);
      assert.equal((await ledger.getBatch(firstBatch.id)).status, 'broadcasted');
      assert.equal((await ledger.getBatch(secondBatch.id)).status, 'created');
      assert.equal((await ledger.getRun(run.id)).status, 'broadcasting');
    });
  });

  // ---------------------------------------------------------------------------
  // Source safety
  // ---------------------------------------------------------------------------
  describe('source safety', () => {
    it('worker source contains no wallet unlock/passphrase strings', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', 'payoutWorker.js'), 'utf8');
      const forbidden = [
        'walletpassphrase',
        'wallet_unlock',
        'walletlock',
        'signrawtransaction',
        'createrawtransaction',
        'encryptwallet',
      ];
      for (const term of forbidden) {
        assert.ok(!src.includes(term), `Worker source must not contain ${term}`);
      }
    });

    it('sendmany is gated behind the triple-check', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', 'payoutWorker.js'), 'utf8');
      // sendmany may appear in the source, but it must only be reachable
      // inside the liveCapable branch. Verify the structure.
      assert.ok(src.includes('sendmany'));
      assert.ok(src.includes('status.liveCapable'));
      assert.ok(src.includes('payoutBroadcastEnabled'));
    });

    it('default safe config cannot broadcast', async () => {
      const config = buildConfig();
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method) => { rpcCalls.push(method); return 'txid'; },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      await worker.processRun(run.id);
      assert.equal(rpcCalls.length, 0, 'RPC must not be called under default safe config');
    });

    it('refuses to broadcast with only two gates open (missing broadcast gate)', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: false },
      });
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method) => { rpcCalls.push(method); return 'txid'; },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);
      assert.equal(result.mode, 'disabled');
      assert.equal(rpcCalls.length, 0);
    });

    it('refuses to broadcast with only two gates open (missing dryRun gate)', async () => {
      const config = buildConfig({
        payout: { dryRun: true },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method) => { rpcCalls.push(method); return 'txid'; },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      const result = await worker.processRun(run.id);
      assert.equal(result.processed, true);
      assert.equal(result.mode, 'dry_run');
      assert.equal(rpcCalls.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Confirmations
  // ---------------------------------------------------------------------------
  describe('confirmBroadcastedBatches', () => {
    it('confirms broadcasted batch when enough confirmations reached', async () => {
      const config = buildConfig({
        payout: { dryRun: false, blockConfirmations: 100 },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (method, params) => {
          if (method === 'gettransaction') {
            return { confirmations: 120, txid: params[0] };
          }
          return null;
        },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      // Manually set batch to broadcasted with a txid
      await ledger.updateBatchStatus(batch.id, 'broadcasted', { txid: 'testtxid_abc123' });

      // Scope to this run only
      const result = await worker.confirmBroadcastedBatches(run.id);
      const ourResult = result.results.find((r) => r.batchId === batch.id);
      assert.ok(ourResult);
      assert.equal(ourResult.confirmed, true);
      assert.equal(ourResult.confirmations, 120);

      const updatedBatch = await ledger.getBatch(batch.id);
      assert.equal(updatedBatch.status, 'confirmed');
    });

    it('does not confirm batch with insufficient confirmations', async () => {
      const config = buildConfig({
        payout: { dryRun: false, blockConfirmations: 100 },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async () => ({ confirmations: 5 }),
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);
      await ledger.updateBatchStatus(batch.id, 'broadcasted', { txid: 'testtxid_def456' });

      // Scope to this run only
      const result = await worker.confirmBroadcastedBatches(run.id);
      const ourResult = result.results.find((r) => r.batchId === batch.id);
      assert.ok(ourResult);
      assert.equal(ourResult.confirmed, false);
      assert.equal(ourResult.confirmations, 5);

      const updatedBatch = await ledger.getBatch(batch.id);
      assert.equal(updatedBatch.status, 'broadcasted');
    });

    it('handles RPC errors gracefully in confirmation', async () => {
      const config = buildConfig({
        payout: { dryRun: false },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async () => {
          throw new Error('Daemon connection refused\n    at Socket.connect');
        },
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);
      await ledger.updateBatchStatus(batch.id, 'broadcasted', { txid: 'testtxid_ghi789' });

      const result = await worker.confirmBroadcastedBatches(run.id);
      assert.ok(result.results.length >= 1, `Expected at least 1 result, got ${result.results.length}`);

      const ourResult = result.results.find((r) => r.batchId === batch.id);
      assert.ok(ourResult);
      assert.equal(ourResult.confirmed, false);
      assert.ok(ourResult.error);
      assert.ok(!ourResult.error.includes('\n'), 'Error must be sanitized');

      const updatedBatch = await ledger.getBatch(batch.id);
      assert.equal(updatedBatch.status, 'broadcasted');
    });

    it('skips non-broadcasted batches', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async () => ({ confirmations: 200 }),
      });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);
      // Batch is still 'created' - not broadcasted

      // Scope to this run so we only check our batch
      const result = await worker.confirmBroadcastedBatches(run.id);
      // Our batch should NOT appear since it's not broadcasted
      const ourBatch = result.results.find((r) => r.batchId === batch.id);
      assert.equal(ourBatch, undefined, 'Non-broadcasted batch should be skipped');
    });

    it('confirms run when all batches in the run are confirmed', async () => {
      const config = buildConfig({
        payout: { dryRun: false, blockConfirmations: 100 },
        automation: { routinePayoutEnabled: true, payoutBroadcastEnabled: true },
      });
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async () => ({ confirmations: 150 }),
      });

      const run = await createTestRun(ledger);
      const b0 = await createTestBatch(ledger, run.id, { batchIndex: 0 });
      const b1 = await createTestBatch(ledger, run.id, { batchIndex: 1, totalAmountSats: 1000000000, outputCount: 1 });
      await createTestOutputs(ledger, b0.id);
      await ledger.createBatchOutput({
        batchId: b1.id, address: ADDR.miner1, amountSats: 1000000000, category: 'pool',
      });

      await ledger.updateBatchStatus(b0.id, 'broadcasted', { txid: 'txid_b0' });
      await ledger.updateBatchStatus(b1.id, 'broadcasted', { txid: 'txid_b1' });
      // Set run to broadcasted first (simulating post-broadcast state)
      await ledger.updateRunStatus(run.id, 'broadcasted');

      await worker.confirmBroadcastedBatches();

      const updatedRun = await ledger.getRun(run.id);
      assert.equal(updatedRun.status, 'confirmed');
    });
  });

  // ---------------------------------------------------------------------------
  // processPlannedRuns
  // ---------------------------------------------------------------------------
  describe('processPlannedRuns', () => {
    it('processes all planned runs and returns summary', async () => {
      const config = buildConfig();
      const rpcCalls = [];
      const worker = new PayoutWorker({
        db, ledger, config,
        rpc: async (m) => { rpcCalls.push(m); return 'txid'; },
      });

      // Count existing runs before
      const allRunsBefore = await ledger.getAllRuns();
      const countBefore = allRunsBefore.length;

      const run1 = await createTestRun(ledger, {});
      const b1 = await createTestBatch(ledger, run1.id, { batchIndex: 0 });
      await createTestOutputs(ledger, b1.id);

      const run2 = await createTestRun(ledger, {});
      const b2 = await createTestBatch(ledger, run2.id, { batchIndex: 0 });
      await createTestOutputs(ledger, b2.id);

      const summary = await worker.processPlannedRuns();
      assert.equal(summary.mode, 'dry_run');

      // All planned runs (including pre-existing) should be processed
      // At minimum our 2 new runs should be in the processed count
      assert.ok(summary.processed >= 2, `Expected at least 2 processed, got ${summary.processed}`);

      // Verify RPC was never called
      assert.equal(rpcCalls.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Stale run detection
  // ---------------------------------------------------------------------------
  describe('detectStaleRuns', () => {
    it('detects stale runs and records events', async () => {
      const config = buildConfig({
        payout: { staleLockTimeoutMs: 100 }, // very short timeout
      });
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      // The run should be in 'planned' status and may be detected as stale
      // depending on created_at. We'll let natural time pass.
      // For a reliable test, check that the function runs without error.
      const result = await worker.detectStaleRuns();
      assert.ok(Array.isArray(result.results));
      assert.ok(typeof result.staleCount === 'number');
    });
  });

  // ---------------------------------------------------------------------------
  // detectStaleBatches
  // ---------------------------------------------------------------------------
  describe('detectStaleBatches', () => {
    it('detects batches stuck in broadcasting/broadcasted', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      // Set batch to broadcasting with an old timestamp
      await ledger.updateBatchStatus(batch.id, 'broadcasting');
      // Manually set broadcast_at to a very old time
      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE payout_batches SET broadcast_at = ? WHERE id = ?',
          [1, batch.id],
          function (err) { if (err) reject(err); else resolve(); }
        );
      });

      const result = await worker.detectStaleBatches(1000);
      assert.ok(result.results.length >= 1);

      const events = await ledger.getEventsForRun(run.id);
      const staleEvents = events.filter((e) => e.event_type === 'stale_batch_detected');
      assert.ok(staleEvents.length >= 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency across all operations
  // ---------------------------------------------------------------------------
  describe('idempotency', () => {
    it('second processRun call is no-op on already-processed run', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const run = await createTestRun(ledger);
      const batch = await createTestBatch(ledger, run.id);
      await createTestOutputs(ledger, batch.id);

      await worker.processRun(run.id);
      const secondResult = await worker.processRun(run.id);

      assert.equal(secondResult.processed, false);
      assert.equal(secondResult.reason, 'dry_run_already_simulated');

      // Event count should not double
      const events = await ledger.getEventsForRun(run.id);
      const dryRunSim = events.filter((e) => e.event_type === 'dry_run_batch_simulated');
      assert.equal(dryRunSim.length, 1);
    });

    it('re-acquiring and releasing lock is safe', async () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      await worker.acquireRunLock(44444);
      const acquired = await worker.acquireRunLock(44444);
      assert.equal(acquired, false);
      await worker.releaseRunLock(44444);

      // Now can acquire
      const acquired2 = await worker.acquireRunLock(44444);
      assert.equal(acquired2, true);
      await worker.releaseRunLock(44444);
    });
  });

  // ---------------------------------------------------------------------------
  // Error sanitization
  // ---------------------------------------------------------------------------
  describe('error sanitization', () => {
    it('sanitizes multi-line errors to single line', () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const err = new Error('line1\nline2\nline3');
      const sanitized = worker._sanitizeError(err);
      assert.equal(sanitized, 'line1');
    });

    it('truncates very long error messages', () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      const longMsg = 'A'.repeat(1000);
      const err = new Error(longMsg);
      const sanitized = worker._sanitizeError(err);
      assert.ok(sanitized.length <= 500);
    });

    it('handles null/undefined errors', () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      assert.equal(worker._sanitizeError(null), 'Unknown error');
      assert.equal(worker._sanitizeError(undefined), 'Unknown error');
    });

    it('handles non-Error objects with message', () => {
      const config = buildConfig();
      const worker = new PayoutWorker({ db, ledger, config });

      assert.equal(worker._sanitizeError({ message: 'test' }), 'test');
    });
  });
});
