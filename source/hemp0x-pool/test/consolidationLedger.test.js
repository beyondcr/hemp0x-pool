const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MigrationRunner } = require('../migrations');
const { ConsolidationLedger, SATS_PER_HEMP, CANONICAL_PLAN_STATUSES, CANONICAL_BATCH_STATUSES } = require('../consolidationLedger');

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

describe('ConsolidationLedger', () => {
    /** @type {sqlite3.Database} */
    let db;
    let ledger;

    before(async () => {
        db = createDb();
        await setupDb(db);
        ledger = new ConsolidationLedger(db);
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

    it('exports canonical plan statuses', () => {
        for (const s of ['draft', 'approved', 'rejected', 'completed', 'partial', 'failed']) {
            assert.ok(CANONICAL_PLAN_STATUSES.has(s));
        }
    });

    it('exports canonical batch statuses', () => {
        for (const s of ['draft', 'approved', 'broadcasting', 'broadcasted', 'confirmed', 'failed', 'abandoned']) {
            assert.ok(CANONICAL_BATCH_STATUSES.has(s));
        }
    });

    // -------------------------------------------------------------------------
    // Plans
    // -------------------------------------------------------------------------

    it('creates a plan in draft status', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: { dryRunOnly: true },
        });
        assert.ok(plan.plan_id);
        assert.match(plan.plan_id, /^cplan_/);
        assert.equal(plan.status, 'draft');
        assert.equal(plan.destination_address, 'RXdest11111111111111111111111111');
        assert.equal(plan.total_batches, 0);
        assert.equal(plan.total_input_sats, 0);
    });

    it('rejects plan without destinationAddress', async () => {
        await assert.rejects(
            () => ledger.createPlan({ configSnapshot: {} }),
            /destinationAddress/
        );
    });

    it('rejects plan without configSnapshot', async () => {
        await assert.rejects(
            () => ledger.createPlan({ destinationAddress: 'RXdest11111111111111111111111111' }),
            /configSnapshot/
        );
    });

    it('gets a plan by plan_id', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: { dryRunOnly: true },
        });
        const fetched = await ledger.getPlan(plan.plan_id);
        assert.equal(fetched.plan_id, plan.plan_id);
        assert.equal(fetched.status, 'draft');
    });

    it('returns undefined for non-existent plan', async () => {
        const result = await ledger.getPlan('cplan_nonexistent');
        assert.equal(result, undefined);
    });

    it('gets all plans', async () => {
        await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const plans = await ledger.getAllPlans();
        assert.ok(plans.length >= 1);
    });

    it('gets plans by status', async () => {
        const drafts = await ledger.getPlansByStatus('draft');
        assert.ok(drafts.length >= 1);
    });

    it('rejects invalid plan status on query', async () => {
        await assert.rejects(
            () => ledger.getPlansByStatus('nonsense'),
            /Invalid plan status/
        );
    });

    // -------------------------------------------------------------------------
    // Plan Approval / Rejection
    // -------------------------------------------------------------------------

    it('approves a draft plan', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: { test: true },
        });
        const approved = await ledger.approvePlan(plan.plan_id, 'test-operator');
        assert.equal(approved.status, 'approved');
        assert.equal(approved.operator_approved_by, 'test-operator');
        assert.ok(approved.operator_approved_at > 0);
    });

    it('rejects a draft plan', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const rejected = await ledger.rejectPlan(plan.plan_id, 'test-operator');
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.operator_approved_by, 'test-operator');
    });

    it('cannot approve an already-approved plan', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        await ledger.approvePlan(plan.plan_id, 'op');
        await assert.rejects(
            () => ledger.approvePlan(plan.plan_id, 'op'),
            /Cannot approve plan/
        );
    });

    it('cannot reject an already-rejected plan', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        await ledger.rejectPlan(plan.plan_id, 'op');
        await assert.rejects(
            () => ledger.rejectPlan(plan.plan_id, 'op'),
            /Cannot reject plan/
        );
    });

    it('cannot approve a non-existent plan', async () => {
        await assert.rejects(
            () => ledger.approvePlan('cplan_nonexistent', 'op'),
            /not found/
        );
    });

    // -------------------------------------------------------------------------
    // Plan Counts Update
    // -------------------------------------------------------------------------

    it('updates plan counts', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        await ledger.updatePlanCounts(plan.plan_id, {
            totalBatches: 5,
            totalInputs: 100,
            totalInputSats: 50000000000,
            totalFeeSats: 1000000,
        });
        const updated = await ledger.getPlan(plan.plan_id);
        assert.equal(updated.total_batches, 5);
        assert.equal(updated.total_inputs, 100);
        assert.equal(updated.total_input_sats, 50000000000);
        assert.equal(updated.total_fee_sats, 1000000);
    });

    // -------------------------------------------------------------------------
    // Batches
    // -------------------------------------------------------------------------

    it('creates a batch under a plan', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id,
            batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
            totalInputSats: 100000000,
            estimatedFeeSats: 10000,
            estimatedTxSizeBytes: 5000,
        });
        assert.ok(batch.batch_id);
        assert.match(batch.batch_id, /^cplan_.*_b0$/);
        assert.equal(batch.status, 'draft');
        assert.equal(batch.total_input_sats, 100000000);
        assert.equal(batch.estimated_fee_sats, 10000);
        assert.equal(batch.estimated_tx_size_bytes, 5000);
    });

    it('fails creating batch for non-existent plan', async () => {
        await assert.rejects(
            () => ledger.createBatch({
                planId: 'cplan_nonexistent', batchIndex: 0,
                destinationAddress: 'RXdest11111111111111111111111111',
            }),
            /not found/
        );
    });

    it('gets batches for a plan', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 1,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        const batches = await ledger.getBatchesForPlan(plan.plan_id);
        assert.equal(batches.length, 2);
        assert.equal(batches[0].batch_index, 0);
        assert.equal(batches[1].batch_index, 1);
    });

    it('approves a draft batch', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        const approved = await ledger.approveBatch(batch.batch_id);
        assert.equal(approved.status, 'approved');
    });

    it('cannot approve a non-draft batch', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await ledger.approveBatch(batch.batch_id);
        await assert.rejects(
            () => ledger.approveBatch(batch.batch_id),
            /Cannot approve batch/
        );
    });

    it('updates batch status to broadcasting with txid', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await ledger.updateBatchStatus(batch.batch_id, 'broadcasted', { txid: 'txid_abc123' });
        const updated = await ledger.getBatch(batch.batch_id);
        assert.equal(updated.status, 'broadcasted');
        assert.equal(updated.txid, 'txid_abc123');
        assert.ok(updated.broadcast_at > 0);
    });

    it('updates batch status to confirmed with confirmations', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await ledger.updateBatchStatus(batch.batch_id, 'confirmed', { confirmations: 6 });
        const updated = await ledger.getBatch(batch.batch_id);
        assert.equal(updated.status, 'confirmed');
        assert.equal(updated.confirmations, 6);
        assert.ok(updated.confirmed_at > 0);
    });

    it('updates batch status to failed with error and increments retry', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await ledger.updateBatchStatus(batch.batch_id, 'failed', { errorMessage: 'RPC error' });
        const updated = await ledger.getBatch(batch.batch_id);
        assert.equal(updated.status, 'failed');
        assert.equal(updated.error_message, 'RPC error');
        assert.equal(updated.retry_count, 1);
    });

    it('rejects invalid batch status on update', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await assert.rejects(
            () => ledger.updateBatchStatus(batch.batch_id, 'invalid_status'),
            /Invalid batch status/
        );
    });

    it('gets batches by status', async () => {
        const drafts = await ledger.getBatchesByStatus('draft');
        assert.ok(drafts.length >= 1);
    });

    // -------------------------------------------------------------------------
    // Batch Inputs
    // -------------------------------------------------------------------------

    it('creates batch inputs', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        const input = await ledger.createBatchInput({
            batchId: batch.batch_id,
            txid: 'prev_txid_123abc',
            vout: 0,
            amountSats: 5000000000,
            confirmations: 500,
            address: 'RXaddr11111111111111111111111111',
        });
        assert.ok(input.id > 0);
        assert.equal(input.txid, 'prev_txid_123abc');
        assert.equal(input.vout, 0);
        assert.equal(input.amount_sats, 5000000000);
        assert.equal(input.confirmations, 500);
    });

    it('gets all inputs for a batch', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await ledger.createBatchInput({
            batchId: batch.batch_id, txid: 'tx1', vout: 0,
            amountSats: 100000000, confirmations: 100, address: 'RXa111111111111111111111111111',
        });
        await ledger.createBatchInput({
            batchId: batch.batch_id, txid: 'tx2', vout: 1,
            amountSats: 200000000, confirmations: 200, address: 'RXb111111111111111111111111111',
        });
        const inputs = await ledger.getBatchInputs(batch.batch_id);
        assert.equal(inputs.length, 2);
    });

    it('foreign key prevents inputs referencing non-existent batch', async () => {
        await assert.rejects(
            () => ledger.createBatchInput({
                batchId: 'cplan_nonexistent_b0', txid: 'tx1', vout: 0,
                amountSats: 100, confirmations: 100, address: 'RXtest1111111111111111111111111',
            }),
        );
    });

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    it('creates consolidation events', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const events = await ledger.getEventsForPlan(plan.plan_id);
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, 'plan_created');
    });

    it('events record on approve and reject', async () => {
        const plan1 = await ledger.createPlan({
            destinationAddress: 'RXd111111111111111111111111111',
            configSnapshot: {},
        });
        await ledger.approvePlan(plan1.plan_id, 'op');
        const evts1 = await ledger.getEventsForPlan(plan1.plan_id);
        assert.equal(evts1.length, 2);
        assert.equal(evts1[1].event_type, 'operator_approved');

        const plan2 = await ledger.createPlan({
            destinationAddress: 'RXd211111111111111111111111111',
            configSnapshot: {},
        });
        await ledger.rejectPlan(plan2.plan_id, 'op');
        const evts2 = await ledger.getEventsForPlan(plan2.plan_id);
        assert.equal(evts2.length, 2);
        assert.equal(evts2[1].event_type, 'operator_rejected');
    });

    it('gets events by batch', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await ledger.createEvent({
            planId: plan.plan_id, batchId: batch.batch_id,
            eventType: 'broadcast_succeeded',
            details: 'Tx broadcast OK',
        });
        const evts = await ledger.getEventsForBatch(batch.batch_id);
        assert.equal(evts.length, 1);
        assert.equal(evts[0].event_type, 'broadcast_succeeded');
    });

    it('rejects invalid event type', async () => {
        await assert.rejects(
            () => ledger.createEvent({ eventType: 'invalid_event' }),
            /Invalid event type/
        );
    });

    // -------------------------------------------------------------------------
    // Integer Precision
    // -------------------------------------------------------------------------

    it('stores and retrieves precise integer amounts', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        await ledger.updatePlanCounts(plan.plan_id, {
            totalInputSats: 123456789012345,
            totalFeeSats: 9876543210,
        });
        const fetched = await ledger.getPlan(plan.plan_id);
        assert.equal(fetched.total_input_sats, 123456789012345);
        assert.equal(fetched.total_fee_sats, 9876543210);
    });

    it('handles zero amounts correctly', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        assert.equal(plan.total_input_sats, 0);
        assert.equal(plan.total_fee_sats, 0);

        const batch = await ledger.createBatch({
            planId: plan.plan_id, batchIndex: 0,
            destinationAddress: 'RXdest11111111111111111111111111',
            totalInputSats: 0, estimatedFeeSats: 0,
        });
        assert.equal(batch.total_input_sats, 0);
        assert.equal(batch.estimated_fee_sats, 0);
    });

    it('rejects negative and unsafe integer amounts', async () => {
        const plan = await ledger.createPlan({
            destinationAddress: 'RXdest11111111111111111111111111',
            configSnapshot: {},
        });
        await assert.rejects(
            () => ledger.updatePlanCounts(plan.plan_id, { totalInputSats: -1, totalFeeSats: 0 }),
            /non-negative safe integer/
        );
        await assert.rejects(
            () => ledger.createBatch({
                planId: plan.plan_id,
                batchIndex: 900,
                destinationAddress: 'RXdest11111111111111111111111111',
                totalInputSats: Number.MAX_SAFE_INTEGER + 1,
            }),
            /non-negative safe integer/
        );
        const batch = await ledger.createBatch({
            planId: plan.plan_id,
            batchIndex: 901,
            destinationAddress: 'RXdest11111111111111111111111111',
        });
        await assert.rejects(
            () => ledger.createBatchInput({
                batchId: batch.batch_id,
                txid: 'tx',
                vout: 0,
                amountSats: -1,
                confirmations: 101,
                address: 'RXdest11111111111111111111111111',
            }),
            /non-negative safe integer/
        );
    });
});
