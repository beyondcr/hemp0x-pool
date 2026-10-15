const { SATS_PER_HEMP, satsToDisplay } = require('./constants');
const { planConsolidation } = require('./consolidationPlanner');
const { runHealthReport, DUST_THRESHOLD_SATS } = require('./utxoHealth');
const { estimateTxSizeBytes } = require('./txConstants');
const { isP2PKHAddress } = require('./address');

const LIVE_CONFIRM_VALUE = 'I_UNDERSTAND_THIS_BROADCASTS_REAL_CONSOLIDATION';

class ConsolidationExecutor {

  constructor({ db, rpc, config, consolidationLedger, payoutLedger, walletLabel }) {
    this.db = db;
    this.rpc = rpc;
    this.config = config || {};
    this.consolidationLedger = consolidationLedger;
    this.payoutLedger = payoutLedger || null;
    this.walletLabel = walletLabel || '';
  }

  _sanitizeError(err) {
    if (!err) return 'Unknown error';
    const msg = String(err.message || err);
    return msg.split('\n')[0].slice(0, 500);
  }

  getAutomationStatus() {
    const consolidation = this.config.consolidation || {};
    const automation = this.config.automation || {};
    const dryRunOnly = consolidation.dryRunOnly !== false;
    const enabled = consolidation.enabled !== false;
    const broadcastEnabled = automation.consolidationBroadcastEnabled === true;
    const liveCapable = enabled && !dryRunOnly && broadcastEnabled;

    let mode;
    if (liveCapable) {
      mode = 'live';
    } else if (dryRunOnly) {
      mode = 'dry_run';
    } else {
      mode = 'disabled';
    }

    return { dryRunOnly, enabled, consolidationBroadcastEnabled: broadcastEnabled, liveCapable, mode };
  }

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
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

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async _queryPayoutUnresolvedCount() {
    const row = await this._get(
      `SELECT COUNT(*) as cnt FROM payout_batches
       WHERE status IN ('created','broadcasting')`
    );
    if (row && row.cnt > 0) return row.cnt;
    return 0;
  }

  async _queryPayoutBroadcastingOrBroadcastedCount() {
    const row = await this._get(
      `SELECT COUNT(*) as cnt FROM payout_batches
       WHERE status IN ('broadcasting','broadcasted')`
    );
    if (row && row.cnt > 0) return row.cnt;
    return 0;
  }

  async _queryPayoutRunsInPlanningOrBroadcast() {
    const row = await this._get(
      `SELECT COUNT(*) as cnt FROM payout_runs
       WHERE status IN ('planned','credited','batch_created','broadcasting')`
    );
    if (row && row.cnt > 0) return row.cnt;
    return 0;
  }

  async runHealth() {
    const rpc = this.rpc;
    if (!rpc) {
      throw new Error('RPC client is required for health report');
    }
    return runHealthReport({
      rpc,
      config: this.config,
      walletLabel: this.walletLabel,
    });
  }

  async createPlan({ maxBatches, maxInputs } = {}) {
    const cc = this.config.consolidation;
    const destinationAddress = cc.destinationAddress;
    if (!destinationAddress) {
      throw new Error('consolidation.destinationAddress is not configured');
    }
    if (!isP2PKHAddress(destinationAddress)) {
      throw new Error(`Invalid destination address: ${destinationAddress}`);
    }

    const plan = await planConsolidation({
      rpc: this.rpc,
      config: this.config,
      destinationAddress,
      walletLabel: this.walletLabel,
      skipGateChecks: true,
    });

    const originalBatchCount = plan.batches.length;
    const originalInputCount = plan.totalInputs || plan.batches.reduce((sum, batch) => sum + batch.selectedInputs.length, 0);

    if (maxBatches && plan.batches.length > maxBatches) {
      plan.batches = plan.batches.slice(0, maxBatches);
      plan.warnings.push(`Batches capped to ${maxBatches} (from ${originalBatchCount})`);
    }

    if (maxInputs) {
      let totalInputs = 0;
      const capped = [];
      for (const batch of plan.batches) {
        const remaining = maxInputs - totalInputs;
        if (remaining <= 0) break;
        if (batch.selectedInputs.length > remaining) {
          batch.selectedInputs = batch.selectedInputs.slice(0, remaining);
        }
        totalInputs += batch.selectedInputs.length;
        capped.push(batch);
      }
      plan.batches = capped;
      if (originalInputCount > maxInputs) {
        plan.warnings.push(`Inputs capped to ${maxInputs} across all batches (from ${originalInputCount})`);
      }
    }

    plan.batches = plan.batches.map((batch) => this._recalculateBatchTotals(batch));
    this._recalculatePlanTotals(plan);

    return plan;
  }

