const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MigrationRunner } = require('../migrations');
const { PayoutLedger, SATS_PER_HEMP, CANONICAL_RUN_STATUSES, CANONICAL_BATCH_STATUSES } = require('../payoutLedger');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

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

describe('PayoutLedger', () => {
    /** @type {sqlite3.Database} */
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

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    it('exports correct SATS_PER_HEMP constant', () => {
        assert.equal(SATS_PER_HEMP, 100000000);
    });

    it('exports canonical run statuses', () => {
        for (const s of ['planned', 'credited', 'batch_created', 'broadcasting', 'broadcasted', 'confirmed', 'failed', 'replaced']) {
            assert.ok(CANONICAL_RUN_STATUSES.has(s));
        }
    });

    it('exports the fail-closed ambiguous broadcast batch status', () => {
        assert.ok(CANONICAL_BATCH_STATUSES.has('broadcast_unknown'));
    });

    // -------------------------------------------------------------------------
    // Runs
    // -------------------------------------------------------------------------

    it('creates a payout run with defaults', async () => {
        const run = await ledger.createRun({});
        assert.ok(run.id > 0);
        assert.equal(run.status, 'planned');
        assert.equal(run.total_blocks, 0);
        assert.equal(run.total_amount_sats, 0);
        assert.equal(run.net_amount_sats, 0);
    });

    it('creates a payout run with explicit fields', async () => {
        const run = await ledger.createRun({
            blockHeightStart: 1000,
            blockHeightEnd: 1010,
            totalBlocks: 11,
            totalMiners: 5,
            totalAmountSats: 50000000000,
            feeAmountSats: 500000000,
            netAmountSats: 49500000000,
        });
        assert.equal(run.block_height_start, 1000);
        assert.equal(run.block_height_end, 1010);
        assert.equal(run.total_blocks, 11);
        assert.equal(run.total_miners, 5);
        assert.equal(run.total_amount_sats, 50000000000);
        assert.equal(run.fee_amount_sats, 500000000);
        assert.equal(run.net_amount_sats, 49500000000);
    });

    it('gets a run by id', async () => {
        const created = await ledger.createRun({ totalMiners: 3 });
        const fetched = await ledger.getRun(created.id);
        assert.equal(fetched.id, created.id);
        assert.equal(fetched.total_miners, 3);
    });

    it('gets all runs', async () => {
        await ledger.createRun({});
        await ledger.createRun({});
        const runs = await ledger.getAllRuns();
        assert.ok(runs.length >= 2);
    });

    it('gets runs by status', async () => {
        const planned = await ledger.getRunsByStatus('planned');
        assert.ok(planned.length >= 1);
        for (const r of planned) {
            assert.equal(r.status, 'planned');
        }
    });

    it('rejects invalid run status on query', async () => {
        await assert.rejects(
            () => ledger.getRunsByStatus('invalid'),
            /Invalid payout run status/
        );
    });

    it('updates run status to credited', async () => {
        const run = await ledger.createRun({});
        await ledger.updateRunStatus(run.id, 'credited');
        const updated = await ledger.getRun(run.id);
        assert.equal(updated.status, 'credited');
    });

    it('updates run status to failed with error', async () => {
        const run = await ledger.createRun({});
        await ledger.updateRunStatus(run.id, 'failed', 'insufficient balance');
        const updated = await ledger.getRun(run.id);
        assert.equal(updated.status, 'failed');
        assert.equal(updated.error, 'insufficient balance');
        assert.ok(updated.completed_at > 0);
    });

    it('rejects invalid run status on update', async () => {
        const run = await ledger.createRun({});
        await assert.rejects(
            () => ledger.updateRunStatus(run.id, 'nonsense'),
            /Invalid payout run status/
        );
    });

    it('gets stalled runs (non-terminal statuses)', async () => {
        await ledger.createRun({});
        const stalled = await ledger.getStalledRuns();
        assert.ok(stalled.length >= 1);
        for (const r of stalled) {
            assert.ok(['planned','credited','batch_created','broadcasting','broadcasted'].includes(r.status));
        }
    });

    // -------------------------------------------------------------------------
    // Block Credits
    // -------------------------------------------------------------------------

    it('creates a block credit with integer sats', async () => {
        const run = await ledger.createRun({});
        const credit = await ledger.createBlockCredit({
            runId: run.id,
            height: 12345,
            hash: 'abc123def456',
            finder: 'RXexample111111111111111111111111',
            mode: 'pool',
            rewardSats: 50000000000,
            feeDeductedSats: 0,
            finderBonusSats: 10000000000,
            remainderSats: 40000000000,
            minerCount: 4,
        });
        assert.ok(credit.id > 0);
        assert.equal(credit.run_id, run.id);
        assert.equal(credit.height, 12345);
        assert.equal(credit.reward_sats, 50000000000);
        assert.equal(credit.finder_bonus_sats, 10000000000);
        assert.equal(credit.remainder_sats, 40000000000);
        assert.equal(credit.miner_count, 4);
    });

    it('stores and retrieves large integer sats precisely', async () => {
        const run = await ledger.createRun({});
        const largeAmount = 9007199254740991;
        const credit = await ledger.createBlockCredit({
            runId: run.id,
            height: 99999,
            hash: 'large_amount_test',
            finder: 'RXtest1111111111111111111111111',
            mode: 'pool',
            rewardSats: largeAmount,
            feeDeductedSats: 0,
            finderBonusSats: 0,
            remainderSats: largeAmount,
            minerCount: 1,
        });
        assert.equal(credit.reward_sats, largeAmount);
        assert.equal(credit.remainder_sats, largeAmount);

        const fetched = await ledger.getBlockCreditByRunAndHeight(run.id, 99999);
        assert.equal(fetched.reward_sats, largeAmount);
        assert.equal(typeof fetched.reward_sats, 'number');
        assert.equal(fetched.reward_sats, largeAmount, 'roundtrip should preserve exact value');
    });

    it('enforces uniqueness on (run_id, height)', async () => {
        const run = await ledger.createRun({});
        await ledger.createBlockCredit({
            runId: run.id, height: 100, hash: 'hash1',
            finder: 'RXtest1111111111111111111111111',
            mode: 'pool', rewardSats: 1000, feeDeductedSats: 0,
            finderBonusSats: 0, remainderSats: 1000, minerCount: 1,
        });
        await assert.rejects(
            () => ledger.createBlockCredit({
                runId: run.id, height: 100, hash: 'hash2',
                finder: 'RXtest2222222222222222222222222',
                mode: 'pool', rewardSats: 2000, feeDeductedSats: 0,
                finderBonusSats: 0, remainderSats: 2000, minerCount: 1,
            }),
            /UNIQUE constraint failed/
        );
    });

    it('gets block credits for a run', async () => {
        const run = await ledger.createRun({});
        await ledger.createBlockCredit({
            runId: run.id, height: 200, hash: 'h200',
            finder: 'RXfind1111111111111111111111111',
            mode: 'pool', rewardSats: 1000, feeDeductedSats: 0,
            finderBonusSats: 200, remainderSats: 800, minerCount: 2,
        });
        await ledger.createBlockCredit({
            runId: run.id, height: 201, hash: 'h201',
            finder: 'RXfind2222222222222222222222222',
            mode: 'pool', rewardSats: 2000, feeDeductedSats: 0,
            finderBonusSats: 400, remainderSats: 1600, minerCount: 3,
        });
        const credits = await ledger.getBlockCreditsForRun(run.id);
        assert.equal(credits.length, 2);
        assert.equal(credits[0].height, 200);
        assert.equal(credits[1].height, 201);
    });

    it('finds heights with payout batches already in flight or settled', async () => {
        const settledRun = await ledger.createRun({});
        const settledCredit = await ledger.createBlockCredit({
            runId: settledRun.id, height: 202, hash: 'h202',
            finder: 'RXfind3333333333333333333333333', mode: 'pool',
            rewardSats: 1000, feeDeductedSats: 0, finderBonusSats: 0,
            remainderSats: 1000, minerCount: 1,
        });
        const settledBatch = await ledger.createBatch({
            runId: settledRun.id, batchIndex: 0, totalAmountSats: 1000,
        });
        await ledger.updateBatchStatus(settledBatch.id, 'broadcasted', { txid: 'settled-tx' });

        const confirmedRun = await ledger.createRun({});
        await ledger.createBlockCredit({
            runId: confirmedRun.id, height: 203, hash: 'h203',
            finder: 'RXfind4444444444444444444444444', mode: 'pool',
            rewardSats: 1000, feeDeductedSats: 0, finderBonusSats: 0,
            remainderSats: 1000, minerCount: 1,
        });
        const confirmedBatch = await ledger.createBatch({
            runId: confirmedRun.id, batchIndex: 0, totalAmountSats: 1000,
        });
        await ledger.updateBatchStatus(confirmedBatch.id, 'confirmed');

        const unknownRun = await ledger.createRun({});
        await ledger.createBlockCredit({
            runId: unknownRun.id, height: 205, hash: 'h205',
            finder: 'RXfind6666666666666666666666666', mode: 'pool',
            rewardSats: 1000, feeDeductedSats: 0, finderBonusSats: 0,
            remainderSats: 1000, minerCount: 1,
        });
        const unknownBatch = await ledger.createBatch({
            runId: unknownRun.id, batchIndex: 0, totalAmountSats: 1000,
        });
        await ledger.updateBatchStatus(unknownBatch.id, 'broadcast_unknown', {
            error: 'Broadcast outcome uncertain; automatic retry disabled: RPC sendmany timed out',
        });

        const createdRun = await ledger.createRun({});
        await ledger.createBlockCredit({
            runId: createdRun.id, height: 204, hash: 'h204',
            finder: 'RXfind5555555555555555555555555', mode: 'pool',
            rewardSats: 1000, feeDeductedSats: 0, finderBonusSats: 0,
            remainderSats: 1000, minerCount: 1,
        });
        const createdBatch = await ledger.createBatch({
            runId: createdRun.id, batchIndex: 0, totalAmountSats: 1000,
        });
        await ledger.createBatchOutput({
            batchId: createdBatch.id,
            address: 'RXminer333333333333333333333333',
            amountSats: 1000,
        });

        const settledHeights = await ledger.getHeightsWithBroadcastedBatches([202, 203, 204, 204, 205]);
        assert.deepEqual(settledHeights.sort((a, b) => a - b), [202, 203, 205]);
        assert.ok(settledCredit.id > 0);
    });

    // -------------------------------------------------------------------------
    // Miner Credits
    // -------------------------------------------------------------------------

    it('creates miner credits with valid categories', async () => {
        const run = await ledger.createRun({});
        const blockCredit = await ledger.createBlockCredit({
            runId: run.id, height: 300, hash: 'h300',
            finder: 'RXfind1111111111111111111111111',
            mode: 'pool', rewardSats: 5000, feeDeductedSats: 0,
            finderBonusSats: 1000, remainderSats: 4000, minerCount: 2,
        });

        const finderCredit = await ledger.createMinerCredit({
            blockCreditId: blockCredit.id,
            miner: 'RXfind1111111111111111111111111',
            category: 'finder',
            amountSats: 1000,
        });
        assert.equal(finderCredit.category, 'finder');
        assert.equal(finderCredit.amount_sats, 1000);

        const poolCredit = await ledger.createMinerCredit({
            blockCreditId: blockCredit.id,
            miner: 'RXpooler111111111111111111111111',
            category: 'pool',
            amountSats: 2000,
        });
        assert.equal(poolCredit.category, 'pool');

        const fbCredit = await ledger.createMinerCredit({
            blockCreditId: blockCredit.id,
            miner: 'RXfallbk111111111111111111111111',
            category: 'finder_fallback',
            amountSats: 2000,
        });
        assert.equal(fbCredit.category, 'finder_fallback');
    });

    it('rejects invalid miner credit category', async () => {
        await assert.rejects(
            () => ledger.createMinerCredit({
                blockCreditId: 1, miner: 'RXtest1111111111111111111111111',
                category: 'INVALID_CATEGORY', amountSats: 100,
            }),
            /Invalid miner credit category/
        );
    });

    it('enforces uniqueness on (block_credit_id, miner, category)', async () => {
        const run = await ledger.createRun({});
        const bc = await ledger.createBlockCredit({
            runId: run.id, height: 400, hash: 'h400',
            finder: 'RXfind1111111111111111111111111',
            mode: 'pool', rewardSats: 1000, feeDeductedSats: 0,
            finderBonusSats: 200, remainderSats: 800, minerCount: 1,
        });
        await ledger.createMinerCredit({
            blockCreditId: bc.id, miner: 'RXminer111111111111111111111111',
            category: 'pool', amountSats: 800,
        });
        await assert.rejects(
            () => ledger.createMinerCredit({
                blockCreditId: bc.id, miner: 'RXminer111111111111111111111111',
                category: 'pool', amountSats: 800,
            }),
            /UNIQUE constraint failed/
        );
    });

    it('gets miner credits for a block', async () => {
        const run = await ledger.createRun({});
        const bc = await ledger.createBlockCredit({
            runId: run.id, height: 500, hash: 'h500',
            finder: 'RXfind1111111111111111111111111',
            mode: 'pool', rewardSats: 5000, feeDeductedSats: 0,
            finderBonusSats: 1000, remainderSats: 4000, minerCount: 2,
        });
        await ledger.createMinerCredit({ blockCreditId: bc.id, miner: 'RXa111111111111111111111111111', category: 'pool', amountSats: 2000 });
        await ledger.createMinerCredit({ blockCreditId: bc.id, miner: 'RXb111111111111111111111111111', category: 'pool', amountSats: 2000 });

        const credits = await ledger.getMinerCreditsForBlock(bc.id);
        assert.equal(credits.length, 2);
    });

    it('gets miner credits for a run across all blocks', async () => {
        const run = await ledger.createRun({});
        const bc1 = await ledger.createBlockCredit({
            runId: run.id, height: 600, hash: 'h600',
            finder: 'RXf111111111111111111111111111',
            mode: 'pool', rewardSats: 1000, feeDeductedSats: 0,
            finderBonusSats: 200, remainderSats: 800, minerCount: 1,
        });
        const bc2 = await ledger.createBlockCredit({
            runId: run.id, height: 601, hash: 'h601',
            finder: 'RXf222111111111111111111111111',
            mode: 'pool', rewardSats: 1000, feeDeductedSats: 0,
            finderBonusSats: 200, remainderSats: 800, minerCount: 1,
        });
        await ledger.createMinerCredit({ blockCreditId: bc1.id, miner: 'RXm111111111111111111111111111', category: 'pool', amountSats: 800 });
        await ledger.createMinerCredit({ blockCreditId: bc2.id, miner: 'RXm211111111111111111111111111', category: 'pool', amountSats: 800 });

        const runCredits = await ledger.getMinerCreditsForRun(run.id);
        assert.equal(runCredits.length, 2);
    });

    // -------------------------------------------------------------------------
    // Batches
    // -------------------------------------------------------------------------

    it('creates a batch with defaults', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({
            runId: run.id,
            batchIndex: 0,
            totalAmountSats: 100000000,
            outputCount: 2,
        });
        assert.ok(batch.id > 0);
        assert.equal(batch.status, 'created');
        assert.equal(batch.batch_index, 0);
        assert.equal(batch.total_amount_sats, 100000000);
        assert.equal(batch.output_count, 2);
    });

    it('enforces uniqueness on (run_id, batch_index)', async () => {
        const run = await ledger.createRun({});
        await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 100 });
        await assert.rejects(
            () => ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 200 }),
            /UNIQUE constraint failed/
        );
    });

    it('gets batches for a run ordered by index', async () => {
        const run = await ledger.createRun({});
        await ledger.createBatch({ runId: run.id, batchIndex: 1, totalAmountSats: 200 });
        await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 100 });

        const batches = await ledger.getBatchesForRun(run.id);
        assert.equal(batches.length, 2);
        assert.equal(batches[0].batch_index, 0);
        assert.equal(batches[1].batch_index, 1);
    });

    it('updates batch status to broadcasting with txid', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 500 });
        await ledger.updateBatchStatus(batch.id, 'broadcasted', { txid: 'abc123txid' });

        const updated = await ledger.getBatch(batch.id);
        assert.equal(updated.status, 'broadcasted');
        assert.equal(updated.txid, 'abc123txid');
        assert.ok(updated.broadcast_at > 0);
    });

    it('updates batch status to confirmed', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 500 });
        await ledger.updateBatchStatus(batch.id, 'confirmed');
        const updated = await ledger.getBatch(batch.id);
        assert.equal(updated.status, 'confirmed');
        assert.ok(updated.confirmed_at > 0);
    });

    it('updates batch status to failed with error', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 500 });
        await ledger.updateBatchStatus(batch.id, 'failed', { error: 'RPC timeout' });
        const updated = await ledger.getBatch(batch.id);
        assert.equal(updated.status, 'failed');
        assert.equal(updated.error, 'RPC timeout');
    });

    it('rejects invalid batch status on update', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0 });
        await assert.rejects(
            () => ledger.updateBatchStatus(batch.id, 'invalid_status'),
            /Invalid batch status/
        );
    });

    it('gets batches by status', async () => {
        const run = await ledger.createRun({});
        await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 100 });
        await ledger.createBatch({ runId: run.id, batchIndex: 1, totalAmountSats: 200 });
        const created = await ledger.getBatchesByStatus('created');
        assert.ok(created.length >= 2);
    });

    // -------------------------------------------------------------------------
    // Batch Outputs
    // -------------------------------------------------------------------------

    it('creates batch outputs', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 3000 });
        const out1 = await ledger.createBatchOutput({
            batchId: batch.id, address: 'RXaddr1111111111111111111111111', amountSats: 1000, category: 'pool',
        });
        const out2 = await ledger.createBatchOutput({
            batchId: batch.id, address: 'RXaddr2111111111111111111111111', amountSats: 2000, category: 'finder',
        });
        assert.equal(out1.amount_sats, 1000);
        assert.equal(out1.category, 'pool');
        assert.equal(out2.amount_sats, 2000);
        assert.equal(out2.category, 'finder');
    });

    it('enforces uniqueness on (batch_id, address, category)', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0 });
        await ledger.createBatchOutput({ batchId: batch.id, address: 'RXaddr1111111111111111111111111', amountSats: 100 });
        await assert.rejects(
            () => ledger.createBatchOutput({ batchId: batch.id, address: 'RXaddr1111111111111111111111111', amountSats: 200 }),
            /UNIQUE constraint failed/
        );
    });

    it('gets all outputs for a batch', async () => {
        const run = await ledger.createRun({});
        const batch = await ledger.createBatch({ runId: run.id, batchIndex: 0, totalAmountSats: 3000 });
        await ledger.createBatchOutput({ batchId: batch.id, address: 'RXa111111111111111111111111111', amountSats: 1000 });
        await ledger.createBatchOutput({ batchId: batch.id, address: 'RXb111111111111111111111111111', amountSats: 2000 });
        const outputs = await ledger.getBatchOutputs(batch.id);
        assert.equal(outputs.length, 2);
    });

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    it('creates payout events', async () => {
        const run = await ledger.createRun({});
        const evt = await ledger.createEvent({
            runId: run.id, eventType: 'run_created', detail: 'Created by payout worker',
        });
        assert.ok(evt.id > 0);
        assert.equal(evt.run_id, run.id);
        assert.equal(evt.event_type, 'run_created');
        assert.equal(evt.detail, 'Created by payout worker');
    });

    it('gets events for a run', async () => {
        const run = await ledger.createRun({});
        await ledger.createEvent({ runId: run.id, eventType: 'planned' });
        await ledger.createEvent({ runId: run.id, eventType: 'credited' });
        const events = await ledger.getEventsForRun(run.id);
        assert.equal(events.length, 2);
    });

    // -------------------------------------------------------------------------
    // Integer precision
    // -------------------------------------------------------------------------

    it('handles zero amounts correctly', async () => {
        const run = await ledger.createRun({
            totalAmountSats: 0, feeAmountSats: 0, netAmountSats: 0,
        });
        assert.equal(run.total_amount_sats, 0);
        assert.equal(run.fee_amount_sats, 0);
        assert.equal(run.net_amount_sats, 0);
    });

    it('handles large but safe integer amounts', async () => {
        const amount = 123456789012345;
        const run = await ledger.createRun({
            totalAmountSats: amount,
            netAmountSats: amount,
        });
        const fetched = await ledger.getRun(run.id);
        assert.equal(fetched.total_amount_sats, amount);
        assert.equal(fetched.net_amount_sats, amount);
    });

    it('rejects negative and unsafe integer amounts', async () => {
        const run = await ledger.createRun({});
        await assert.rejects(
            () => ledger.createRun({ totalAmountSats: -1 }),
            /non-negative safe integer/
        );
        await assert.rejects(
            () => ledger.createBlockCredit({
                runId: run.id,
                height: 888001,
                hash: 'negative_amount',
                finder: 'RXfind1111111111111111111111111',
                mode: 'pool',
                rewardSats: -1,
                feeDeductedSats: 0,
                finderBonusSats: 0,
                remainderSats: 0,
                minerCount: 1,
            }),
            /non-negative safe integer/
        );
        await assert.rejects(
            () => ledger.createBatch({ runId: run.id, batchIndex: 800, totalAmountSats: Number.MAX_SAFE_INTEGER + 1 }),
            /non-negative safe integer/
        );
    });
});
