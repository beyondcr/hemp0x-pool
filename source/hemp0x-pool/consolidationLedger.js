const { SATS_PER_HEMP } = require('./constants');

const CANONICAL_PLAN_STATUSES = new Set([
    'draft',
    'approved',
    'rejected',
    'completed',
    'partial',
    'failed',
]);

const CANONICAL_BATCH_STATUSES = new Set([
    'draft',
    'approved',
    'broadcasting',
    'broadcasted',
    'confirmed',
    'failed',
    'abandoned',
]);

const CANONICAL_EVENT_TYPES = new Set([
    'plan_created',
    'operator_approved',
    'operator_rejected',
    'broadcast_attempted',
    'broadcast_succeeded',
    'broadcast_failed',
    'confirmation_update',
    'abandoned',
    'retry_scheduled',
]);

class ConsolidationLedger {
    /**
     * @param {object} db - sqlite3 Database instance
     */
    constructor(db) {
        this.db = db;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    _run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    _all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    _get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    _generatePlanId() {
        const prefix = 'cplan';
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        return `${prefix}_${ts}_${rand}`;
    }

    _generateBatchId(planId, batchIndex) {
        return `${planId}_b${batchIndex}`;
    }

    _validateAmountSats(value, fieldName) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`${fieldName} must be a non-negative safe integer`);
        }
    }

    // -------------------------------------------------------------------------
    // Plans
    // -------------------------------------------------------------------------

    async createPlan({ destinationAddress, configSnapshot }) {
        if (!destinationAddress) {
            throw new Error('destinationAddress is required');
        }
        if (!configSnapshot) {
            throw new Error('configSnapshot is required');
        }
        const planId = this._generatePlanId();
        const result = await this._run(
            `INSERT INTO consolidation_plans
                (plan_id, created_at, status, config_snapshot, destination_address)
             VALUES (?, ?, 'draft', ?, ?)`,
            [planId, Date.now(), JSON.stringify(configSnapshot), destinationAddress]
        );
        await this._createEvent({ planId, eventType: 'plan_created' });
        return this.getPlan(planId);
    }

    async getPlan(planId) {
        return this._get('SELECT * FROM consolidation_plans WHERE plan_id = ?', [planId]);
    }

    async getAllPlans() {
        return this._all('SELECT * FROM consolidation_plans ORDER BY created_at DESC');
    }

    async getPlansByStatus(status) {
        if (!CANONICAL_PLAN_STATUSES.has(status)) {
            throw new Error(`Invalid plan status: ${status}`);
        }
        return this._all('SELECT * FROM consolidation_plans WHERE status = ? ORDER BY created_at DESC', [status]);
    }

    async approvePlan(planId, operatorContext) {
        const plan = await this.getPlan(planId);
        if (!plan) throw new Error(`Plan ${planId} not found`);
        if (plan.status !== 'draft') {
            throw new Error(`Cannot approve plan with status: ${plan.status}`);
        }
        await this._run(
            `UPDATE consolidation_plans
             SET status = 'approved', operator_approved_by = ?, operator_approved_at = ?
             WHERE plan_id = ?`,
            [operatorContext || 'operator', Date.now(), planId]
        );
        await this._createEvent({ planId, eventType: 'operator_approved', operatorContext });
        return this.getPlan(planId);
    }

    async rejectPlan(planId, operatorContext) {
        const plan = await this.getPlan(planId);
        if (!plan) throw new Error(`Plan ${planId} not found`);
        if (plan.status !== 'draft') {
            throw new Error(`Cannot reject plan with status: ${plan.status}`);
        }
        await this._run(
            `UPDATE consolidation_plans
             SET status = 'rejected', operator_approved_by = ?, operator_approved_at = ?
             WHERE plan_id = ?`,
            [operatorContext || 'operator', Date.now(), planId]
        );
        await this._createEvent({ planId, eventType: 'operator_rejected', operatorContext });
        return this.getPlan(planId);
    }

    async updatePlanCounts(planId, { totalBatches, totalInputs, totalInputSats, totalFeeSats }) {
        this._validateAmountSats(totalInputSats || 0, 'totalInputSats');
        this._validateAmountSats(totalFeeSats || 0, 'totalFeeSats');
        return this._run(
            `UPDATE consolidation_plans
             SET total_batches = ?, total_inputs = ?, total_input_sats = ?, total_fee_sats = ?
             WHERE plan_id = ?`,
            [totalBatches || 0, totalInputs || 0, totalInputSats || 0, totalFeeSats || 0, planId]
        );
    }

    // -------------------------------------------------------------------------
    // Batches
    // -------------------------------------------------------------------------

    async createBatch({ planId, batchIndex, destinationAddress, totalInputSats, estimatedFeeSats, estimatedTxSizeBytes }) {
        this._validateAmountSats(totalInputSats || 0, 'totalInputSats');
        this._validateAmountSats(estimatedFeeSats || 0, 'estimatedFeeSats');
        const plan = await this.getPlan(planId);
        if (!plan) throw new Error(`Plan ${planId} not found`);

        const batchId = this._generateBatchId(planId, batchIndex);
        const result = await this._run(
            `INSERT INTO consolidation_batches
                (batch_id, plan_id, batch_index, status, created_at, destination_address,
                 total_input_sats, estimated_fee_sats, estimated_tx_size_bytes)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
            [batchId, planId, batchIndex, Date.now(), destinationAddress,
             totalInputSats || 0, estimatedFeeSats || 0, estimatedTxSizeBytes || 0]
        );
        return this.getBatch(batchId);
    }

    async getBatch(batchId) {
        return this._get('SELECT * FROM consolidation_batches WHERE batch_id = ?', [batchId]);
    }

    async getBatchesForPlan(planId) {
        return this._all('SELECT * FROM consolidation_batches WHERE plan_id = ? ORDER BY batch_index ASC', [planId]);
    }

    async getBatchesByStatus(status) {
        if (!CANONICAL_BATCH_STATUSES.has(status)) {
            throw new Error(`Invalid batch status: ${status}`);
        }
        return this._all('SELECT * FROM consolidation_batches WHERE status = ? ORDER BY created_at ASC', [status]);
    }

    async approveBatch(batchId) {
        const batch = await this.getBatch(batchId);
        if (!batch) throw new Error(`Batch ${batchId} not found`);
        if (batch.status !== 'draft') {
            throw new Error(`Cannot approve batch with status: ${batch.status}`);
        }
        await this._run(
            "UPDATE consolidation_batches SET status = 'approved' WHERE batch_id = ?",
            [batchId]
        );
        return this.getBatch(batchId);
    }

    async updateBatchStatus(batchId, newStatus, { txid, errorMessage, actualFeeSats, confirmations } = {}) {
        if (!CANONICAL_BATCH_STATUSES.has(newStatus)) {
            throw new Error(`Invalid batch status: ${newStatus}`);
        }
        const updates = ['status = ?'];
        const params = [newStatus];

        if (newStatus === 'broadcasting' || newStatus === 'broadcasted') {
            updates.push('broadcast_at = ?');
            params.push(Date.now());
            if (txid) {
                updates.push('txid = ?');
                params.push(txid);
            }
        }
        if (newStatus === 'confirmed') {
            updates.push('confirmed_at = ?');
            params.push(Date.now());
            updates.push('confirmations = ?');
            params.push(confirmations || 0);
        }
        if (actualFeeSats !== undefined) {
            this._validateAmountSats(actualFeeSats, 'actualFeeSats');
            updates.push('actual_fee_sats = ?');
            params.push(actualFeeSats);
        }
        if (errorMessage) {
            updates.push('error_message = ?');
            params.push(errorMessage);
        }
        if (newStatus === 'failed') {
            updates.push('retry_count = retry_count + 1');
        }

        params.push(batchId);
        return this._run(`UPDATE consolidation_batches SET ${updates.join(', ')} WHERE batch_id = ?`, params);
    }

    // -------------------------------------------------------------------------
    // Batch Inputs
    // -------------------------------------------------------------------------

    async createBatchInput({ batchId, txid: inputTxid, vout, amountSats, confirmations, address }) {
        this._validateAmountSats(amountSats, 'amountSats');
        const result = await this._run(
            `INSERT INTO consolidation_batch_inputs (batch_id, txid, vout, amount_sats, confirmations, address)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [batchId, inputTxid, vout, amountSats, confirmations, address]
        );
        return this._get('SELECT * FROM consolidation_batch_inputs WHERE id = ?', [result.lastID]);
    }

    async getBatchInputs(batchId) {
        return this._all('SELECT * FROM consolidation_batch_inputs WHERE batch_id = ?', [batchId]);
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    async _createEvent({ planId, batchId, eventType, details, operatorContext }) {
        if (!CANONICAL_EVENT_TYPES.has(eventType)) {
            throw new Error(`Invalid event type: ${eventType}`);
        }
        return this._run(
            `INSERT INTO consolidation_events (plan_id, batch_id, event_type, event_at, details, operator_context)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [planId || null, batchId || null, eventType, Date.now(), details || null, operatorContext || null]
        );
    }

    async createEvent({ planId, batchId, eventType, details, operatorContext }) {
        return this._createEvent({ planId, batchId, eventType, details, operatorContext });
    }

    async getEventsForPlan(planId) {
        return this._all('SELECT * FROM consolidation_events WHERE plan_id = ? ORDER BY event_at ASC', [planId]);
    }

    async getEventsForBatch(batchId) {
        return this._all('SELECT * FROM consolidation_events WHERE batch_id = ? ORDER BY event_at ASC', [batchId]);
    }
}

module.exports = { ConsolidationLedger, SATS_PER_HEMP, CANONICAL_PLAN_STATUSES, CANONICAL_BATCH_STATUSES, CANONICAL_EVENT_TYPES };