  _recalculateBatchTotals(batch) {
    const inputCount = batch.selectedInputs.length;
    const estimatedTxSizeBytes = estimateTxSizeBytes(inputCount, 1);
    const totalInputSats = batch.selectedInputs.reduce((sum, input) => sum + input.amountSats, 0);
    const feeRate = this.config.consolidation?.feeRateSatsPerByte || 10;
    const estimatedFeeSats = Math.max(1, Math.ceil(estimatedTxSizeBytes * feeRate));

    return {
      ...batch,
      totalInputSats,
      estimatedFeeSats,
      estimatedTxSizeBytes,
      expectedPostConsolidationShape: batch.expectedPostConsolidationShape
        ? {
            ...batch.expectedPostConsolidationShape,
            totalUtxos: Math.max(0, batch.expectedPostConsolidationShape.totalUtxos),
            totalAmountSats: Math.max(0, totalInputSats - estimatedFeeSats),
          }
        : undefined,
    };
  }

  _recalculatePlanTotals(plan) {
    plan.totalInputs = plan.batches.reduce((sum, batch) => sum + batch.selectedInputs.length, 0);
    plan.totalInputSats = plan.batches.reduce((sum, batch) => sum + batch.totalInputSats, 0);
    plan.totalFeeSats = plan.batches.reduce((sum, batch) => sum + batch.estimatedFeeSats, 0);
    return plan;
  }

  async createLedgerPlan(plan) {
    if (!this.consolidationLedger) {
      throw new Error('consolidationLedger is required for plan persistence');
    }

    const ledgerPlan = await this.consolidationLedger.createPlan({
      destinationAddress: this.config.consolidation.destinationAddress,
      configSnapshot: plan.configSnapshot || { snapshot: 'unknown' },
    });

    await this.consolidationLedger.updatePlanCounts(ledgerPlan.plan_id, {
      totalBatches: plan.batches.length,
      totalInputs: plan.totalInputs || 0,
      totalInputSats: plan.totalInputSats || 0,
      totalFeeSats: plan.totalFeeSats || 0,
    });

    for (const batch of plan.batches) {
      const ledgerBatch = await this.consolidationLedger.createBatch({
        planId: ledgerPlan.plan_id,
        batchIndex: batch.batchIndex,
        destinationAddress: batch.destinationAddress,
        totalInputSats: batch.totalInputSats,
        estimatedFeeSats: batch.estimatedFeeSats,
        estimatedTxSizeBytes: batch.estimatedTxSizeBytes,
      });

      for (const input of batch.selectedInputs) {
        await this.consolidationLedger.createBatchInput({
          batchId: ledgerBatch.batch_id,
          txid: input.txid,
          vout: input.vout,
          amountSats: input.amountSats,
          confirmations: input.confirmations,
          address: input.address,
        });
      }
    }

    return ledgerPlan;
  }

