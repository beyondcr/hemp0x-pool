const { DatabaseManager } = require('../database');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MigrationRunner } = require('../migrations');
const { PayoutLedger } = require('../payoutLedger');
const { planPayout, isValidAddress } = require('../payoutPlanner');
const { hempToSatsNumber } = require('../constants');
const { DEFAULTS } = require('../config');
const { TEST_ADDRESSES, makeTestAddress } = require('./addressFixtures');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

const ADDR = {
  finderA: TEST_ADDRESSES.finderA,
  finderB: TEST_ADDRESSES.finderB,
  miner1: TEST_ADDRESSES.miner1,
  miner2: TEST_ADDRESSES.miner2,
  miner3: TEST_ADDRESSES.miner3,
  miner4: TEST_ADDRESSES.miner4,
  miner5: makeTestAddress('miner5'),
  miner6: makeTestAddress('miner6'),
  miner7: makeTestAddress('miner7'),
  miner8: makeTestAddress('miner8'),
  invalid: 'invalid_address',
  badFormat: 'RXbad',
};

function makeBlock(overrides = {}) {
  return {
    height: 1001,
    hash: 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
    finder: ADDR.finderA,
    timestamp: Date.now() - 120000,
    reward: 50,
    status: 'confirmed',
    paid: 0,
    mode: 'pool',
    payout_address: null,
    ...overrides,
  };
}

function makeBlocks(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) =>
    makeBlock({ height: 1001 + i, hash: `hash${1001 + i}`, ...overrides })
  );
}

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

function buildConfig() {
  return {
    pool: {
      fee: 0.01,
      rewardModel: 'finder-plus-equal',
      finderBonusPercent: 20,
      activeWindowMinutes: 2,
      minActiveMinutes: 2,
    },
    payout: {
      dryRun: true,
      maxPayoutBatch: 50,
      maxPayoutBatchAmountSats: 50000000000,
      maxPayoutPerAddressSats: 50000000000,
      flushMinPayoutSats: 10000000,
      flushIntervalMs: 43200000,
    },
  };
}

