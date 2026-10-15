const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { ConsolidationLedger } = require('../consolidationLedger');
const { ConsolidationExecutor, LIVE_CONFIRM_VALUE } = require('../consolidationExecutor');
const { PayoutLedger } = require('../payoutLedger');
const { MigrationRunner } = require('../migrations');
const { DEFAULTS } = require('../config');
const { POOL_ADDRESS } = require('./fixtures');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');
const LIVE_ENV_VAR = 'HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM';

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
    consolidation: {
      enabled: false,
      dryRunOnly: true,
      minConfirmations: 100,
      maxInputsPerBatch: 200,
      maxTxSizeBytes: 80000,
      feeRateSatsPerByte: 10,
      useSmartFeeEstimate: false,
      smartFeeConfirmTarget: 6,
      destinationAddress: POOL_ADDRESS,
      reservePolicy: {
        minUtxosToKeep: 0,
        maxUtxoSizeToKeepSats: 0,
        minTotalReserveSats: 0,
      },
      autoRunIntervalMs: 0,
      operatorApprovalRequired: true,
      broadcastMaxRetries: 3,
      broadcastBackoffMs: [300000, 900000, 3600000],
      ...(overrides.consolidation || {}),
    },
    automation: {
      consolidationBroadcastEnabled: false,
      ...(overrides.automation || {}),
    },
    health: {
      maturityConfirmations: 100,
      warnUtxoCountAbove: 10000,
      warnUtxoCountBelow: 100,
      warnBalanceBelowSats: 100000000000,
      warnDustUtxoCountAbove: 500,
      ...(overrides.health || {}),
    },
  };
}

function liveRpc(handler) {
  return async (method, params) => {
    if (method === 'getbalance') return 1000000;
    return handler(method, params);
  };
}

