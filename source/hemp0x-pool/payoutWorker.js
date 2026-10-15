const { SATS_PER_HEMP, satsToHemp } = require('./constants');
const { isRoutableAddress } = require('./address');

const LOCK_WORKER = 'payout_worker';
const LOCK_RUN_PREFIX = 'payout_run_';

/**
 * A transport failure after sendmany starts is ambiguous: the daemon may have
 * accepted the transaction even though the client did not receive a result.
 * Retrying such a call can create a duplicate payout.
 */
function isAmbiguousBroadcastError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return /timed out|timeout|etimedout|econnreset|econnrefused|socket hang up|connection (?:reset|closed|aborted|lost)/i.test(message);
}

class PayoutWorker {
  /**
   * @param {object} options
   * @param {object} options.db - sqlite3 Database instance
   * @param {object} options.ledger - PayoutLedger instance
   * @param {object} options.config - merged config object
   * @param {function} [options.rpc] - async (method, params) => result
   */
  constructor({ db, ledger, config, rpc }) {
    this.db = db;
    this.ledger = ledger;
    this.config = config || {};
    this.rpc = rpc || null;
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

  /**
   * Return the current automation status based on config gates.
   */
  getAutomationStatus() {
    const payout = this.config.payout || {};
    const automation = this.config.automation || {};
    const dryRun = payout.dryRun !== false;
    const routineEnabled = automation.routinePayoutEnabled === true;
    const broadcastEnabled = automation.payoutBroadcastEnabled === true;
    const liveCapable = !dryRun && routineEnabled && broadcastEnabled;

    let mode;
    if (liveCapable) {
      mode = 'live';
    } else if (dryRun) {
      mode = 'dry_run';
    } else {
      mode = 'disabled';
    }

    return {
      dryRun,
      routinePayoutEnabled: routineEnabled,
      payoutBroadcastEnabled: broadcastEnabled,
      liveCapable,
      mode,
    };
  }

  /**
   * Acquire a run-level lock to prevent overlapping execution.
   * Uses the process_locks table with lock_name = payout_run_{runId}.
   * If recovery is enabled and the existing lock is stale, it is recovered.
   * @param {number} runId
   * @returns {Promise<boolean>}
   */
  async acquireRunLock(runId) {
    const lockName = LOCK_RUN_PREFIX + runId;
    const now = Date.now();
    const recoveryEnabled = this.config.automation?.staleLockRecoveryEnabled !== false;

    const existing = await this._get(
      'SELECT * FROM process_locks WHERE lock_name = ?',
      [lockName]
    );

    if (existing) {
      if (recoveryEnabled && existing.expires_at && existing.expires_at < now) {
        await this._run('DELETE FROM process_locks WHERE lock_name = ?', [lockName]);
      } else {
        return false;
      }
    }

    const staleTimeout = this.config.payout?.staleLockTimeoutMs || 3600000;
    try {
      await this._run(
        'INSERT INTO process_locks (lock_name, locked_at, locked_by, expires_at) VALUES (?, ?, ?, ?)',
        [lockName, now, 'payoutWorker', now + staleTimeout]
      );
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Release a run-level lock.
   * @param {number} runId
   * @returns {Promise<void>}
   */
  async releaseRunLock(runId) {
    const lockName = LOCK_RUN_PREFIX + runId;
    await this._run('DELETE FROM process_locks WHERE lock_name = ?', [lockName]);
  }

  /**
   * Check if a run lock is currently held.
   * @param {number} runId
   * @returns {Promise<boolean>}
   */
  async isRunLocked(runId) {
    const lockName = LOCK_RUN_PREFIX + runId;
    const row = await this._get(
      'SELECT * FROM process_locks WHERE lock_name = ?',
      [lockName]
    );
    return !!row;
  }

  _sanitizeError(err) {
    if (!err) return 'Unknown error';
    const msg = String(err.message || err);
    return msg.split('\n')[0].slice(0, 500);
  }

  async _tableExists(tableName) {
    const row = await this._get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName]
    );
    return !!row;
  }

  async _getRunSourceBlocks(runId) {
    const blockCredits = await this.ledger.getBlockCreditsForRun(runId);
    const heights = [...new Set(blockCredits.map((b) => b.height).filter((h) => h !== null && h !== undefined))];
    if (heights.length === 0 || !(await this._tableExists('blocks'))) {
      return { heights, maxTimestamp: 0 };
    }

    const placeholders = heights.map(() => '?').join(',');
    const rows = await this._all(
      `SELECT height, timestamp FROM blocks WHERE height IN (${placeholders})`,
      heights
    );
    const maxTimestamp = rows.reduce((max, row) => Math.max(max, Number(row.timestamp) || 0), 0);
    return { heights, maxTimestamp };
  }

  async _markRunSourcesPaid(runId) {
    const { heights, maxTimestamp } = await this._getRunSourceBlocks(runId);
    if (heights.length === 0) {
      await this.ledger.createEvent({
        runId,
        eventType: 'source_finalize_skipped',
        detail: 'No source block heights were recorded for this payout run',
      });
      return { blockCount: 0, sharePaidThrough: 0 };
    }

    let changedBlocks = 0;
    if (await this._tableExists('blocks')) {
      const placeholders = heights.map(() => '?').join(',');
      const result = await this._run(
        `UPDATE blocks SET paid = 1, status = 'paid' WHERE height IN (${placeholders})`,
        heights
      );
      changedBlocks = result.changes || 0;
    }

    let sharePaidThrough = 0;
    if (this.config.payout?.sharePaidAfterConfirmed !== true && maxTimestamp > 0 && await this._tableExists('shares')) {
      await this._run(
        'UPDATE shares SET paid = 1 WHERE paid = 0 AND timestamp <= ?',
        [maxTimestamp]
      );
      sharePaidThrough = maxTimestamp;
    }

    await this.ledger.createEvent({
      runId,
      eventType: 'source_blocks_marked_paid',
      detail: `Marked ${changedBlocks} source blocks paid for payout run ${runId}`,
    });
    return { blockCount: changedBlocks, sharePaidThrough };
  }

  async _markRunSharesPaidAfterConfirmation(runId) {
    if (this.config.payout?.sharePaidAfterConfirmed !== true) {
      return { skipped: true, reason: 'sharePaidAfterConfirmed_disabled' };
    }
    if (!(await this._tableExists('shares'))) {
      return { skipped: true, reason: 'shares_table_missing' };
    }
    const { maxTimestamp } = await this._getRunSourceBlocks(runId);
    if (!maxTimestamp) {
      return { skipped: true, reason: 'source_timestamp_missing' };
    }
    await this._run(
      'UPDATE shares SET paid = 1 WHERE paid = 0 AND timestamp <= ?',
      [maxTimestamp]
    );
    await this.ledger.createEvent({
      runId,
      eventType: 'source_shares_marked_paid',
      detail: `Marked unpaid shares through ${maxTimestamp} after payout confirmation`,
    });
    return { skipped: false, sharePaidThrough: maxTimestamp };
  }

  async _preflightLiveBroadcast(runId, pendingBatches) {
    let totalPendingSats = 0;
    const invalidOutputs = [];
    const batchDetails = [];

    for (const batch of pendingBatches) {
      const outputs = await this.ledger.getBatchOutputs(batch.id);
      let batchTotalSats = 0;
      for (const out of outputs) {
        batchTotalSats += Number(out.amount_sats || 0);
        if (!isRoutableAddress(out.address)) {
          invalidOutputs.push(out.address);
        }
      }
      totalPendingSats += batchTotalSats;
      batchDetails.push({ batch, outputs, totalSats: batchTotalSats });
    }

    if (invalidOutputs.length > 0) {
      const detail = `Invalid payout output address(es): ${invalidOutputs.join(', ')}`;
      await this.ledger.createEvent({ runId, eventType: 'worker_error', detail });
      return { ok: false, error: 'invalid_output_address', detail };
    }

    // Label-scoped getbalance is not a reliable spendable-wallet total on
    // Core versions that retain legacy account accounting. It can include
    // historical label credits that are not available to sendmany. Prefer
    // the wallet-wide balance and fall back to wildcard getbalance for older
    // daemons that do not expose getwalletinfo.
    let balanceHemp;
    let balanceSource = 'getwalletinfo';
    try {
      const walletInfo = await this.rpc('getwalletinfo', []);
      balanceHemp = Number(walletInfo?.balance);
      if (!Number.isFinite(balanceHemp)) {
        throw new Error('getwalletinfo did not return a numeric wallet balance');
      }
    } catch (_err) {
      balanceSource = 'getbalance:*';
      balanceHemp = Number(await this.rpc('getbalance', ['*', 1]));
    }
    const balanceSats = Math.floor(balanceHemp * SATS_PER_HEMP);

    // Pay the oldest complete batches that fit the currently spendable
    // balance. Keeping later batches in `created` status lets the next cycle
    // resume after funding without replanning or replaying earlier batches.
    const feeReserveSats = Math.max(0, Number(this.config.payout?.preflightFeeReserveSats) || 0);
    const availableSats = Number.isFinite(balanceSats) ? Math.max(0, balanceSats - feeReserveSats) : 0;
    const payableDetails = [];
    let payableSats = 0;
    for (const detail of batchDetails) {
      if (payableSats + detail.totalSats > availableSats) break;
      payableDetails.push(detail);
      payableSats += detail.totalSats;
    }

    if (payableDetails.length === 0) {
      const nextBatchSats = batchDetails[0]?.totalSats || 0;
      const detail = `Wallet balance too low for next payout batch: balance=${balanceSats} sats, required=${nextBatchSats} sats, pending=${totalPendingSats} sats, balance_source=${balanceSource}`;
      await this.ledger.createEvent({ runId, eventType: 'balance_low', detail });
      return { ok: false, error: 'balance_low', detail, balanceSats, requiredSats: nextBatchSats, pendingSats: totalPendingSats };
    }

    const outputCount = payableDetails.reduce((sum, detail) => sum + detail.outputs.length, 0);
    const deferredBatchCount = pendingBatches.length - payableDetails.length;

    await this.ledger.createEvent({
      runId,
      eventType: 'live_preflight_passed',
      detail: `Live payout preflight passed: ${payableDetails.length}/${pendingBatches.length} batches, ${outputCount} outputs, ${payableSats} sats, deferred_batches=${deferredBatchCount}, balance_source=${balanceSource}`,
    });
    return {
      ok: true,
      totalSats: payableSats,
      pendingSats: totalPendingSats,
      outputCount,
      balanceSats,
      balanceSource,
      deferredBatchCount,
      batchesToBroadcast: payableDetails.map((detail) => detail.batch),
    };
  }

  async _getLatestReviewAction(runId) {
    const events = await this.ledger.getEventsForRun(runId);
    const reviewEvents = events.filter(
      (event) => event.event_type === 'operator_approved' || event.event_type === 'operator_rejected'
    );
    if (reviewEvents.length === 0) return null;
    return reviewEvents[reviewEvents.length - 1].event_type === 'operator_rejected' ? 'reject' : 'approve';
  }

  async _hasDryRunCompleted(runId) {
    const events = await this.ledger.getEventsForRun(runId);
    return events.some((event) => event.event_type === 'dry_run_completed');
  }

  /**
   * Process payout runs that can still have unbroadcast batches.
   * Planned runs start normally; broadcasting runs are resumed so partially
   * completed live payout work is finished before new blocks are planned.
   * @returns {Promise<object>} summary of processing results
   */
  async processActiveRuns() {
    const status = this.getAutomationStatus();
    const plannedRuns = await this.ledger.getRunsByStatus('planned');
    const broadcastingRuns = await this.ledger.getRunsByStatus('broadcasting');
    const runs = [...plannedRuns, ...broadcastingRuns].sort((a, b) => a.id - b.id);
    const results = [];
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const run of runs) {
      const result = await this.processRun(run.id);
      results.push(result);
      if (result.processed) {
        processed++;
        if (result.batches && result.batches.some((b) => !b.processed && b.error)) failed++;
      } else {
        skipped++;
      }
    }

    return { mode: status.mode, processed, skipped, failed, results };
  }