  async _preflightLiveBroadcast(plan, planId) {
    const cc = this.config.consolidation;
    const destinationAddress = cc.destinationAddress;

    if (!isP2PKHAddress(destinationAddress)) {
      return { ok: false, error: 'invalid_destination', detail: `Invalid destination address: ${destinationAddress}` };
    }

    const balanceHemp = Number(await this.rpc('getbalance', [this.walletLabel]));
    const balanceSats = Math.floor(balanceHemp * SATS_PER_HEMP);
    if (!Number.isFinite(balanceSats)) {
      return { ok: false, error: 'balance_unavailable', detail: 'Could not determine wallet balance' };
    }

    const totalInputSats = plan.batches.reduce((s, b) => s + (b.totalInputSats || 0), 0);
    if (balanceSats < totalInputSats) {
      const detail = `Wallet balance too low for consolidation: balance=${balanceSats} sats, required=${totalInputSats} sats`;
      if (planId && this.consolidationLedger) {
        await this.consolidationLedger.createEvent({
          planId, eventType: 'broadcast_failed',
          details: detail,
        });
      }
      return { ok: false, error: 'balance_low', detail, balanceSats, requiredSats: totalInputSats };
    }

    return { ok: true, totalInputSats, balanceSats, destinationAddress };
  }

  async _payoutPreflightLive() {
    const unresolvedBatches = await this._queryPayoutUnresolvedCount();
    if (unresolvedBatches > 0) {
      return {
        ok: false,
        error: 'payout_unresolved_batches',
        detail: `Cannot execute live consolidation: ${unresolvedBatches} payout batch(es) in created/broadcasting state`,
      };
    }

    const activeRuns = await this._queryPayoutRunsInPlanningOrBroadcast();
    if (activeRuns > 0) {
      return {
        ok: false,
        error: 'payout_active_runs',
        detail: `Cannot execute live consolidation: ${activeRuns} payout run(s) still planning or broadcasting`,
      };
    }

    return { ok: true };
  }

  async processPlan(plan, { live, planId, maxBatches, maxInputs, batchIndex } = {}) {
    const status = this.getAutomationStatus();

    if (live) {
      if (status.mode !== 'live') {
        return { processed: false, error: 'live_mode_not_capable', detail: `Mode: ${status.mode}` };
      }

      if (!this.rpc) {
        return { processed: false, error: 'no_rpc_client', detail: 'Live mode requires RPC client' };
      }

      let payoutCheck;
      try {
        payoutCheck = await this._payoutPreflightLive();
      } catch (err) {
        return {
          processed: false,
          error: 'payout_preflight_failed',
          detail: this._sanitizeError(err),
        };
      }
      if (!payoutCheck.ok) {
        return { processed: false, error: payoutCheck.error, detail: payoutCheck.detail };
      }

      const preflight = await this._preflightLiveBroadcast(plan, planId);
      if (!preflight.ok) {
        return { processed: false, error: preflight.error, detail: preflight.detail };
      }

      return this._processLive(plan, { planId, maxBatches, maxInputs, batchIndex });
    }

    return this._processDryRun(plan, { planId, maxBatches, batchIndex });
  }

  async _processDryRun(plan, { planId, maxBatches, batchIndex }) {
    const batches = this._filterPlanBatches(plan.batches, { maxBatches, batchIndex });
    const batchResults = [];

    for (const batch of batches) {
      if (planId && this.consolidationLedger) {
        await this.consolidationLedger.createEvent({
          planId,
          eventType: 'broadcast_attempted',
          details: `Dry-run simulated broadcast for batch ${batch.batchIndex}`,
        });
      }

      const txid = `dryrun_consolidation_b${batch.batchIndex}_${Date.now()}`;

      batchResults.push({
        batchIndex: batch.batchIndex,
        processed: true,
        simulated: true,
        dryRun: true,
        inputCount: batch.selectedInputs.length,
        totalInputSats: batch.totalInputSats,
        estimatedFeeSats: batch.estimatedFeeSats,
        outputSats: batch.totalInputSats - batch.estimatedFeeSats,
        simulatedTxid: txid,
      });

      if (planId && this.consolidationLedger) {
        await this.consolidationLedger.createEvent({
          planId,
          eventType: 'broadcast_succeeded',
          details: `Dry-run batch ${batch.batchIndex} simulated as txid=${txid}`,
        });
      }
    }

    return {
      processed: true,
      mode: 'dry_run',
      batchCount: batchResults.length,
      batches: batchResults,
    };
  }