function rpcFromResponses(responses) {
  return async (method, params) => {
    if (method === 'getbalance') return 1000000;
    if (responses[method]) {
      const val = responses[method];
      if (typeof val === 'function') return val(params);
      return val;
    }
    return null;
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

describe('ConsolidationExecutor', () => {
  let db;
  let consolidationLedger;
  let payoutLedger;

  before(async () => {
    db = createDb();
    await setupDb(db);
    consolidationLedger = new ConsolidationLedger(db);
    payoutLedger = new PayoutLedger(db);
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
      const executor = new ConsolidationExecutor({ db, consolidationLedger, payoutLedger, config });
      const status = executor.getAutomationStatus();
      assert.equal(status.mode, 'dry_run');
      assert.equal(status.dryRunOnly, true);
      assert.equal(status.enabled, false);
      assert.equal(status.consolidationBroadcastEnabled, false);
      assert.equal(status.liveCapable, false);
    });

    it('returns live mode when all three gates are open', () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });
      const executor = new ConsolidationExecutor({ db, consolidationLedger, payoutLedger, config });
      const status = executor.getAutomationStatus();
      assert.equal(status.mode, 'live');
      assert.equal(status.liveCapable, true);
    });

    it('returns disabled when enabled is true but dryRunOnly is true', () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: true },
        automation: { consolidationBroadcastEnabled: true },
      });
      const executor = new ConsolidationExecutor({ db, consolidationLedger, payoutLedger, config });
      const status = executor.getAutomationStatus();
      assert.equal(status.mode, 'dry_run');
      assert.equal(status.liveCapable, false);
    });

    it('returns disabled when broadcast not enabled', () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: false },
      });
      const executor = new ConsolidationExecutor({ db, consolidationLedger, payoutLedger, config });
      const status = executor.getAutomationStatus();
      assert.equal(status.mode, 'disabled');
      assert.equal(status.liveCapable, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Dry-run process
  // ---------------------------------------------------------------------------
  describe('processPlan - dry-run', () => {
    it('processes a plan in dry-run mode without calling RPC', () => {
      const config = buildConfig();
      const rpcCalls = [];
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async (method, params) => { rpcCalls.push({ method, params }); throw new Error('RPC must not be called'); },
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [
              { txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS },
            ],
            totalInputSats: 1000000000,
            estimatedFeeSats: 50000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 50000,
      };

      return executor.processPlan(plan, { live: false }).then((result) => {
        assert.equal(result.processed, true);
        assert.equal(result.mode, 'dry_run');
        assert.equal(rpcCalls.length, 0, 'RPC must not be called in dry-run mode');

        const batchResult = result.batches[0];
        assert.equal(batchResult.processed, true);
        assert.equal(batchResult.simulated, true);
        assert.equal(batchResult.dryRun, true);
        assert.equal(batchResult.inputCount, 1);
        assert.ok(batchResult.simulatedTxid.startsWith('dryrun_'));
      });
    });

    it('records events in the ledger when planId is provided', async () => {
      const config = buildConfig();
      const rpcCalls = [];
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async (method) => { rpcCalls.push(method); throw new Error('no rpc'); },
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [
              { txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS },
            ],
            totalInputSats: 1000000000,
            estimatedFeeSats: 50000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 50000,
      };

      const ledgerPlan = await consolidationLedger.createPlan({
        destinationAddress: POOL_ADDRESS,
        configSnapshot: { test: true },
      });

      await executor.processPlan(plan, { live: false, planId: ledgerPlan.plan_id });

      const events = await consolidationLedger.getEventsForPlan(ledgerPlan.plan_id);
      const simEvents = events.filter((e) => e.event_type === 'broadcast_attempted');
      assert.ok(simEvents.length >= 1);

      assert.equal(rpcCalls.length, 0);
    });

    it('respects --max-batches cap in dry-run', async () => {
      const config = buildConfig();
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async () => { throw new Error('no rpc'); },
      });

      const plan = {
        batches: [
          { batchIndex: 0, destinationAddress: POOL_ADDRESS, selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }], totalInputSats: 1000000000, estimatedFeeSats: 10000, estimatedTxSizeBytes: 200 },
          { batchIndex: 1, destinationAddress: POOL_ADDRESS, selectedInputs: [{ txid: 'b'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 600, address: POOL_ADDRESS }], totalInputSats: 1000000000, estimatedFeeSats: 10000, estimatedTxSizeBytes: 200 },
          { batchIndex: 2, destinationAddress: POOL_ADDRESS, selectedInputs: [{ txid: 'c'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 700, address: POOL_ADDRESS }], totalInputSats: 1000000000, estimatedFeeSats: 10000, estimatedTxSizeBytes: 200 },
        ],
        totalInputs: 3,
        totalInputSats: 3000000000,
        totalFeeSats: 30000,
      };

      const result = await executor.processPlan(plan, { live: false, maxBatches: 2 });
      assert.equal(result.processed, true);
      assert.equal(result.batches.length, 2);
    });

    it('respects --batch-index filter', async () => {
      const config = buildConfig();
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async () => { throw new Error('no rpc'); },
      });

      const plan = {
        batches: [
          { batchIndex: 0, destinationAddress: POOL_ADDRESS, selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }], totalInputSats: 1000000000, estimatedFeeSats: 10000, estimatedTxSizeBytes: 200 },
          { batchIndex: 1, destinationAddress: POOL_ADDRESS, selectedInputs: [{ txid: 'b'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 600, address: POOL_ADDRESS }], totalInputSats: 1000000000, estimatedFeeSats: 10000, estimatedTxSizeBytes: 200 },
        ],
        totalInputs: 2,
        totalInputSats: 2000000000,
        totalFeeSats: 20000,
      };

      const result = await executor.processPlan(plan, { live: false, batchIndex: 0 });
      assert.equal(result.processed, true);
      assert.equal(result.batches.length, 1);
      assert.equal(result.batches[0].batchIndex, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // processPlan - live mode preflight
  // ---------------------------------------------------------------------------
  async function cleanupPayoutData() {
    await execSql(db, 'DELETE FROM payout_batch_outputs');
    await execSql(db, 'DELETE FROM payout_batches');
    await execSql(db, 'DELETE FROM payout_events');
    await execSql(db, 'DELETE FROM payout_block_credits');
    await execSql(db, 'DELETE FROM payout_miner_credits');
    await execSql(db, 'DELETE FROM payout_runs');
  }

  describe('processPlan - live mode preflight', () => {
    beforeEach(cleanupPayoutData);

    it('refuses live mode when config gates are not open', async () => {
      const config = buildConfig();
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async () => 'txid'),
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });
      assert.equal(result.processed, false);
      assert.equal(result.error, 'live_mode_not_capable');
    });

    it('refuses live mode when there are unresolved payout batches', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const rpcCalls = [];
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async (method, params) => {
          rpcCalls.push(method);
          if (method === 'getbalance') return 1000000;
          return null;
        },
      });

      const run = await payoutLedger.createRun({
        blockHeightStart: 1000,
        blockHeightEnd: 1001,
        totalBlocks: 1,
        totalMiners: 2,
        totalAmountSats: 5000000000,
        feeAmountSats: 50000000,
        netAmountSats: 4950000000,
      });
      await payoutLedger.createBatch({
        runId: run.id,
        batchIndex: 0,
        totalAmountSats: 4950000000,
        outputCount: 2,
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });
      assert.equal(result.processed, false);
      assert.equal(result.error, 'payout_unresolved_batches');
    });

    it('refuses live mode when payout runs are still planning or broadcasting', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const rpcCalls = [];
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async (method) => {
          rpcCalls.push(method);
          if (method === 'getbalance') return 1000000;
          return null;
        },
      });

      const run = await payoutLedger.createRun({
        blockHeightStart: 1000,
        blockHeightEnd: 1001,
        totalBlocks: 1,
        totalMiners: 2,
        totalAmountSats: 5000000000,
        feeAmountSats: 50000000,
        netAmountSats: 4950000000,
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });
      assert.equal(result.processed, false);
      assert.equal(result.error, 'payout_active_runs');
    });

    it('allows live consolidation while payout runs are only waiting for confirmations', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const rpcCalls = [];
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method, params) => {
          rpcCalls.push({ method, params });
          if (method === 'getbalance') return 1000000;
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') return { hex: 'signedhex', complete: true };
          if (method === 'sendrawtransaction') return 'consolidation_txid';
          return null;
        }),
      });

      const run = await payoutLedger.createRun({
        blockHeightStart: 1000,
        blockHeightEnd: 1001,
        totalBlocks: 1,
        totalMiners: 2,
        totalAmountSats: 5000000000,
        feeAmountSats: 50000000,
        netAmountSats: 4950000000,
      });
      await payoutLedger.updateRunStatus(run.id, 'broadcasted');

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });
      assert.equal(result.processed, true);
      assert.equal(result.allOk, true);
      assert.equal(result.batches[0].txid, 'consolidation_txid');
      assert.ok(rpcCalls.some((c) => c.method === 'sendrawtransaction'));
    });
  });

  // ---------------------------------------------------------------------------
  // processPlan - live mode
  // ---------------------------------------------------------------------------
  describe('processPlan - live mode', () => {
    beforeEach(cleanupPayoutData);

    it('broadcasts a batch when all gates are open', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const rpcCalls = [];
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method, params) => {
          rpcCalls.push({ method, params });
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') return { hex: 'signedhex', complete: true };
          if (method === 'sendrawtransaction') return 'realtxid00001111';
          return null;
        }),
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });

      assert.equal(result.processed, true);
      assert.equal(result.mode, 'live');
      assert.equal(result.allOk, true);
      assert.equal(result.batches[0].txid, 'realtxid00001111');

      const createCall = rpcCalls.find((c) => c.method === 'createrawtransaction');
      assert.ok(createCall, 'createrawtransaction must be called');
      assert.equal(typeof createCall.params[1][POOL_ADDRESS], 'string');
      assert.equal(createCall.params[1][POOL_ADDRESS], '9.99998080');
      const signCall = rpcCalls.find((c) => c.method === 'signrawtransactionwithwallet');
      assert.ok(signCall, 'signrawtransactionwithwallet must be called');
      const sendCall = rpcCalls.find((c) => c.method === 'sendrawtransaction');
      assert.ok(sendCall, 'sendrawtransaction must be called');
    });

    it('stores txid in ledger after broadcast success', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') return { hex: 'signedhex', complete: true };
          if (method === 'sendrawtransaction') return 'realtxid_stored';
          return null;
        }),
      });

      const ledgerPlan = await consolidationLedger.createPlan({
        destinationAddress: POOL_ADDRESS,
        configSnapshot: { test: true },
      });
      await consolidationLedger.createBatch({
        planId: ledgerPlan.plan_id,
        batchIndex: 0,
        destinationAddress: POOL_ADDRESS,
        totalInputSats: 1000000000,
        estimatedFeeSats: 10000,
        estimatedTxSizeBytes: 200,
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true, planId: ledgerPlan.plan_id });

      assert.equal(result.allOk, true);
      assert.equal(result.batches[0].txid, 'realtxid_stored');

      const batches = await consolidationLedger.getBatchesForPlan(ledgerPlan.plan_id);
      const ourBatch = batches.find((b) => b.batch_index === 0);
      assert.ok(ourBatch);
      assert.equal(ourBatch.txid, 'realtxid_stored');
      assert.equal(ourBatch.status, 'broadcasted');
    });

    it('marks batch failed when signrawtransactionwithwallet is incomplete', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') return { hex: '', complete: false };
          if (method === 'signrawtransaction') return { hex: '', complete: false };
          if (method === 'sendrawtransaction') return 'should_not_broadcast';
          return null;
        }),
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });

      assert.equal(result.allOk, false);
      assert.equal(result.batches[0].processed, false);
      assert.ok(result.batches[0].error.includes('incomplete'));
    });

    it('falls back to signrawtransaction when signrawtransactionwithwallet fails', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const rpcCalls = [];
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method) => {
          rpcCalls.push(method);
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') throw new Error('wallet unavailable');
          if (method === 'signrawtransaction') return { hex: 'signedhex_fallback', complete: true };
          if (method === 'sendrawtransaction') return 'txid_fallback';
          return null;
        }),
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });

      assert.equal(result.allOk, true);
      assert.ok(rpcCalls.includes('signrawtransaction'));
      assert.ok(rpcCalls.includes('sendrawtransaction'));
      assert.equal(result.batches[0].txid, 'txid_fallback');
    });

    it('handles sendrawtransaction error and records sanitized error', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') return { hex: 'signedhex', complete: true };
          if (method === 'sendrawtransaction') {
            const err = new Error('txn-mempool-conflict\n    at sendrawtransaction (/path/to/rpc.js:42)\n    at process');
            throw err;
          }
          return null;
        }),
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });

      assert.equal(result.allOk, false);
      assert.equal(result.batches[0].processed, false);
      assert.ok(result.batches[0].error.includes('txn-mempool-conflict'));
      assert.ok(!result.batches[0].error.includes('\n'));
      assert.ok(!result.batches[0].error.includes('/path/to'));
    });

    it('respects --max-inputs cap in live mode', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method) => {
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') return { hex: 'signedhex', complete: true };
          if (method === 'sendrawtransaction') return 'txid_capped';
          return null;
        }),
      });

      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [
              { txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS },
              { txid: 'b'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 600, address: POOL_ADDRESS },
            ],
            totalInputSats: 2000000000,
            estimatedFeeSats: 20000,
            estimatedTxSizeBytes: 400,
          },
        ],
        totalInputs: 2,
        totalInputSats: 2000000000,
        totalFeeSats: 20000,
      };

      const result = await executor.processPlan(plan, { live: true, maxInputs: 1 });

      assert.equal(result.processed, true);
      assert.equal(result.batches.length, 1, 'batch should still be one, but capped to 1 input');
      assert.equal(result.batches[0].feeSats, 1920);
      assert.equal(result.batches[0].outputSats, 999998080);
    });

    it('recalculates capped plan totals and fees before live processing', async () => {
      const config = buildConfig({
        consolidation: {
          enabled: true,
          dryRunOnly: false,
          maxInputsPerBatch: 200,
          feeRateSatsPerByte: 10,
        },
        automation: { consolidationBroadcastEnabled: true },
      });
      const rpcCalls = [];
      const utxos = Array.from({ length: 30 }, (_, index) => ({
        txid: String(index).padStart(64, 'a'),
        vout: 0,
        amount: 10,
        confirmations: 500 + index,
        address: POOL_ADDRESS,
        spendable: true,
        solvable: true,
      }));
      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: liveRpc(async (method, params) => {
          rpcCalls.push({ method, params });
          if (method === 'listunspent') return utxos;
          if (method === 'createrawtransaction') return 'rawtxhex';
          if (method === 'signrawtransactionwithwallet') return { hex: 'signedhex', complete: true };
          if (method === 'sendrawtransaction') return 'txid_capped_recalculated';
          return null;
        }),
      });

      const plan = await executor.createPlan({ maxBatches: 1, maxInputs: 25 });
      assert.equal(plan.totalInputs, 25);
      assert.equal(plan.batches[0].selectedInputs.length, 25);
      assert.equal(plan.batches[0].estimatedTxSizeBytes, 3744);
      assert.equal(plan.batches[0].estimatedFeeSats, 37440);
      assert.equal(plan.totalFeeSats, 37440);

      const result = await executor.processPlan(plan, { live: true, maxBatches: 1, maxInputs: 25 });
      assert.equal(result.allOk, true);
      assert.equal(result.batches[0].inputCount, 25);
      assert.equal(result.batches[0].feeSats, 37440);

      const createCall = rpcCalls.find((c) => c.method === 'createrawtransaction');
      assert.ok(createCall);
      assert.equal(createCall.params[0].length, 25);
      assert.equal(createCall.params[1][POOL_ADDRESS], '249.99962560');
    });

    it('fails closed when payout preflight tables cannot be read', async () => {
      const config = buildConfig({
        consolidation: { enabled: true, dryRunOnly: false },
        automation: { consolidationBroadcastEnabled: true },
      });
      const badDb = {
        get(_sql, _params, cb) {
          cb(new Error('SQLITE_CORRUPT: payout table unreadable'));
        },
        all(_sql, _params, cb) {
          cb(null, []);
        },
        run(_sql, _params, cb) {
          cb(null);
        },
      };
      const executor = new ConsolidationExecutor({
        db: badDb,
        consolidationLedger: null,
        payoutLedger: null,
        config,
        rpc: liveRpc(async () => null),
      });
      const plan = {
        batches: [
          {
            batchIndex: 0,
            destinationAddress: POOL_ADDRESS,
            selectedInputs: [{ txid: 'a'.repeat(64), vout: 0, amountSats: 1000000000, confirmations: 500, address: POOL_ADDRESS }],
            totalInputSats: 1000000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 200,
          },
        ],
        totalInputs: 1,
        totalInputSats: 1000000000,
        totalFeeSats: 10000,
      };

      const result = await executor.processPlan(plan, { live: true });
      assert.equal(result.processed, false);
      assert.equal(result.error, 'payout_preflight_failed');
      assert.match(result.detail, /SQLITE_CORRUPT/);
    });
  });

  // ---------------------------------------------------------------------------
  // Confirmations
  // ---------------------------------------------------------------------------
  describe('confirmBroadcastedBatches', () => {
    it('confirms broadcasted batch when enough confirmations reached', async () => {
      const config = buildConfig({
        consolidation: { minConfirmations: 100 },
      });

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async (method, params) => {
          if (method === 'gettransaction') return { confirmations: 120, txid: params[0] };
          return null;
        },
      });

      const plan = await consolidationLedger.createPlan({
        destinationAddress: POOL_ADDRESS,
        configSnapshot: { test: true },
      });
      const batch = await consolidationLedger.createBatch({
        planId: plan.plan_id,
        batchIndex: 0,
        destinationAddress: POOL_ADDRESS,
        totalInputSats: 1000000000,
        estimatedFeeSats: 10000,
        estimatedTxSizeBytes: 200,
      });
      await consolidationLedger.updateBatchStatus(batch.batch_id, 'broadcasted', { txid: 'txid_to_confirm' });

      const result = await executor.confirmBroadcastedBatches();

      assert.ok(result.total >= 1);
      const ourResult = result.results.find((r) => r.batchId === batch.batch_id);
      assert.ok(ourResult);
      assert.equal(ourResult.confirmed, true);
      assert.equal(ourResult.confirmations, 120);

      const updatedBatch = await consolidationLedger.getBatch(batch.batch_id);
      assert.equal(updatedBatch.status, 'confirmed');
    });

    it('does not confirm batch with insufficient confirmations', async () => {
      const config = buildConfig({
        consolidation: { minConfirmations: 100 },
      });

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async () => ({ confirmations: 5 }),
      });

      const plan = await consolidationLedger.createPlan({
        destinationAddress: POOL_ADDRESS,
        configSnapshot: {},
      });
      const batch = await consolidationLedger.createBatch({
        planId: plan.plan_id,
        batchIndex: 0,
        destinationAddress: POOL_ADDRESS,
      });
      await consolidationLedger.updateBatchStatus(batch.batch_id, 'broadcasted', { txid: 'txid_not_ready' });

      const result = await executor.confirmBroadcastedBatches();
      const ourResult = result.results.find((r) => r.batchId === batch.batch_id);
      assert.ok(ourResult);
      assert.equal(ourResult.confirmed, false);
      assert.equal(ourResult.confirmations, 5);

      const updatedBatch = await consolidationLedger.getBatch(batch.batch_id);
      assert.equal(updatedBatch.status, 'broadcasted');
    });

    it('handles RPC errors gracefully', async () => {
      const config = buildConfig();

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async () => { throw new Error('connection refused\n    at Socket.connect'); },
      });

      const plan = await consolidationLedger.createPlan({
        destinationAddress: POOL_ADDRESS,
        configSnapshot: {},
      });
      const batch = await consolidationLedger.createBatch({
        planId: plan.plan_id,
        batchIndex: 0,
        destinationAddress: POOL_ADDRESS,
      });
      await consolidationLedger.updateBatchStatus(batch.batch_id, 'broadcasted', { txid: 'txid_error_case' });

      const result = await executor.confirmBroadcastedBatches();
      const ourResult = result.results.find((r) => r.batchId === batch.batch_id);
      assert.ok(ourResult);
      assert.equal(ourResult.confirmed, false);
      assert.ok(ourResult.error);
      assert.ok(!ourResult.error.includes('\n'));
    });

    it('skips batches without txid', async () => {
      const config = buildConfig();

      const executor = new ConsolidationExecutor({
        db, consolidationLedger, payoutLedger, config,
        rpc: async () => ({ confirmations: 200 }),
      });

      const plan = await consolidationLedger.createPlan({
        destinationAddress: POOL_ADDRESS,
        configSnapshot: {},
      });
      const batch = await consolidationLedger.createBatch({
        planId: plan.plan_id,
        batchIndex: 0,
        destinationAddress: POOL_ADDRESS,
      });
      await consolidationLedger.updateBatchStatus(batch.batch_id, 'broadcasted');

      // Batch has no txid
      const result = await executor.confirmBroadcastedBatches();
      const ourResult = result.results.find((r) => r.batchId === batch.batch_id);
      assert.equal(ourResult, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Error sanitization
  // ---------------------------------------------------------------------------
  describe('error sanitization', () => {
    it('sanitizes multi-line errors to single line', () => {
      const config = buildConfig();
      const executor = new ConsolidationExecutor({ db, consolidationLedger, payoutLedger, config });

      const err = new Error('line1\nline2\nline3');
      const sanitized = executor._sanitizeError(err);
      assert.equal(sanitized, 'line1');
    });

    it('truncates very long error messages', () => {
      const config = buildConfig();
      const executor = new ConsolidationExecutor({ db, consolidationLedger, payoutLedger, config });

      const longMsg = 'A'.repeat(1000);
      const err = new Error(longMsg);
      const sanitized = executor._sanitizeError(err);
      assert.ok(sanitized.length <= 500);
    });

    it('handles null/undefined errors', () => {
      const config = buildConfig();
      const executor = new ConsolidationExecutor({ db, consolidationLedger, payoutLedger, config });

      assert.equal(executor._sanitizeError(null), 'Unknown error');
      assert.equal(executor._sanitizeError(undefined), 'Unknown error');
    });
  });

  // ---------------------------------------------------------------------------
  // Live env var confirmation
  // ---------------------------------------------------------------------------
  describe('live env var confirmation (CLI logic equivalent)', () => {
    it('throws if env var is missing', () => {
      delete process.env[LIVE_ENV_VAR];
      const config = buildConfig();
      try {
        enableLiveConfig(config, true);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes(LIVE_ENV_VAR) || err.message.includes('Refusing'));
      }
    });

    it('throws if env var is wrong', () => {
      process.env[LIVE_ENV_VAR] = 'WRONG_VALUE';
      const config = buildConfig();
      try {
        enableLiveConfig(config, true);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes(LIVE_ENV_VAR) || err.message.includes('Refusing'));
      }
    });

    it('succeeds with correct env var and returns live config', () => {
      process.env[LIVE_ENV_VAR] = LIVE_CONFIRM_VALUE;
      const config = buildConfig();
      const result = enableLiveConfig(config, true);
      assert.equal(result.consolidation.enabled, true);
      assert.equal(result.consolidation.dryRunOnly, false);
      assert.equal(result.automation.consolidationBroadcastEnabled, true);
    });

    it('returns unchanged config when live is not requested', () => {
      process.env[LIVE_ENV_VAR] = LIVE_CONFIRM_VALUE;
      const config = buildConfig();
      const result = enableLiveConfig(config, false);
      assert.equal(result.consolidation.enabled, false);
      assert.equal(result.consolidation.dryRunOnly, true);
      assert.equal(result.automation.consolidationBroadcastEnabled, false);
    });
  });
});

// Replicate the enableLiveConsolidationConfig function for testing
function enableLiveConsolidationConfig(config, live) {
  if (!live) return config;
  if (process.env[LIVE_ENV_VAR] !== LIVE_CONFIRM_VALUE) {
    throw new Error(
      `Refusing live consolidation broadcast: missing or incorrect ${LIVE_ENV_VAR} value`
    );
  }
  return {
    ...config,
    consolidation: {
      ...config.consolidation,
      enabled: true,
      dryRunOnly: false,
    },
    automation: {
      ...config.automation,
      consolidationBroadcastEnabled: true,
    },
  };
}

// Small helper for the live env var test
function enableLiveConfig(config, live) {
  return enableLiveConsolidationConfig(config, live);
}