  async processPlannedRuns() {
    return this.processActiveRuns();
  }

  /**
   * Process a single payout run.
   * In dry-run mode: simulates batch broadcasts, records events, does NOT change status.
   * In live mode: broadcasts batches via RPC, advances status through broadcasting→broadcasted.
   * @param {number} runId
   * @returns {Promise<object>} processing result
   */
  async processRun(runId) {
    const status = this.getAutomationStatus();

    const acquired = await this.acquireRunLock(runId);
    if (!acquired) {
      return { runId, processed: false, skipped: true, reason: 'locked_by_another_worker' };
    }

    try {
      const run = await this.ledger.getRun(runId);
      if (!run) {
        return { runId, processed: false, skipped: true, reason: 'not_found' };
      }

      if (run.status !== 'planned' && run.status !== 'broadcasting') {
        return { runId, processed: false, skipped: true, reason: `status_${run.status}_not_processable` };
      }

      const latestReviewAction = await this._getLatestReviewAction(runId);
      if (latestReviewAction === 'reject') {
        return { runId, processed: false, skipped: true, reason: 'operator_rejected' };
      }

      const batches = await this.ledger.getBatchesForRun(runId);
      if (batches.length === 0) {
        await this.ledger.createEvent({
          runId,
          eventType: 'worker_skip',
          detail: 'No batches found in run',
        });
        return { runId, processed: false, skipped: true, reason: 'no_batches' };
      }

      const unresolvedBroadcasts = batches.filter(
        (batch) => batch.status === 'broadcasting' || batch.status === 'broadcast_unknown'
      );
      if (unresolvedBroadcasts.length > 0) {
        await this.ledger.createEvent({
          runId,
          eventType: 'worker_skip',
          detail: `Run blocked by ${unresolvedBroadcasts.length} payout batch(es) with unresolved broadcast outcome; no automatic retry is allowed`,
        });
        return {
          runId,
          processed: false,
          skipped: true,
          reason: 'unresolved_broadcast_outcome',
          unresolvedBatchIds: unresolvedBroadcasts.map((batch) => batch.id),
        };
      }

      const pendingBatches = batches.filter((b) => b.status === 'created');
      if (pendingBatches.length === 0) {
        return { runId, processed: false, skipped: true, reason: 'no_pending_batches' };
      }

      const batchResults = [];

      if (status.liveCapable) {
        if (!this.rpc) {
          await this.ledger.createEvent({
            runId,
            eventType: 'worker_error',
            detail: 'Live mode enabled but no RPC client provided; cannot broadcast',
          });
          return { runId, processed: false, error: 'no_rpc_client' };
        }

        const preflight = await this._preflightLiveBroadcast(runId, pendingBatches);
        if (!preflight.ok) {
          await this.ledger.createEvent({
            runId,
            eventType: 'worker_skip',
            detail: `Live payout preflight did not pass; run remains ${run.status} for later retry: ${preflight.detail || preflight.error}`,
          });
          return { runId, processed: false, error: preflight.error, detail: preflight.detail };
        }

        await this.ledger.updateRunStatus(runId, 'broadcasting');
        const batchesToBroadcast = preflight.batchesToBroadcast || pendingBatches;
        await this.ledger.createEvent({
          runId,
          eventType: 'broadcasting',
          detail: `Starting live broadcast of ${batchesToBroadcast.length}/${pendingBatches.length} pending batches`,
        });

        let allOk = true;
        let anyBroadcasted = false;
        const walletLabel = this.config.pool?.walletLabel || '';

        for (const batch of batchesToBroadcast) {
          let sendmanyStarted = false;
          try {
            await this.ledger.updateBatchStatus(batch.id, 'broadcasting');
            await this.ledger.createEvent({
              runId,
              batchId: batch.id,
              eventType: 'broadcasting',
              detail: `Starting broadcast for batch ${batch.batch_index}`,
            });

            const outputs = await this.ledger.getBatchOutputs(batch.id);
            if (outputs.length === 0) {
              await this.ledger.updateBatchStatus(batch.id, 'failed', { error: 'No outputs in batch' });
              batchResults.push({ batchId: batch.id, batchIndex: batch.batch_index, processed: false, error: 'No outputs' });
              allOk = false;
              continue;
            }

            const payments = {};
            for (const out of outputs) {
              payments[out.address] = parseFloat(satsToHemp(out.amount_sats));
            }

            sendmanyStarted = true;
            const txid = await this.rpc('sendmany', [walletLabel, payments]);

            await this.ledger.updateBatchStatus(batch.id, 'broadcasted', { txid });
            await this.ledger.createEvent({
              runId,
              batchId: batch.id,
              eventType: 'broadcasted',
              detail: `Broadcasted batch ${batch.batch_index} txid=${txid}`,
            });
            anyBroadcasted = true;
            batchResults.push({ batchId: batch.id, batchIndex: batch.batch_index, processed: true, txid });
          } catch (err) {
            const sanitized = this._sanitizeError(err);
            const ambiguous = sendmanyStarted && isAmbiguousBroadcastError(err);
            const nextStatus = ambiguous ? 'broadcast_unknown' : 'created';
            const detail = ambiguous
              ? `Broadcast outcome uncertain; automatic retry disabled: ${sanitized}`
              : sanitized;
            await this.ledger.updateBatchStatus(batch.id, nextStatus, { error: detail });
            await this.ledger.createEvent({
              runId,
              batchId: batch.id,
              eventType: ambiguous ? 'broadcast_unknown' : 'broadcast_failed',
              detail,
            });
            batchResults.push({ batchId: batch.id, batchIndex: batch.batch_index, processed: false, error: detail });
            allOk = false;
            if (ambiguous) break;
          }
        }

        if (allOk) {
          const currentBatches = await this.ledger.getBatchesForRun(runId);
          const stillCreated = currentBatches.filter((b) => b.status === 'created').length;
          if (stillCreated === 0) {
            const sourceFinalize = await this._markRunSourcesPaid(runId);
            await this.ledger.updateRunStatus(runId, 'broadcasted');
            await this.ledger.createEvent({
              runId,
              eventType: 'broadcasted',
              detail: `All ${currentBatches.length} batches broadcasted; ${sourceFinalize.blockCount} source blocks marked paid`,
            });
          } else {
            await this.ledger.updateRunStatus(runId, 'broadcasting');
            await this.ledger.createEvent({
              runId,
              eventType: 'broadcast_partial',
              detail: `Broadcasted ${batchesToBroadcast.length} batches; ${stillCreated} batches remain queued for later funding`,
            });
          }
        } else {
          const currentBatches = await this.ledger.getBatchesForRun(runId);
          const totalBroadcasted = currentBatches.filter((b) => b.status === 'broadcasted' || b.status === 'confirmed').length;
          const stillCreated = currentBatches.filter((b) => b.status === 'created').length;
          const unresolvedCount = currentBatches.filter(
            (b) => b.status === 'broadcasting' || b.status === 'broadcast_unknown'
          ).length;
          const nextRunStatus = unresolvedCount > 0 || totalBroadcasted > 0 || anyBroadcasted
            ? 'broadcasting'
            : 'planned';
          await this.ledger.updateRunStatus(runId, nextRunStatus);
          await this.ledger.createEvent({
            runId,
            eventType: 'broadcast_partial',
            detail: `Run kept active after batch broadcast errors; broadcasted_or_confirmed=${totalBroadcasted}, pending=${stillCreated}, unresolved=${unresolvedCount}`,
          });
        }
      } else {
        // Dry-run / disabled mode
        if (await this._hasDryRunCompleted(runId)) {
          return { runId, processed: false, skipped: true, reason: 'dry_run_already_simulated' };
        }

        await this.ledger.createEvent({
          runId,
          eventType: 'dry_run_executing',
          detail: `Dry-run mode: simulating ${pendingBatches.length} batches`,
        });

        for (const batch of pendingBatches) {
          const outputs = await this.ledger.getBatchOutputs(batch.id);
          const totalSats = outputs.reduce((sum, o) => sum + o.amount_sats, 0);
          const outputSummary = outputs
            .map((o) => `${o.address}:${o.amount_sats}`)
            .join('; ');

          const txid = `dryrun_r${runId}_b${batch.batch_index}_${Date.now()}`;

          await this.ledger.createEvent({
            runId,
            batchId: batch.id,
            eventType: 'dry_run_batch_simulated',
            detail: `Dry-run simulated broadcast batch ${batch.batch_index} txid=${txid}: total=${totalSats} sats, outputs=[${outputSummary}]`,
          });

          batchResults.push({
            batchId: batch.id,
            batchIndex: batch.batch_index,
            processed: true,
            simulated: true,
            dryRun: true,
            totalSats,
            outputCount: outputs.length,
          });
        }

        await this.ledger.createEvent({
          runId,
          eventType: 'dry_run_completed',
          detail: `Dry-run simulation complete: ${pendingBatches.length} batches simulated without real broadcast`,
        });
      }

      return { runId, processed: true, mode: status.mode, batches: batchResults };
    } finally {
      await this.releaseRunLock(runId);
    }
  }

