const { SATS_PER_HEMP } = require('./constants');

const CANONICAL_RUN_STATUSES = new Set([
    'planned',
    'credited',
    'batch_created',
    'broadcasting',
    'broadcasted',
    'confirmed',
    'failed',
    'replaced',
]);

const CANONICAL_BATCH_STATUSES = new Set([
    'created',
    'broadcasting',
    'broadcast_unknown',
    'broadcasted',
    'confirmed',
    'failed',
]);

const VALID_MINER_CATEGORIES = new Set(['finder', 'pool', 'finder_fallback']);

class PayoutLedger {
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

    _validateStatus(status) {
        if (!CANONICAL_RUN_STATUSES.has(status)) {
            throw new Error(`Invalid payout run status: ${status}`);
        }
    }

    _validateCategory(category) {
        if (!VALID_MINER_CATEGORIES.has(category)) {
            throw new Error(`Invalid miner credit category: ${category}`);
        }
    }

    _validateAmountSats(value, fieldName) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`${fieldName} must be a non-negative safe integer`);
        }
    }

    // -------------------------------------------------------------------------
    // Runs
    // -------------------------------------------------------------------------

    /**
     * Create a new payout run in 'planned' status.
     * Returns the new row with id.
     */
    async createRun({ blockHeightStart, blockHeightEnd, totalBlocks, totalMiners, totalAmountSats, feeAmountSats, netAmountSats } = {}) {
        this._validateAmountSats(totalAmountSats || 0, 'totalAmountSats');
        this._validateAmountSats(feeAmountSats || 0, 'feeAmountSats');
        this._validateAmountSats(netAmountSats || 0, 'netAmountSats');
        const result = await this._run(
            `INSERT INTO payout_runs
                (created_at, status, block_height_start, block_height_end, total_blocks, total_miners, total_amount_sats, fee_amount_sats, net_amount_sats)
             VALUES (?, 'planned', ?, ?, ?, ?, ?, ?, ?)`,
            [Date.now(), blockHeightStart || null, blockHeightEnd || null, totalBlocks || 0, totalMiners || 0, totalAmountSats || 0, feeAmountSats || 0, netAmountSats || 0]
        );
        return this.getRun(result.lastID);
    }

    async getRun(runId) {
        return this._get('SELECT * FROM payout_runs WHERE id = ?', [runId]);
    }

    async getAllRuns() {
        return this._all('SELECT * FROM payout_runs ORDER BY id DESC');
    }

    async getRunsByStatus(status) {
        this._validateStatus(status);
        return this._all('SELECT * FROM payout_runs WHERE status = ? ORDER BY id ASC', [status]);
    }

    async updateRunStatus(runId, newStatus, errorText = null) {
        this._validateStatus(newStatus);
        const updates = { status: newStatus };
        if (newStatus === 'confirmed' || newStatus === 'failed' || newStatus === 'replaced') {
            updates.completed_at = Date.now();
        }
        if (errorText) {
            updates.error = errorText;
        }

        const sql = `UPDATE payout_runs SET status = ?${errorText ? ', error = ?' : ''}${updates.completed_at ? ', completed_at = ?' : ''} WHERE id = ?`;
        const params = [newStatus];
        if (errorText) params.push(errorText);
        if (updates.completed_at) params.push(updates.completed_at);
        params.push(runId);

        return this._run(sql, params);
    }

    /**
     * Update aggregate fields on a run after planning is complete.
     */
    async updateRunAggregates(runId, { blockHeightStart, blockHeightEnd, totalBlocks, totalMiners, totalAmountSats, feeAmountSats, netAmountSats }) {
        this._validateAmountSats(totalAmountSats || 0, 'totalAmountSats');
        this._validateAmountSats(feeAmountSats || 0, 'feeAmountSats');
        this._validateAmountSats(netAmountSats || 0, 'netAmountSats');
        return this._run(
            `UPDATE payout_runs
             SET total_blocks = ?, total_miners = ?, total_amount_sats = ?, fee_amount_sats = ?, net_amount_sats = ?,
                 block_height_start = ?, block_height_end = ?
             WHERE id = ?`,
            [totalBlocks || 0, totalMiners || 0, totalAmountSats || 0, feeAmountSats || 0, netAmountSats || 0,
             blockHeightStart || null, blockHeightEnd || null, runId]
        );
    }

    /**
     * Find runs in non-terminal states for recovery scanning.
     */
    async getStalledRuns() {
        return this._all(
            "SELECT * FROM payout_runs WHERE status IN ('planned','credited','batch_created','broadcasting','broadcasted') ORDER BY id ASC"
        );
    }

    // -------------------------------------------------------------------------
    // Block Credits
    // -------------------------------------------------------------------------

    async createBlockCredit({ runId, height, hash, finder, mode, rewardSats, feeDeductedSats, finderBonusSats, remainderSats, minerCount }) {
        this._validateAmountSats(rewardSats, 'rewardSats');
        this._validateAmountSats(feeDeductedSats, 'feeDeductedSats');
        this._validateAmountSats(finderBonusSats, 'finderBonusSats');
        this._validateAmountSats(remainderSats, 'remainderSats');
        const result = await this._run(
            `INSERT INTO payout_block_credits
                (run_id, height, hash, finder, mode, reward_sats, fee_deducted_sats, finder_bonus_sats, remainder_sats, miner_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [runId, height, hash, finder, mode || 'pool', rewardSats, feeDeductedSats, finderBonusSats, remainderSats, minerCount || 0]
        );
        return this._get('SELECT * FROM payout_block_credits WHERE id = ?', [result.lastID]);
    }

    async getBlockCreditsForRun(runId) {
        return this._all('SELECT * FROM payout_block_credits WHERE run_id = ? ORDER BY height ASC', [runId]);
    }

    async getBlockCreditByRunAndHeight(runId, height) {
        return this._get('SELECT * FROM payout_block_credits WHERE run_id = ? AND height = ?', [runId, height]);
    }

    /**
     * Find source heights that already have a payout transaction in flight or
     * settled. A failed run can retain confirmed batches while its source
     * blocks remain unpaid in the legacy blocks table, so planning must fail
     * closed for those heights instead of creating another payout.
     * @param {number[]} heights
     * @returns {Promise<number[]>}
     */
    async getHeightsWithBroadcastedBatches(heights) {
        const uniqueHeights = [...new Set((heights || [])
            .map((height) => Number(height))
            .filter((height) => Number.isSafeInteger(height)))];
        if (uniqueHeights.length === 0) return [];

        const placeholders = uniqueHeights.map(() => '?').join(',');
        const rows = await this._all(
            `SELECT DISTINCT pbc.height
             FROM payout_block_credits pbc
             JOIN payout_batches pb ON pb.run_id = pbc.run_id
             WHERE pbc.height IN (${placeholders})
               AND pb.status IN ('broadcasting', 'broadcast_unknown', 'broadcasted', 'confirmed')`,
            uniqueHeights
        );
        return rows.map((row) => Number(row.height));
    }

    // -------------------------------------------------------------------------
    // Miner Credits
    // -------------------------------------------------------------------------

    async createMinerCredit({ blockCreditId, miner, category, amountSats }) {
        this._validateCategory(category);
        this._validateAmountSats(amountSats, 'amountSats');
        const result = await this._run(
            `INSERT INTO payout_miner_credits (block_credit_id, miner, category, amount_sats)
             VALUES (?, ?, ?, ?)`,
            [blockCreditId, miner, category, amountSats]
        );
        return this._get('SELECT * FROM payout_miner_credits WHERE id = ?', [result.lastID]);
    }

    async getMinerCreditsForBlock(blockCreditId) {
        return this._all('SELECT * FROM payout_miner_credits WHERE block_credit_id = ?', [blockCreditId]);
    }

    async getMinerCreditsForRun(runId) {
        return this._all(
            `SELECT pmc.* FROM payout_miner_credits pmc
             JOIN payout_block_credits pbc ON pmc.block_credit_id = pbc.id
             WHERE pbc.run_id = ?
             ORDER BY pmc.miner ASC`,
            [runId]
        );
    }

    async getMinerCreditsByMiner(miner) {
        return this._all('SELECT * FROM payout_miner_credits WHERE miner = ? ORDER BY id DESC', [miner]);
    }

    // -------------------------------------------------------------------------
    // Batches
    // -------------------------------------------------------------------------

    async createBatch({ runId, batchIndex, totalAmountSats, feeEstimateSats, outputCount }) {
        this._validateAmountSats(totalAmountSats || 0, 'totalAmountSats');
        if (feeEstimateSats !== undefined && feeEstimateSats !== null) {
            this._validateAmountSats(feeEstimateSats, 'feeEstimateSats');
        }
        const result = await this._run(
            `INSERT INTO payout_batches
                (run_id, batch_index, status, total_amount_sats, fee_estimate_sats, output_count, created_at)
             VALUES (?, ?, 'created', ?, ?, ?, ?)`,
            [runId, batchIndex, totalAmountSats || 0, feeEstimateSats || null, outputCount || 0, Date.now()]
        );
        return this._get('SELECT * FROM payout_batches WHERE id = ?', [result.lastID]);
    }

    async getBatchesForRun(runId) {
        return this._all('SELECT * FROM payout_batches WHERE run_id = ? ORDER BY batch_index ASC', [runId]);
    }

    async getBatch(batchId) {
        return this._get('SELECT * FROM payout_batches WHERE id = ?', [batchId]);
    }

    async updateBatchStatus(batchId, newStatus, { txid, error: errorText } = {}) {
        if (!CANONICAL_BATCH_STATUSES.has(newStatus)) {
            throw new Error(`Invalid batch status: ${newStatus}`);
        }
        const updates = [];
        const params = [];

        updates.push('status = ?');
        params.push(newStatus);

        if (newStatus === 'broadcasting' || newStatus === 'broadcasted') {
            if (txid) {
                updates.push('txid = ?');
                params.push(txid);
            }
        }
        if (newStatus === 'broadcasted') {
            updates.push('broadcast_at = ?');
            params.push(Date.now());
        }
        if (newStatus === 'confirmed') {
            updates.push('confirmed_at = ?');
            params.push(Date.now());
        }
        if (errorText) {
            updates.push('error = ?');
            params.push(errorText);
        }

        params.push(batchId);
        return this._run(`UPDATE payout_batches SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    async getBatchesByStatus(status) {
        if (!CANONICAL_BATCH_STATUSES.has(status)) {
            throw new Error(`Invalid batch status: ${status}`);
        }
        return this._all('SELECT * FROM payout_batches WHERE status = ? ORDER BY id ASC', [status]);
    }

    // -------------------------------------------------------------------------
    // Batch Outputs
    // -------------------------------------------------------------------------

    async createBatchOutput({ batchId, address, amountSats, category }) {
        category = category || 'pool';
        this._validateAmountSats(amountSats, 'amountSats');
        const result = await this._run(
            `INSERT INTO payout_batch_outputs (batch_id, address, amount_sats, category)
             VALUES (?, ?, ?, ?)`,
            [batchId, address, amountSats, category]
        );
        return this._get('SELECT * FROM payout_batch_outputs WHERE id = ?', [result.lastID]);
    }

    async getBatchOutputs(batchId) {
        return this._all('SELECT * FROM payout_batch_outputs WHERE batch_id = ?', [batchId]);
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    async createEvent({ runId, batchId, eventType, detail }) {
        const result = await this._run(
            `INSERT INTO payout_events (run_id, batch_id, event_type, detail, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [runId || null, batchId || null, eventType, detail || null, Date.now()]
        );
        return this._get('SELECT * FROM payout_events WHERE id = ?', [result.lastID]);
    }

    async getEventsForRun(runId) {
        return this._all('SELECT * FROM payout_events WHERE run_id = ? ORDER BY created_at ASC', [runId]);
    }

    // -------------------------------------------------------------------------
    // Plan History / Review
    // -------------------------------------------------------------------------

    async getRunsPaginated(limit = 20, offset = 0) {
        const safeLimit = Math.min(Math.max(1, limit), 100);
        const safeOffset = Math.max(0, offset);
        const runs = await this._all(
            'SELECT * FROM payout_runs ORDER BY id DESC LIMIT ? OFFSET ?',
            [safeLimit, safeOffset]
        );
        const countRow = await this._get('SELECT COUNT(*) as total FROM payout_runs');
        const total = countRow ? countRow.total : 0;
        return { total, limit: safeLimit, offset: safeOffset, runs };
    }

    async getRunDetail(runId) {
        const run = await this.getRun(runId);
        if (!run) return null;

        const [blockCredits, minerCredits, batches, events] = await Promise.all([
            this.getBlockCreditsForRun(runId),
            this.getMinerCreditsForRun(runId),
            this.getBatchesForRun(runId),
            this.getEventsForRun(runId),
        ]);

        const batchesWithOutputs = await Promise.all(
            batches.map(async (b) => {
                const outputs = await this.getBatchOutputs(b.id);
                return { ...b, outputs };
            })
        );

        return {
            run,
            blockCredits,
            minerCredits,
            batches: batchesWithOutputs,
            events,
        };
    }

    /**
     * Persist an operator review intent (approve or reject) as an event.
     * Does not change the run status — this is a review-only action.
     */
    async createReviewEvent(runId, action, reason) {
        const safeReason = typeof reason === 'string' ? reason.slice(0, 500) : null;
        const eventType = action === 'approve' ? 'operator_approved' : 'operator_rejected';
        const detail = safeReason ? JSON.stringify({ action, reason: safeReason }) : JSON.stringify({ action });
        return this.createEvent({ runId, eventType, detail });
    }

    async getStaleRuns(olderThanDays = 30) {
        const cutoff = Date.now() - (olderThanDays * 86400000);
        return this._all(
            `SELECT * FROM payout_runs WHERE status = 'planned' AND created_at < ? ORDER BY id ASC`,
            [cutoff]
        );
    }
}

module.exports = { PayoutLedger, SATS_PER_HEMP, CANONICAL_RUN_STATUSES, CANONICAL_BATCH_STATUSES, VALID_MINER_CATEGORIES };