  async _processLive(plan, { planId, maxBatches, maxInputs, batchIndex }) {
    const batches = this._filterPlanBatches(plan.batches, { maxBatches, maxInputs, batchIndex });
    const batchResults = [];
    let allOk = true;

    for (const batch of batches) {
      const batchInputs = batch.selectedInputs;
      if (batchInputs.length === 0) {
        batchResults.push({ batchIndex: batch.batchIndex, processed: false, error: 'No inputs in batch' });
        allOk = false;
        continue;
      }

      const ledgerBatchId = planId ? await this._findLedgerBatchId(planId, batch.batchIndex) : null;

      try {
        if (ledgerBatchId) {
          await this.consolidationLedger.updateBatchStatus(ledgerBatchId, 'broadcasting');
          await this.consolidationLedger.createEvent({
            planId, batchId: ledgerBatchId,
            eventType: 'broadcast_attempted',
            details: `Starting broadcast for batch ${batch.batchIndex}`,
          });
        }

        const inputs = batchInputs.map((i) => ({ txid: i.txid, vout: i.vout }));
        const totalInputSats = batchInputs.reduce((sum, i) => sum + i.amountSats, 0);
        const feeSats = batch.estimatedFeeSats || 0;
        const outputSats = totalInputSats - feeSats;

        if (outputSats <= DUST_THRESHOLD_SATS) {
          throw new Error(`Batch ${batch.batchIndex}: output amount (${outputSats} sats) is below dust threshold`);
        }

        const outputAmount = satsToDisplay(outputSats);
        const rawTxHex = await this.rpc('createrawtransaction', [
          inputs,
          { [batch.destinationAddress]: outputAmount },
        ]);

        let signedHex;
        try {
          const signed = await this.rpc('signrawtransactionwithwallet', [rawTxHex]);
          signedHex = signed.hex;
          if (!signed.complete || !signedHex) {
            throw new Error('signrawtransactionwithwallet returned incomplete transaction');
          }
        } catch (_signErr) {
          const signed = await this.rpc('signrawtransaction', [rawTxHex]);
          signedHex = signed.hex;
          if (!signed.complete || !signedHex) {
            throw new Error('signrawtransaction returned incomplete transaction');
          }
        }

        const txid = await this.rpc('sendrawtransaction', [signedHex]);

        if (ledgerBatchId) {
          await this.consolidationLedger.updateBatchStatus(ledgerBatchId, 'broadcasted', {
            txid,
            actualFeeSats: feeSats,
          });
          await this.consolidationLedger.createEvent({
            planId, batchId: ledgerBatchId,
            eventType: 'broadcast_succeeded',
            details: `Broadcasted batch ${batch.batchIndex} txid=${txid}`,
          });
        }

        batchResults.push({
          batchIndex: batch.batchIndex,
          processed: true,
          txid,
          inputCount: batchInputs.length,
          totalInputSats,
          feeSats,
          outputSats,
        });
      } catch (err) {
        const sanitized = this._sanitizeError(err);
        if (ledgerBatchId) {
          await this.consolidationLedger.updateBatchStatus(ledgerBatchId, 'failed', { errorMessage: sanitized });
          await this.consolidationLedger.createEvent({
            planId, batchId: ledgerBatchId,
            eventType: 'broadcast_failed',
            details: sanitized,
          });
        }
        batchResults.push({ batchIndex: batch.batchIndex, processed: false, error: sanitized });
        allOk = false;
      }
    }

    return {
      processed: true,
      mode: 'live',
      allOk,
      batchCount: batchResults.length,
      batches: batchResults,
    };
  }