  /**
   * Check confirmations for broadcasted batches and mark as confirmed when
   * enough confirmations have been reached.
   * @param {number} [runId] - optional run ID to scope confirmation to one run
   * @returns {Promise<object>} confirmation results
   */
  async confirmBroadcastedBatches(runId) {
    if (!this.rpc) {
      return { error: 'RPC client required for confirmation checks' };
    }

    let batches;
    if (runId) {
      batches = await this.ledger.getBatchesForRun(runId);
    } else {
      batches = await this.ledger.getBatchesByStatus('broadcasted');
    }

    const requiredConfirmations = this.config.payout?.blockConfirmations || 100;
    const results = [];
    const runsChecked = new Set();

    for (const batch of batches) {
      if (batch.status !== 'broadcasted' || !batch.txid) continue;

      try {
        const txInfo = await this.rpc('gettransaction', [batch.txid]);
        const confirmations = txInfo.confirmations || 0;

        if (confirmations >= requiredConfirmations) {
          await this.ledger.updateBatchStatus(batch.id, 'confirmed');
          await this.ledger.createEvent({
            runId: batch.run_id,
            batchId: batch.id,
            eventType: 'confirmed',
            detail: `Batch ${batch.batch_index} confirmed with ${confirmations} confirmations (>= ${requiredConfirmations})`,
          });
          runsChecked.add(batch.run_id);
          results.push({ batchId: batch.id, confirmed: true, confirmations });
        } else {
          results.push({ batchId: batch.id, confirmed: false, confirmations, required: requiredConfirmations });
        }
      } catch (err) {
        const sanitized = this._sanitizeError(err);
        results.push({ batchId: batch.id, confirmed: false, error: sanitized });
      }
    }

    // If all batches in a run are confirmed, mark the run as confirmed
    for (const rid of runsChecked) {
      const runBatches = await this.ledger.getBatchesForRun(rid);
      const allConfirmed = runBatches.every((b) => b.status === 'confirmed');
      if (allConfirmed) {
        await this._markRunSharesPaidAfterConfirmation(rid);
        await this.ledger.updateRunStatus(rid, 'confirmed');
        await this.ledger.createEvent({
          runId: rid,
          eventType: 'confirmed',
          detail: 'All batches confirmed',
        });
      }
    }

    return { results, runsUpdated: [...runsChecked] };
  }