describe('payoutPlanner', () => {
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
  // Address validation
  // ---------------------------------------------------------------------------

  it('validates correct Hemp0x addresses', () => {
    assert.equal(isValidAddress(ADDR.finderA), true);
    assert.equal(isValidAddress(ADDR.miner1), true);
  });

  it('rejects invalid addresses', () => {
    assert.equal(isValidAddress(ADDR.invalid), false);
    assert.equal(isValidAddress(ADDR.badFormat), false);
    assert.equal(isValidAddress(''), false);
    assert.equal(isValidAddress(null), false);
    assert.equal(isValidAddress(undefined), false);
  });

  // ---------------------------------------------------------------------------
  // No broadcast leaks
  // ---------------------------------------------------------------------------

  it('does not contain any broadcast method strings', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'payoutPlanner.js'), 'utf8');
    const forbidden = ['sendmany', 'sendrawtransaction', 'signrawtransaction', 'createrawtransaction'];
    for (const term of forbidden) {
      assert.ok(!src.includes(term), `Planner source must not contain ${term}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Integer satoshi math with decimal rewards
  // ---------------------------------------------------------------------------

  it('computes exact satoshi math for a single block with decimal reward', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 100, hash: 'h100', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3, ADDR.miner4];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;

    assert.equal(plan.totals.grossRewardSats, gross);
    assert.equal(plan.totals.feeDeductedSats, fee);
    assert.equal(plan.totals.finderBonusTotalSats, finderBonus);

    // finder gets bonus
    const finderCredit = plan.minerCredits.find((m) => m.miner === ADDR.finderA);
    assert.ok(finderCredit);
    assert.equal(finderCredit.totalSats, finderBonus);

    // 4 miners split remainder evenly
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 4);
    const totalRemainderDistributed = minerCredits.reduce((s, m) => s + m.totalSats, 0);
    assert.equal(totalRemainderDistributed, remainder);
  });

  it('handles integer reward splits that are not perfectly divisible', async () => {
    const config = buildConfig();
    // 50 HEMP * 0.99 net = 4950000000 sats, finder bonus 20% = 990000000, remainder = 3960000000
    const blocks = [makeBlock({ height: 200, hash: 'h200', finder: ADDR.finderA, reward: 50 })];
    // 3 miners: 3960000000 / 3 = 1320000000 each
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 3);

    // total distributed to miners should be exactly the remainder
    const distributed = minerCredits.reduce((s, m) => s + m.totalSats, 0);
    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;
    assert.equal(distributed, remainder);

    // amounts should be within 1 sat of each other (integer split)
    const sorted = [...minerCredits].sort((a, b) => a.totalSats - b.totalSats);
    assert.ok(sorted[sorted.length - 1].totalSats - sorted[0].totalSats <= 1);
  });

  // ---------------------------------------------------------------------------
  // Finder bonus plus equal split
  // ---------------------------------------------------------------------------

  it('distributes finder bonus and splits remainder equally among active miners', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 300, hash: 'h300', finder: ADDR.finderA, reward: 100 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(100);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;
    const eachMiner = Math.floor(remainder / 2);

    const finderCredit = plan.minerCredits.find((m) => m.miner === ADDR.finderA);
    assert.equal(finderCredit.totalSats, finderBonus);

    const m1 = plan.minerCredits.find((m) => m.miner === ADDR.miner1);
    assert.ok(m1.totalSats >= eachMiner);
    const m2 = plan.minerCredits.find((m) => m.miner === ADDR.miner2);
    assert.ok(m2.totalSats >= eachMiner);

    assert.equal(m1.totalSats + m2.totalSats, remainder);
  });

  // ---------------------------------------------------------------------------
  // Fallback when no miners meet min-active window
  // ---------------------------------------------------------------------------

  it('falls back to miners with shares in block window when no miners meet min-active', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 400, hash: 'h400', finder: ADDR.finderA, reward: 50 })];
    const windowMiners = [ADDR.miner1, ADDR.miner2];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => [],
      getMinersForBlockWindow: async () => windowMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('no miners met min-active')));
    assert.ok(plan.blockCredits[0].fallbackUsed);

    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 2);
  });

  it('disables min-active gating when configured equal to the active window', async () => {
    const config = buildConfig();
    const now = Date.now();
    const blocks = [makeBlock({ height: 401, hash: 'h401', finder: ADDR.finderA, reward: 50, timestamp: now })];
    const miner = ADDR.miner1;

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async (blockTimestamp, windowMs, minActiveMs) => {
        assert.equal(windowMs, 120000);
        assert.equal(minActiveMs, 0);
        return [miner];
      },
      getMinersForBlockWindow: async () => {
        throw new Error('window fallback should not be needed when min-active is clamped');
      },
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('minActiveMinutes')));
    assert.equal(plan.blockCredits[0].fallbackUsed, false);
    assert.ok(plan.minerCredits.some((m) => m.miner === miner));
  });

  it('honors minActiveMinutes set to zero', async () => {
    const config = {
      ...buildConfig(),
      pool: {
        ...buildConfig().pool,
        minActiveMinutes: 0,
      },
    };
    const blocks = [makeBlock({ height: 402, hash: 'h402', finder: ADDR.finderA, reward: 50 })];

    await planPayout({
      blocks,
      getActiveMinersForBlock: async (_blockTimestamp, _windowMs, minActiveMs) => {
        assert.equal(minActiveMs, 0);
        return [ADDR.miner1];
      },
      getMinersForBlockWindow: async () => {
        throw new Error('window fallback should not be needed when min-active is zero');
      },
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // Finder fallback when no active miners exist
  // ---------------------------------------------------------------------------

  it('credits remainder to finder when no active miners and no window miners', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 500, hash: 'h500', finder: ADDR.finderA, reward: 50 })];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => [],
      getMinersForBlockWindow: async () => [],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;

    const finderCredits = plan.minerCredits
      .find((m) => m.miner === ADDR.finderA);
    assert.ok(finderCredits);

    let finderTotal = 0;
    for (const detail of finderCredits.blocks) {
      finderTotal += detail.amountSats;
    }
    assert.equal(finderTotal, finderBonus + remainder);

    const fallbackEntries = finderCredits.blocks.filter((d) => d.category === 'finder_fallback');
    assert.ok(fallbackEntries.length > 0);
    assert.equal(fallbackEntries.reduce((s, d) => s + d.amountSats, 0), remainder);
    assert.equal(plan.blockCredits[0].remainderSats, remainder);
    assert.equal(plan.totals.remainderTotalSats, remainder);
  });

  // ---------------------------------------------------------------------------
  // Invalid address skip
  // ---------------------------------------------------------------------------

  it('skips blocks with invalid finder address', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 600, hash: 'h600', finder: ADDR.invalid, reward: 50 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.equal(plan.blocksConsidered.length, 0);
    assert.equal(plan.totals.grossRewardSats, 0);
    assert.equal(plan.totals.feeDeductedSats, 0);
    assert.ok(plan.skipped.some((s) => s.block === 600 && s.reason.includes('invalid')));
  });

  it('skips invalid miner addresses within the active set', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 700, hash: 'h700', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.invalid, ADDR.badFormat];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const creditedMiners = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA).map((m) => m.miner);
    assert.ok(!creditedMiners.includes(ADDR.invalid));
    assert.ok(!creditedMiners.includes(ADDR.badFormat));

    assert.ok(plan.skipped.some((s) => s.address === ADDR.invalid));
    assert.ok(plan.skipped.some((s) => s.address === ADDR.badFormat));
  });

  it('skips blocks with invalid finder at block-processing level', async () => {
    const config = buildConfig();
    const blocks = [
      makeBlock({ height: 800, hash: 'h800', finder: ADDR.finderA, reward: 50 }),
      makeBlock({ height: 801, hash: 'h801', finder: ADDR.invalid, reward: 50 }),
    ];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.equal(plan.blocksConsidered.length, 1);
    const skippedBlock = plan.skipped.find((s) => s.block === 801);
    assert.ok(skippedBlock);
    assert.ok(skippedBlock.reason.includes('invalid finder address'));
  });

  // ---------------------------------------------------------------------------
  // Per-address split over max output amount
  // ---------------------------------------------------------------------------

  it('splits per-address payout into multiple outputs when exceeding max per address', async () => {
    const config = buildConfig();
    config.payout.maxPayoutPerAddressSats = 1000000000; // 10 HEMP

    const blocks = [makeBlock({ height: 900, hash: 'h900', finder: ADDR.finderA, reward: 100 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const batchOutputs = plan.batches.flatMap((b) => b.outputs);
    const miner1Outputs = batchOutputs.filter((o) => o.address === ADDR.miner1);
    const miner1Total = miner1Outputs.reduce((s, o) => s + o.amountSats, 0);

    for (const out of miner1Outputs) {
      assert.ok(out.amountSats <= 1000000000, 'No single output exceeds max per address');
    }

    // total for miner1 should equal full remainder
    const gross = hempToSatsNumber(100);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const remainder = net - Math.floor(net * 0.2);
    assert.equal(miner1Total, remainder);
  });

  // ---------------------------------------------------------------------------
  // Batch splitting by output count
  // ---------------------------------------------------------------------------

  it('splits batches when output count exceeds maxPayoutBatch', async () => {
    const config = buildConfig();
    config.payout.maxPayoutBatch = 3;
    config.payout.maxPayoutBatchAmountSats = Number.MAX_SAFE_INTEGER;
    const blocks = [makeBlock({ height: 1000, hash: 'h1000', finder: ADDR.finderA, reward: 500 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3, ADDR.miner4];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const finderEntries = plan.minerCredits.filter((m) => m.miner === ADDR.finderA);

    let hasFinderOutputs = false;
    for (const batch of plan.batches) {
      assert.ok(batch.outputs.length <= 3, `Batch should have at most ${3} outputs`);
      hasFinderOutputs = hasFinderOutputs || batch.outputs.some((o) => o.address === ADDR.finderA);
    }
    assert.ok(hasFinderOutputs);

    // all outputs must have unique addresses per batch
    for (const batch of plan.batches) {
      const addrs = batch.outputs.map((o) => o.address);
      const uniqueSet = new Set(addrs);
      assert.equal(uniqueSet.size, addrs.length, 'No duplicate addresses in batch');
    }
  });

  // ---------------------------------------------------------------------------
  // Batch splitting by total amount
  // ---------------------------------------------------------------------------

  it('splits batches when total amount exceeds maxPayoutBatchAmountSats', async () => {
    const config = buildConfig();
    config.payout.maxPayoutBatchAmountSats = 5000000000; // 50 HEMP (low enough for splitting)
    config.payout.maxPayoutPerAddressSats = Number.MAX_SAFE_INTEGER;
    const blocks = [makeBlock({ height: 1100, hash: 'h1100', finder: ADDR.finderA, reward: 1000 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3, ADDR.miner4, ADDR.miner5, ADDR.miner6, ADDR.miner7, ADDR.miner8];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.batches.length > 1, 'Multiple miners produce multiple batches due to amount limit');

    // batches should not exceed max amount (except possibly single-entry batches)
    for (const batch of plan.batches) {
      assert.ok(
        batch.totalSats <= config.payout.maxPayoutBatchAmountSats || batch.outputCount === 1,
        `Batch total ${batch.totalSats} exceeds ${config.payout.maxPayoutBatchAmountSats} with ${batch.outputCount} outputs`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // No duplicate address in a single batch
  // ---------------------------------------------------------------------------

  it('ensures no duplicate address in any single batch', async () => {
    const config = buildConfig();
    config.payout.maxPayoutBatch = 50;
    const blocks = makeBlocks(50, { finder: ADDR.finderA, reward: 50 });
    const allMiners = [];
    for (let i = 0; i < 50; i++) {
      allMiners.push(makeTestAddress(`bulk-miner-${i}`));
    }

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => allMiners,
      getMinersForBlockWindow: async () => allMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    for (const batch of plan.batches) {
      const addrs = batch.outputs.map((o) => o.address);
      const uniqueSize = new Set(addrs).size;
      assert.equal(uniqueSize, addrs.length, `No duplicate addresses: ${JSON.stringify(addrs)}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Dry-run ledger rows
  // ---------------------------------------------------------------------------

  it('persists dry-run plan rows in the payout ledger', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 1200, hash: 'h1200', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2];

    const initialRunCount = (await ledger.getAllRuns()).length;

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const run = await ledger.getRun(plan.runId);
    assert.ok(run);
    assert.equal(run.status, 'planned');
    assert.ok(run.total_blocks >= 1);
    assert.ok(run.total_amount_sats > 0);

    const blockCredits = await ledger.getBlockCreditsForRun(plan.runId);
    assert.ok(blockCredits.length >= 1);

    const minerCredits = await ledger.getMinerCreditsForRun(plan.runId);
    assert.ok(minerCredits.length >= 3); // finder_bonus + 2 miners

    assert.ok(plan.batches.length >= 1);
    const batches = await ledger.getBatchesForRun(plan.runId);
    assert.ok(batches.length >= 1);

    const events = await ledger.getEventsForRun(plan.runId);
    assert.ok(events.some((e) => e.event_type === 'run_created'));
    assert.ok(events.some((e) => e.event_type === 'credited'));
  });

  it('creates batch outputs in the ledger', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 1300, hash: 'h1300', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const batches = await ledger.getBatchesForRun(plan.runId);
    for (const batch of batches) {
      const outputs = await ledger.getBatchOutputs(batch.id);
      assert.ok(outputs.length > 0);
    }
  });

  // ---------------------------------------------------------------------------
  // Historical payout tables are not mutated by the ledger planner.
  // ---------------------------------------------------------------------------

  it('does not call historical payout mutation methods', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'payoutPlanner.js'), 'utf8');
    const forbiddenMutations = [
      'markBlocksPaid',
      'markBlocksCredited',
      'markSharesPaid',
      'markSharesPaidThrough',
      'clearRewardBalance',
      'addRewardBalance',
      'recordPayout',
    ];
    for (const term of forbiddenMutations) {
      assert.ok(!src.includes(term), `Planner source must not contain ${term}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Multi-block plan
  // ---------------------------------------------------------------------------

  it('processes multiple blocks correctly', async () => {
    const config = buildConfig();
    const blocks = [
      makeBlock({ height: 1400, hash: 'h1400', finder: ADDR.finderA, reward: 50 }),
      makeBlock({ height: 1401, hash: 'h1401', finder: ADDR.finderB, reward: 25 }),
    ];
    const activeMinersBlock1 = [ADDR.miner1, ADDR.miner2];
    const activeMinersBlock2 = [ADDR.miner3, ADDR.miner4];

    let callCount = 0;
    const getActiveMinersForBlock = async () => {
      const result = callCount === 0 ? activeMinersBlock1 : activeMinersBlock2;
      callCount++;
      return result;
    };

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock,
      getMinersForBlockWindow: getActiveMinersForBlock,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.equal(plan.blocksConsidered.length, 2);
    assert.equal(plan.blockCredits.length, 2);

    // both finders should receive finder bonuses
    const finderA = plan.minerCredits.find((m) => m.miner === ADDR.finderA);
    const finderB = plan.minerCredits.find((m) => m.miner === ADDR.finderB);
    assert.ok(finderA);
    assert.ok(finderB);
  });

  // ---------------------------------------------------------------------------
  // Min payout threshold
  // ---------------------------------------------------------------------------

  it('skips miners below min payout threshold', async () => {
    const config = buildConfig();
    config.payout.flushMinPayoutSats = 1000000000; // 10 HEMP minimum payout
    const blocks = [makeBlock({ height: 1500, hash: 'h1500', finder: ADDR.finderA, reward: 0.01 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
    });

    const payableMiners = plan.batches.flatMap((b) =>
      b.outputs.map((o) => o.address)
    );
    const uniquePayable = new Set(payableMiners);
    assert.equal(uniquePayable.size, 0, 'No miners reach threshold for 0.01 HEMP block');

    assert.ok(plan.skipped.some((s) => s.address === ADDR.miner1 && s.reason.includes('below')));
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('handles zero reward blocks gracefully', async () => {
    const config = buildConfig();
    const blocks = [makeBlock({ height: 1600, hash: 'h1600', finder: ADDR.finderA, reward: 0 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.equal(plan.blocksConsidered.length, 0);
    assert.ok(plan.warnings.some((w) => w.includes('zero')));
    assert.ok(plan.skipped.some((s) => s.block === 1600));
  });

  it('handles empty block list', async () => {
    const config = buildConfig();

    const plan = await planPayout({
      blocks: [],
      getActiveMinersForBlock: async () => [],
      getMinersForBlockWindow: async () => [],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.equal(plan.blocksConsidered.length, 0);
    assert.equal(plan.minerCredits.length, 0);
    assert.equal(plan.batches.length, 0);
  });

  it('uses block finder instead of pool coinbase payout_address for pool-mode finder credit', async () => {
    const config = buildConfig();
    const blocks = [
      makeBlock({
        height: 1700,
        hash: 'h1700',
        finder: ADDR.finderA,
        payout_address: ADDR.finderB,
        reward: 50,
      }),
    ];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const finderCredit = plan.minerCredits.find((m) => m.miner === ADDR.finderA);
    const poolWalletCredit = plan.minerCredits.find((m) => m.miner === ADDR.finderB);
    assert.ok(finderCredit);
    assert.ok(finderCredit.blocks.some((d) => d.category === 'finder'));
    assert.equal(poolWalletCredit, undefined);
  });

  it('handles non-integer reward values', async () => {
    const config = buildConfig();
    // 1.5 HEMP reward
    const blocks = [makeBlock({ height: 1800, hash: 'h1800', finder: ADDR.finderA, reward: 1.5 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(1.5);
    assert.equal(plan.totals.grossRewardSats, gross);

    // fee deducted as integer floor
    const fee = Math.floor(gross * 0.01);
    assert.equal(plan.totals.feeDeductedSats, fee);

    // run ledger should reflect correct values
    const run = await ledger.getRun(plan.runId);
    assert.equal(run.total_amount_sats, gross);
    assert.equal(run.fee_amount_sats, fee);
  });

  // ---------------------------------------------------------------------------
  // distributeSatsByWeight unit tests
  // ---------------------------------------------------------------------------

  it('distributeSatsByWeight splits proportionally by weight (clean division)', () => {
    const { distributeSatsByWeight } = require('../payoutPlanner');
    const weights = [
      { recipient: 'A', weight: 100 },
      { recipient: 'B', weight: 200 },
      { recipient: 'C', weight: 100 },
    ];
    const result = distributeSatsByWeight(400, weights);
    assert.equal(result.length, 3);
    const total = result.reduce((s, r) => s + r.amountSats, 0);
    assert.equal(total, 400);
    assert.equal(result[0].amountSats, 100);
    assert.equal(result[1].amountSats, 200);
    assert.equal(result[2].amountSats, 100);
  });

  it('distributeSatsByWeight handles non-divisible amounts with no satoshi loss', () => {
    const { distributeSatsByWeight } = require('../payoutPlanner');
    const weights = [
      { recipient: 'A', weight: 1 },
      { recipient: 'B', weight: 1 },
      { recipient: 'C', weight: 1 },
    ];
    const result = distributeSatsByWeight(10, weights);
    const total = result.reduce((s, r) => s + r.amountSats, 0);
    assert.equal(total, 10);
    const sorted = [...result].sort((a, b) => a.amountSats - b.amountSats);
    assert.ok(sorted[sorted.length - 1].amountSats - sorted[0].amountSats <= 1);
  });

  it('distributeSatsByWeight distributes rounding remainder deterministically', () => {
    const { distributeSatsByWeight } = require('../payoutPlanner');
    const result = distributeSatsByWeight(10, [
      { recipient: 'C', weight: 1 },
      { recipient: 'A', weight: 1 },
      { recipient: 'B', weight: 1 },
    ]);
    assert.deepEqual(result.map((r) => r.recipient), ['A', 'B', 'C']);
    assert.deepEqual(result.map((r) => r.amountSats), [4, 3, 3]);
  });

  it('distributeSatsByWeight ignores invalid or non-positive weights', () => {
    const { distributeSatsByWeight } = require('../payoutPlanner');
    const result = distributeSatsByWeight(100, [
      { recipient: 'A', weight: 1 },
      { recipient: 'B', weight: 0 },
      { recipient: 'C', weight: Number.NaN },
      { recipient: '', weight: 10 },
    ]);
    assert.deepEqual(result, [{ recipient: 'A', amountSats: 100 }]);
  });

  it('distributeSatsByWeight returns empty array for zero total weight', () => {
    const { distributeSatsByWeight } = require('../payoutPlanner');
    const result = distributeSatsByWeight(100, [{ recipient: 'A', weight: 0 }]);
    assert.equal(result.length, 0);
  });

  it('distributeSatsByWeight returns empty array for zero totalSats', () => {
    const { distributeSatsByWeight } = require('../payoutPlanner');
    const result = distributeSatsByWeight(0, [{ recipient: 'A', weight: 100 }]);
    assert.equal(result.length, 0);
  });

  it('distributeSatsByWeight handles large weights without precision loss', () => {
    const { distributeSatsByWeight } = require('../payoutPlanner');
    const weights = [
      { recipient: 'A', weight: 1 },
      { recipient: 'B', weight: 999999 },
    ];
    const result = distributeSatsByWeight(100000000, weights);
    const total = result.reduce((s, r) => s + r.amountSats, 0);
    assert.equal(total, 100000000);
  });

  // ---------------------------------------------------------------------------
  // finder-plus-share-weighted mode
  // ---------------------------------------------------------------------------

  it('finder-plus-equal behavior unchanged when rewardModel is finder-plus-equal', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-equal' },
    };
    const blocks = [makeBlock({ height: 1900, hash: 'h1900', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3, ADDR.miner4];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getMinerShareWeightsForBlock: async () => [
        { miner: ADDR.miner1, totalDifficulty: 100 },
        { miner: ADDR.miner2, totalDifficulty: 50 },
      ],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    // Equal split should still be used
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    const amounts = minerCredits.map((m) => m.totalSats).sort((a, b) => a - b);
    assert.ok(amounts[amounts.length - 1] - amounts[0] <= 1, 'Equal mode should produce nearly equal amounts');
  });

  it('finder-plus-share-weighted splits proportionally by share difficulty', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted' },
    };
    const blocks = [makeBlock({ height: 2000, hash: 'h2000', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3];
    const shareWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
      { miner: ADDR.miner2, totalDifficulty: 200 },
      { miner: ADDR.miner3, totalDifficulty: 100 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getMinerShareWeightsForBlock: async () => shareWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;

    const m1 = plan.minerCredits.find((m) => m.miner === ADDR.miner1);
    const m2 = plan.minerCredits.find((m) => m.miner === ADDR.miner2);
    const m3 = plan.minerCredits.find((m) => m.miner === ADDR.miner3);
    const distributed = m1.totalSats + m2.totalSats + m3.totalSats;
    assert.equal(distributed, remainder);

    // m2 should get roughly double m1 and m3
    assert.ok(m2.totalSats >= m1.totalSats, 'heavier weight miner should get more');
    assert.ok(m2.totalSats >= m3.totalSats, 'heavier weight miner should get more');
    const diff = m2.totalSats - m1.totalSats;
    assert.ok(diff > 0, 'm2 should get different amount than m1 with 2x weight');
  });

  it('falls back to equal split when no share weights available for share-weighted mode', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted' },
    };
    const blocks = [makeBlock({ height: 2100, hash: 'h2100', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3, ADDR.miner4];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getMinerShareWeightsForBlock: async () => [],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('no share weights')));
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 4);

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;
    const distributed = minerCredits.reduce((s, m) => s + m.totalSats, 0);
    assert.equal(distributed, remainder);
  });

  it('minActiveMinutes: 0 honored in share-weighted mode', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted', minActiveMinutes: 0 },
    };
    const blocks = [makeBlock({ height: 2200, hash: 'h2200', finder: ADDR.finderA, reward: 50 })];
    const shareWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async (_blockTimestamp, _windowMs, minActiveMs) => {
        assert.equal(minActiveMs, 0);
        return [ADDR.miner1];
      },
      getMinersForBlockWindow: async () => [ADDR.miner1],
      getMinerShareWeightsForBlock: async () => shareWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.minerCredits.some((m) => m.miner === ADDR.miner1));
  });

  it('skips invalid miner addresses in share-weighted mode', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted' },
    };
    const blocks = [makeBlock({ height: 2300, hash: 'h2300', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.invalid, ADDR.badFormat];
    const shareWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
      { miner: ADDR.invalid, totalDifficulty: 50 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getMinerShareWeightsForBlock: async () => shareWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const creditedMiners = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA).map((m) => m.miner);
    assert.ok(!creditedMiners.includes(ADDR.invalid));
    assert.ok(!creditedMiners.includes(ADDR.badFormat));
    assert.ok(creditedMiners.includes(ADDR.miner1));
    assert.ok(plan.skipped.some((s) => s.address === ADDR.invalid));
    assert.ok(plan.skipped.some((s) => s.address === ADDR.badFormat));
  });

  it('share-weighted mode falls back to equal when getMinerShareWeightsForBlock is not provided', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted' },
    };
    const blocks = [makeBlock({ height: 2400, hash: 'h2400', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('share-weighted mode requested but no share weight lookup')));
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 2);
    const amounts = minerCredits.map((m) => m.totalSats).sort((a, b) => a - b);
    assert.ok(amounts[amounts.length - 1] - amounts[0] <= 1, 'Should fall back to equal split');
  });

  it('preserves finder bonus in share-weighted mode', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted' },
    };
    const blocks = [makeBlock({ height: 2500, hash: 'h2500', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getMinerShareWeightsForBlock: async () => [{ miner: ADDR.miner1, totalDifficulty: 50 }],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);

    const finderCredit = plan.minerCredits.find((m) => m.miner === ADDR.finderA);
    assert.ok(finderCredit);
    assert.equal(finderCredit.totalSats, finderBonus);
  });

  it('preserves solo payout behavior unchanged in share-weighted config', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted' },
    };
    // Solo block: mode=solo with payout_address. Finder address = payout_address per logic.
    const blocks = [makeBlock({ height: 2600, hash: 'h2600', finder: ADDR.finderA, reward: 50, mode: 'solo', payout_address: ADDR.miner1 })];
    const activeMiners = [ADDR.miner2];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getMinerShareWeightsForBlock: async () => [{ miner: ADDR.miner2, totalDifficulty: 100 }],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    // Solo block: finder credit goes to payout_address
    const finderCredit = plan.minerCredits.find((m) => m.miner === ADDR.miner1);
    assert.ok(finderCredit);
  });

  it('excludes miners with zero share weight from distribution', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-share-weighted' },
    };
    const blocks = [makeBlock({ height: 2700, hash: 'h2700', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2];
    const shareWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
      { miner: ADDR.miner2, totalDifficulty: 0 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getMinerShareWeightsForBlock: async () => shareWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('have no share weight')));
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    // miner2 with 0 weight should be excluded, only miner1 gets remainder
    const miner2Credit = minerCredits.find((m) => m.miner === ADDR.miner2);
    assert.equal(miner2Credit, undefined);
  });

  // ===========================================================================
  // PPLNS reward model tests
  // ===========================================================================

  it('pplns distributes remainder by PPLNS block-height snapshot weights', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 3000, hash: 'h3000', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3];
    const pplnsWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
      { miner: ADDR.miner2, totalDifficulty: 200 },
      { miner: ADDR.miner3, totalDifficulty: 100 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => pplnsWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;

    const m1 = plan.minerCredits.find((m) => m.miner === ADDR.miner1);
    const m2 = plan.minerCredits.find((m) => m.miner === ADDR.miner2);
    const m3 = plan.minerCredits.find((m) => m.miner === ADDR.miner3);
    const distributed = (m1 ? m1.totalSats : 0) + (m2 ? m2.totalSats : 0) + (m3 ? m3.totalSats : 0);
    assert.equal(distributed, remainder);

    // m2 should get roughly double m1 and m3 (weight 200 vs 100)
    assert.ok(m2.totalSats >= m1.totalSats);
    assert.ok(m2.totalSats >= m3.totalSats);
  });

  it('pplns preserves finder bonus', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 3100, hash: 'h3100', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => [{ miner: ADDR.miner1, totalDifficulty: 50 }],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);

    const finderCredit = plan.minerCredits.find((m) => m.miner === ADDR.finderA);
    assert.ok(finderCredit);
    assert.equal(finderCredit.totalSats, finderBonus);
  });

  it('pplns falls back to equal split when no PPLNS weights available', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 3200, hash: 'h3200', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3, ADDR.miner4];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => [],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('no PPLNS weights found')));
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 4);
    const amounts = minerCredits.map((m) => m.totalSats).sort((a, b) => a - b);
    assert.ok(amounts[amounts.length - 1] - amounts[0] <= 1, 'Should fall back to equal split');
  });

  it('pplns falls back to equal split when getPplnsWeightsForBlock not provided', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 3300, hash: 'h3300', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('PPLNS mode requested but no PPLNS weight lookup')));
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 2);
    const amounts = minerCredits.map((m) => m.totalSats).sort((a, b) => a - b);
    assert.ok(amounts[amounts.length - 1] - amounts[0] <= 1, 'Should fall back to equal split');
  });

  it('pplns solo block not affected', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({
      height: 3400, hash: 'h3400', finder: ADDR.finderA, reward: 50,
      mode: 'solo', payout_address: ADDR.miner1,
    })];
    const activeMiners = [ADDR.miner2];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => [{ miner: ADDR.miner2, totalDifficulty: 100 }],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    // Solo block: finder credit goes to payout_address
    const finderCredit = plan.minerCredits.find((m) => m.miner === ADDR.miner1);
    assert.ok(finderCredit);
  });

  it('pplns existing equal mode unchanged when rewardModel is finder-plus-equal', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'finder-plus-equal' },
    };
    const blocks = [makeBlock({ height: 3500, hash: 'h3500', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2, ADDR.miner3, ADDR.miner4];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => [{ miner: ADDR.miner1, totalDifficulty: 9999 }],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    // Equal split should still be used, ignoring injected PPLNS weights
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    const amounts = minerCredits.map((m) => m.totalSats).sort((a, b) => a - b);
    assert.ok(amounts[amounts.length - 1] - amounts[0] <= 1, 'Equal mode should produce nearly equal amounts');
  });

  // ===========================================================================
  // PPLNS snapshot database tests (rolling-window model, production code paths)
  // ===========================================================================

  it('pplns snapshot: share can be included in two nearby block snapshots using production method', async () => {
    const testDb = new DatabaseManager(':memory:');
    testDb.init();
    const now = Date.now();

    await testDb.run(
      `INSERT INTO shares (miner, difficulty, timestamp, valid) VALUES
       (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
      [ADDR.miner1, 100, now - 500, 1, ADDR.miner1, 150, now - 400, 1,
       ADDR.miner2, 80, now - 300, 1, ADDR.miner2, 120, now - 200, 1,
       ADDR.miner3, 60, now - 100, 1],
      'insert.shares'
    );

    // Block 1: windowDiff=150 — newest-first: miner3/60, miner2/120, miner1/150
    await testDb.snapshotPplnsWindowForBlock(5001, 150);
    // Block 2: windowDiff=100 — newest-first: miner3/60, miner2/120
    await testDb.snapshotPplnsWindowForBlock(5002, 100);

    const w1 = await testDb.getPplnsWeightsForBlock(5001);
    const w2 = await testDb.getPplnsWeightsForBlock(5002);

    const w1Miners = new Set(w1.map(r => r.miner));
    const w2Miners = new Set(w2.map(r => r.miner));
    assert.ok(w1Miners.has(ADDR.miner2), 'miner2 should be in block 5001 window');
    assert.ok(w2Miners.has(ADDR.miner2), 'miner2 should be in block 5002 window');
    assert.ok(w1Miners.has(ADDR.miner3), 'miner3 should be in block 5001 window');
    assert.ok(w2Miners.has(ADDR.miner3), 'miner3 should be in block 5002 window');

    testDb.getConnection().close();
  });

  it('pplns snapshot: idempotent — second call for same block does not duplicate rows', async () => {
    const testDb = new DatabaseManager(':memory:');
    testDb.init();
    const now = Date.now();

    await testDb.run(
      `INSERT INTO shares (miner, difficulty, timestamp, valid) VALUES (?, ?, ?, ?)`,
      [ADDR.miner1, 500, now - 100, 1],
      'insert.shares'
    );
    await testDb.snapshotPplnsWindowForBlock(6001, 200);

    const allSql = (sql, params) => new Promise((resolve, reject) => {
      testDb.getConnection().all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows || []); });
    });
    const before = (await allSql('SELECT COUNT(*) as cnt FROM pplns_windows WHERE block_height = 6001', []))[0].cnt;

    // Call again — should be idempotent
    const result = await testDb.snapshotPplnsWindowForBlock(6001, 200);
    const after = (await allSql('SELECT COUNT(*) as cnt FROM pplns_windows WHERE block_height = 6001', []))[0].cnt;
    assert.equal(after, before, 'second snapshot should not add rows');
    assert.deepStrictEqual(result, [], 'second snapshot should return empty array');

    testDb.getConnection().close();
  });

  it('pplns snapshot: getPplnsWeightsForBlock returns correct aggregated weights', async () => {
    const testDb = new DatabaseManager(':memory:');
    testDb.init();
    const now = Date.now();

    await testDb.run(
      `INSERT INTO shares (miner, difficulty, timestamp, valid) VALUES
       (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
      [ADDR.miner1, 100, now - 300, 1, ADDR.miner1, 50, now - 200, 1, ADDR.miner2, 200, now - 100, 1],
      'insert.shares'
    );
    await testDb.snapshotPplnsWindowForBlock(7001, 300);

    const weights = await testDb.getPplnsWeightsForBlock(7001);
    const byMiner = new Map();
    for (const w of weights) byMiner.set(w.miner, w.totalDifficulty);

    assert.ok(byMiner.has(ADDR.miner1), 'miner1 should be in weights');
    assert.ok(byMiner.get(ADDR.miner1) > 100, 'miner1 total should aggregate both shares');
    assert.ok(byMiner.has(ADDR.miner2), 'miner2 should be in weights');
    assert.equal(byMiner.get(ADDR.miner2), 200, 'miner2 total should match');

    testDb.getConnection().close();
  });

  it('pplns snapshot: fresh migration does not require pre-created shares table', async () => {
    const freshDb = new sqlite3.Database(':memory:');
    const runner = new MigrationRunner(freshDb, migrationsDir);
    await runner.applyMigrations();

    const allSql = (sql, params = []) => new Promise((resolve, reject) => {
      freshDb.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows || []); });
    });

    const tables = await allSql("SELECT name FROM sqlite_master WHERE type='table' AND name = 'pplns_windows'", []);
    assert.ok(tables.length > 0, 'pplns_windows table should exist after fresh migration');

    const idx = await allSql("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_pplns_windows_block_height'", []);
    assert.ok(idx.length > 0, 'idx_pplns_windows_block_height index should exist after fresh migration');

    freshDb.close();
  });

  // ===========================================================================
  // PPLNS planner semantics — snapshot miners independent of active window
  // ===========================================================================

  it('pplns pays snapshot miners even when active/window lookups return empty', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 8001, hash: 'h8001', finder: ADDR.finderA, reward: 50 })];
    const pplnsWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
      { miner: ADDR.miner2, totalDifficulty: 200 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => [],
      getMinersForBlockWindow: async () => [],
      getPplnsWeightsForBlock: async () => pplnsWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const gross = hempToSatsNumber(50);
    const fee = Math.floor(gross * 0.01);
    const net = gross - fee;
    const finderBonus = Math.floor(net * 0.2);
    const remainder = net - finderBonus;

    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 2, 'both snapshot miners should get credited');
    const distributed = minerCredits.reduce((sum, m) => sum + m.totalSats, 0);
    assert.equal(distributed, remainder, 'full remainder should be distributed');
  });

  it('pplns pays a snapshot miner who is not in the active miner list', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 8002, hash: 'h8002', finder: ADDR.finderA, reward: 50 })];
    // miner3 is NOT in activeMiners but IS in PPLNS snapshot
    const activeMiners = [ADDR.miner1, ADDR.miner2];
    const pplnsWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
      { miner: ADDR.miner3, totalDifficulty: 50 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => pplnsWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 2, 'both snapshot miners should get credited');
    const miner3Credit = minerCredits.find((m) => m.miner === ADDR.miner3);
    assert.ok(miner3Credit, 'miner3 should be credited even though not in activeMiners');
    assert.ok(miner3Credit.totalSats > 0, 'miner3 should get positive sats');
  });

  it('pplns skips invalid snapshot miner addresses and pays valid snapshot miners', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 8003, hash: 'h8003', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [];
    const pplnsWeights = [
      { miner: ADDR.miner1, totalDifficulty: 100 },
      { miner: ADDR.invalid, totalDifficulty: 200 },
    ];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => pplnsWeights,
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('invalid PPLNS snapshot miner address')), 'should warn about invalid snapshot miner');
    const minerCredits = plan.minerCredits.filter((m) => m.miner !== ADDR.finderA);
    assert.equal(minerCredits.length, 1, 'only valid snapshot miner should get credited');
    assert.equal(minerCredits[0].miner, ADDR.miner1);
  });

  it('pplns planner: missing snapshot falls back to equal active-window split', async () => {
    const config = {
      ...buildConfig(),
      pool: { ...buildConfig().pool, rewardModel: 'pplns' },
    };
    const blocks = [makeBlock({ height: 99999, hash: 'h99999', finder: ADDR.finderA, reward: 50 })];
    const activeMiners = [ADDR.miner1, ADDR.miner2];

    const plan = await planPayout({
      blocks,
      getActiveMinersForBlock: async () => activeMiners,
      getMinersForBlockWindow: async () => activeMiners,
      getPplnsWeightsForBlock: async () => [],
      config,
      payoutLedger: ledger,
      minPayoutSats: 0,
    });

    assert.ok(plan.warnings.some((w) => w.includes('no PPLNS weights found')));
  });

  it('pplns: worker/admin db shim includes getPplnsWeightsForBlock', async () => {
    // Verify that the production DatabaseManager exposes the method
    const testDb = new DatabaseManager(':memory:');
    testDb.init();
    assert.ok(typeof testDb.snapshotPplnsWindowForBlock === 'function', 'snapshotPplnsWindowForBlock should be a function');
    assert.ok(typeof testDb.getPplnsWeightsForBlock === 'function', 'getPplnsWeightsForBlock should be a function');
    testDb.getConnection().close();

    // Verify payout-worker.js shim includes getPplnsWeightsForBlock via source check
    const fs = require('fs');
    const workerSrc = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'payout-worker.js'), 'utf8');
    assert.ok(workerSrc.includes('getPplnsWeightsForBlock'), 'payout-worker.js should include getPplnsWeightsForBlock');

    const adminSrc = fs.readFileSync(path.resolve(__dirname, '..', 'adminApi.js'), 'utf8');
    assert.ok(adminSrc.includes('getPplnsWeightsForBlock'), 'adminApi.js should include getPplnsWeightsForBlock');
  });
});