  _filterPlanBatches(planBatches, { maxBatches, maxInputs, batchIndex } = {}) {
    let batches = planBatches;

    if (batchIndex !== undefined && batchIndex !== null) {
      batches = batches.filter((b) => b.batchIndex === batchIndex);
    }

    if (maxBatches && batches.length > maxBatches) {
      batches = batches.slice(0, maxBatches);
    }

    if (maxInputs) {
      let totalInputs = 0;
      const capped = [];
      for (const batch of batches) {
        const remaining = maxInputs - totalInputs;
        if (remaining <= 0) break;
        if (batch.selectedInputs.length > remaining) {
          const truncated = { ...batch, selectedInputs: batch.selectedInputs.slice(0, remaining) };
          capped.push(truncated);
          totalInputs += remaining;
        } else {
          capped.push(batch);
          totalInputs += batch.selectedInputs.length;
        }
      }
      batches = capped;
    }

    return batches.map((batch) => this._recalculateBatchTotals(batch));
  }

  async _findLedgerBatchId(planId, batchIndex) {
    if (!this.consolidationLedger) return null;
    try {
      const batches = await this.consolidationLedger.getBatchesForPlan(planId);
      const match = batches.find((b) => b.batch_index === batchIndex);
      return match ? match.batch_id : null;
    } catch (_e) {
      return null;
    }
  }

  async confirmBroadcastedBatches() {
    if (!this.rpc) {
      return { error: 'RPC client required for confirmation checks' };
    }
    if (!this.consolidationLedger) {
      return { error: 'ConsolidationLedger required for confirmation checks' };
    }

    const batches = await this.consolidationLedger.getBatchesByStatus('broadcasted');
    const requiredConfirmations = this.config.consolidation?.minConfirmations || 100;
    const results = [];

    for (const batch of batches) {
      if (!batch.txid) continue;

      try {
        const txInfo = await this.rpc('gettransaction', [batch.txid]);
        const confirmations = txInfo.confirmations || 0;

        if (confirmations >= requiredConfirmations) {
          await this.consolidationLedger.updateBatchStatus(batch.batch_id, 'confirmed', { confirmations });
          await this.consolidationLedger.createEvent({
            planId: batch.plan_id,
            batchId: batch.batch_id,
            eventType: 'confirmation_update',
            details: `Batch ${batch.batch_index} confirmed with ${confirmations} confirmations`,
          });
          results.push({ batchId: batch.batch_id, confirmed: true, confirmations });
        } else {
          results.push({ batchId: batch.batch_id, confirmed: false, confirmations, required: requiredConfirmations });
        }
      } catch (err) {
        const sanitized = this._sanitizeError(err);
        results.push({ batchId: batch.batch_id, confirmed: false, error: sanitized });
      }
    }

    return { results, total: results.length };
  }

  async executeCycle({ live, maxBatches, maxInputs, batchIndex } = {}) {
    const confirmation = await this.confirmBroadcastedBatches();

    const plan = await this.createPlan({ maxBatches, maxInputs });
    if (!plan.batches || plan.batches.length === 0) {
      return {
        action: 'cycle',
        confirmation,
        plan: { noOp: true, totalCandidates: plan.totalCandidates, totalBatches: 0 },
        process: null,
      };
    }

    let planId = null;
    if (this.consolidationLedger) {
      const ledgerPlan = await this.createLedgerPlan(plan);
      planId = ledgerPlan.plan_id;
    }

    const processResult = await this.processPlan(plan, {
      live,
      planId,
      maxBatches,
      maxInputs,
      batchIndex,
    });

    return {
      action: 'cycle',
      confirmation,
      plan: {
        planId,
        totalCandidates: plan.totalCandidates,
        totalBatches: plan.batches.length,
        totalInputs: plan.totalInputs,
        totalInputSats: plan.totalInputSats,
        totalFeeSats: plan.totalFeeSats,
        warnings: plan.warnings,
      },
      process: processResult,
    };
  }
}

module.exports = { ConsolidationExecutor, LIVE_CONFIRM_VALUE };