  /**
   * Detect payout runs stuck in non-terminal states beyond the stale timeout.
   * Records stale_detected events for qualifying runs.
   * @returns {Promise<object>} detection results
   */
  async detectStaleRuns() {
    const stalledRuns = await this.ledger.getStalledRuns();
    const staleTimeout = this.config.payout?.staleLockTimeoutMs || 3600000;
    const now = Date.now();
    const results = [];

    for (const run of stalledRuns) {
      const age = now - run.created_at;
      if (age > staleTimeout) {
        const locked = await this.isRunLocked(run.id);
        results.push({
          runId: run.id,
          status: run.status,
          ageMs: age,
          stale: true,
          locked,
        });

        await this.ledger.createEvent({
          runId: run.id,
          eventType: 'stale_detected',
          detail: `Run ${run.id} is stale (${age}ms old, status=${run.status}, locked=${locked})`,
        });
      }
    }

    return { staleCount: results.length, results };
  }

  /**
   * Detect batches stuck in non-terminal states beyond the stale timeout.
   * @param {number} [staleMs] - override stale timeout in ms
   * @returns {Promise<object>} detection results
   */
  async detectStaleBatches(staleMs) {
    const timeout = staleMs || this.config.payout?.staleLockTimeoutMs || 3600000;
    const [broadcasting, broadcasted] = await Promise.all([
      this.ledger.getBatchesByStatus('broadcasting'),
      this.ledger.getBatchesByStatus('broadcasted'),
    ]);

    const allStuck = [...broadcasting, ...broadcasted];
    const now = Date.now();
    const results = [];

    for (const batch of allStuck) {
      const refTime = batch.broadcast_at || batch.created_at;
      if (refTime && (now - refTime) > timeout) {
        results.push({
          batchId: batch.id,
          runId: batch.run_id,
          batchIndex: batch.batch_index,
          status: batch.status,
          ageMs: now - refTime,
          stale: true,
        });

        await this.ledger.createEvent({
          runId: batch.run_id,
          batchId: batch.id,
          eventType: 'stale_batch_detected',
          detail: `Batch ${batch.id} (idx=${batch.batch_index}) stuck in ${batch.status} for ${now - refTime}ms`,
        });
      }
    }

    return { staleCount: results.length, results };
  }
}

module.exports = { PayoutWorker, LOCK_WORKER, LOCK_RUN_PREFIX, isAmbiguousBroadcastError };
