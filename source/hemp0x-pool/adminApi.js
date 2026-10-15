const { redactSecrets, sanitizeError, clampLimit } = require('./configRedaction');
const { getSafetyGateStatus } = require('./config');
const { schema, getFieldsByCategory, validateConfig } = require('./configSchema');
const { planPayout } = require('./payoutPlanner');
const { PayoutLedger } = require('./payoutLedger');
const { planConsolidation } = require('./consolidationPlanner');
const { isP2PKHAddress } = require('./address');

const ADMIN_AUTH_WINDOW_MS = 60000;
const ADMIN_AUTH_MAX_FAILURES = 10;

function adminAuth(config) {
  const token = config.adminToken || process.env.HEMP0X_POOL_ADMIN_TOKEN;
  const failures = new Map();

  function requestAddress(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  function failedAttempt(req, res) {
    const now = Date.now();
    const address = requestAddress(req);
    const current = failures.get(address);
    const state = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + ADMIN_AUTH_WINDOW_MS }
      : current;

    state.count += 1;
    failures.set(address, state);

    if (failures.size > 10000) {
      for (const [key, entry] of failures.entries()) {
        if (entry.resetAt <= now) failures.delete(key);
      }
    }

    if (state.count > ADMIN_AUTH_MAX_FAILURES) {
      res.setHeader('Retry-After', Math.ceil((state.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many authentication attempts' });
    }

    return res.status(401).json({ error: 'Authentication required' });
  }

  return function (req, res, next) {
    if (!token) {
      const addr = requestAddress(req);
      const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
      if (isLocal) return next();
      return res.status(403).json({ error: 'Admin endpoints disabled (no admin token configured). Access restricted to localhost.' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return failedAttempt(req, res);
    }

    const providedToken = authHeader.slice(7);
    if (!safeCompare(providedToken, token)) {
      return failedAttempt(req, res);
    }

    failures.delete(requestAddress(req));
    next();
  };
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let result = 0;
  const lenA = a.length;
  const lenB = b.length;
  const maxLen = Math.max(lenA, lenB);
  for (let i = 0; i < maxLen; i++) {
    const charA = i < lenA ? a.charCodeAt(i) : 0;
    const charB = i < lenB ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }
  return lenA === lenB && result === 0;
}

function buildSchemaMetadata() {
  const result = {};
  for (const section of Object.keys(schema)) {
    result[section] = {};
    for (const key of Object.keys(schema[section])) {
      const entry = schema[section][key];
      result[section][key] = {
        category: entry.category,
        description: entry.description,
        type: entry.type,
        message: entry.message || null,
      };
    }
  }
  return result;
}

function getLoadedConfigCategories(config) {
  const categories = [];
  for (const key of Object.keys(config)) {
    if (schema[key]) {
      categories.push({
        section: key,
        keys: Object.keys(config[key]).filter((k) => schema[key][k]),
      });
    } else {
      categories.push({ section: key, keys: Object.keys(config[key]), unknown: true });
    }
  }
  return categories;
}

function getAdminRouteConfig(config) {
  const redacted = redactSecrets(config);
  const safetyGates = getSafetyGateStatus(config);
  const schemaMetadata = buildSchemaMetadata();
  const secretKeys = getFieldsByCategory('secret').map((f) => f.path);
  const dangerousKeys = getFieldsByCategory('dangerous').map((f) => f.path);
  const tunableKeys = getFieldsByCategory('tunable').map((f) => f.path);
  const publicKeys = getFieldsByCategory('public').map((f) => f.path);

  return {
    config: redacted,
    meta: {
      schema: schemaMetadata,
      categories: {
        public: publicKeys,
        tunable: tunableKeys,
        dangerous: dangerousKeys,
        secret: secretKeys,
        secretCount: secretKeys.length,
      },
    },
    safetyGates,
    loadedConfigCategories: getLoadedConfigCategories(config),
    frozen: true,
  };
}

function parseOptionalPositiveInt(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    return { error: `${fieldName} must be a positive integer` };
  }
  return { value: number };
}

function adminJsonErrorHandler(err, req, res, next) {
  if (!req.path || !req.path.startsWith('/admin')) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  next(err);
}

/**
 * Returns a summary of recent payout events from the payout ledger.
 * Sources confirmed/broadcasted batch outputs from `payout_batch_outputs`
 * joined with `payout_batches` — the canonical ledger-backed payout tables.
 * Falls back to empty result if ledger tables don't exist yet.
 */
async function getRecentPayoutSummary(db, limit = 10) {
  try {
    const rows = await db.all(
      `SELECT pb.broadcast_at as timestamp, pbo.category,
              (CAST(pbo.amount_sats AS REAL) / 100000000.0) as amount,
              pb.txid
       FROM payout_batch_outputs pbo
       JOIN payout_batches pb ON pb.id = pbo.batch_id
       WHERE pb.status IN ('broadcasted', 'confirmed')
       ORDER BY pb.broadcast_at DESC
       LIMIT ?`,
      [limit],
      'adminStatusPayments'
    );
    const countRows = await db.all(
      `SELECT COUNT(*) as total
       FROM payout_batch_outputs pbo
       JOIN payout_batches pb ON pb.id = pbo.batch_id
       WHERE pb.status IN ('broadcasted', 'confirmed')`,
      [],
      'adminStatusCountPayouts'
    );
    const total = countRows && countRows.length > 0 ? countRows[0].total : 0;
    return {
      recentCount: rows.length,
      totalPayments: total,
      recent: rows.map((r) => ({
        timestamp: r.timestamp,
        category: r.category,
        amount: r.amount,
        txid: r.txid ? `${r.txid.slice(0, 8)}...` : null,
      })),
    };
  } catch (e) {
    return { recentCount: 0, totalPayments: 0, recent: [] };
  }
}

/**
 * Returns a summary of recent consolidation events from the consolidation ledger.
 */
async function getRecentConsolidationSummary(db, limit = 10) {
  try {
    const rows = await db.all(
      'SELECT event_at as timestamp, event_type, details FROM consolidation_events ORDER BY event_at DESC LIMIT ?',
      [limit],
      'adminStatusConsolidation'
    );
    if (!rows || rows.length === 0) return { recentCount: 0, recent: [] };
    return {
      recentCount: rows.length,
      recent: rows.map((r) => {
        let detail = {};
        try {
          if (typeof r.details === 'string') detail = JSON.parse(r.details);
          else if (r.details) detail = r.details;
        } catch (e) { /* ignore parse errors */ }
        return {
          timestamp: r.timestamp,
          eventType: r.event_type || detail.event_type || 'unknown',
        };
      }),
    };
  } catch (e) {
    return { recentCount: 0, recent: [] };
  }
}

function initAdminRoutes(app, config, sharedState) {
  const auth = adminAuth(config);

  app.get('/admin/config', auth, (req, res) => {
    const data = getAdminRouteConfig(config);
    res.json(data);
  });

  app.get('/admin/status', auth, async (req, res) => {
    const now = Date.now();
    let activeMiners = 0;
    let poolHashrate = 0;

    sharedState.workers.forEach((w) => {
      if (now - w.lastSeen < 120000) {
        activeMiners++;
        poolHashrate += w.hashrate;
      }
    });

    let payoutSummary = { recentCount: 0, totalPayments: 0, recent: [] };
    let consolidationSummary = { recentCount: 0, recent: [] };

    if (sharedState.db) {
      payoutSummary = await getRecentPayoutSummary(sharedState.db, 10);
      consolidationSummary = await getRecentConsolidationSummary(sharedState.db, 10);
    }

    const payoutCfg = config.payout || {};
    const autoCfg = config.automation || {};
    const dryRun = payoutCfg.dryRun !== false;
    const routineEnabled = autoCfg.routinePayoutEnabled === true;
    const broadcastEnabled = autoCfg.payoutBroadcastEnabled === true;
    const liveCapable = !dryRun && routineEnabled && broadcastEnabled;

    let payoutAutomationMode;
    let payoutAutomationMessage;
    if (liveCapable) {
      payoutAutomationMode = 'live';
      payoutAutomationMessage = 'All broadcast gates open. Payouts will broadcast real transactions.';
    } else if (dryRun) {
      payoutAutomationMode = 'dry_run';
      payoutAutomationMessage = 'Dry-run simulation only. No transactions are broadcast.';
    } else {
      payoutAutomationMode = 'disabled';
      payoutAutomationMessage = 'Payout automation is disabled.';
    }

    const status = {
      uptimeSec: process.uptime(),
      uptimeFormatted: formatUptime(process.uptime()),
      daemonHealth: {
        ok: sharedState.daemonHealth.ok,
        height: sharedState.daemonHealth.height,
        lastChecked: sharedState.daemonHealth.lastChecked,
        error: sharedState.daemonHealth.error ? sanitizeError(sharedState.daemonHealth.error) : null,
      },
      pool: {
        activeMiners,
        totalWorkers: sharedState.workers.size,
        poolHashrate: poolHashrate.toFixed(2),
        totalShares: sharedState.stats.shares,
        currentHeight: sharedState.currentTemplate ? sharedState.currentTemplate.height : 0,
        currentTemplateAvailable: !!sharedState.currentTemplate,
      },
      payoutAutomation: {
        mode: payoutAutomationMode,
        message: payoutAutomationMessage,
        gates: {
          dryRun,
          routinePayoutEnabled: routineEnabled,
          payoutBroadcastEnabled: broadcastEnabled,
          liveCapable,
        },
      },
      config: {
        loadedCategories: getLoadedConfigCategories(config).map((c) => c.section),
        safetyGates: getSafetyGateStatus(config),
      },
      ledgers: {
        payout: payoutSummary,
        consolidation: consolidationSummary,
      },
      node: {
        version: process.version,
        pid: process.pid,
        memoryUsage: process.memoryUsage(),
      },
    };

    res.json(status);
  });

  app.post('/admin/payout/plan', auth, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }

      const payoutCfg = config.payout || {};
      if (payoutCfg.dryRun !== true) {
        return res.status(400).json({ error: 'Safety gate: payout.dryRun must be true' });
      }

      const maxBlocks = clampLimit(body.maxBlocks, 500, 2000);
      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

      const rawDb = sharedState.rawDb;
      if (!rawDb) {
        return res.status(503).json({ error: 'Database not available for payout planning' });
      }

      if (!sharedState.db || typeof sharedState.db.getUnpaidConfirmedBlocks !== 'function') {
        return res.status(503).json({ error: 'Database methods not available for payout planning' });
      }

      const ledger = new PayoutLedger(rawDb);

      const blocks = await sharedState.db.getUnpaidConfirmedBlocks();
      const limitedBlocks = blocks.slice(0, maxBlocks);

      const dbPplnsLookup = typeof sharedState.db.getPplnsWeightsForBlock === 'function'
        ? sharedState.db.getPplnsWeightsForBlock.bind(sharedState.db)
        : undefined;

      const plan = await planPayout({
        db: {
          getUnpaidConfirmedBlocks: async () => limitedBlocks,
          getActiveMinersForBlock: sharedState.db.getActiveMinersForBlock.bind(sharedState.db),
          getMinersForBlockWindow: sharedState.db.getMinersForBlockWindow.bind(sharedState.db),
          ...(dbPplnsLookup ? { getPplnsWeightsForBlock: dbPplnsLookup } : {}),
        },
        config,
        payoutLedger: ledger,
      });

      if (note) {
        await ledger.createEvent({ runId: plan.runId, eventType: 'plan_created', detail: note });
      }

      const redactedBatches = (plan.batches || []).map((b) => ({
        batchIndex: b.batchIndex,
        outputCount: b.outputCount,
        totalSats: b.totalSats,
        outputs: (b.outputs || []).map((o) => ({
          address: o.address,
          amountSats: o.amountSats,
        })),
      }));

      res.json({
        runId: plan.runId,
        generatedAt: plan.generatedAt,
        totals: plan.totals,
        blocksConsidered: plan.blocksConsidered.length,
        blockCredits: plan.blockCredits.map((bc) => ({
          height: bc.height,
          rewardSats: bc.rewardSats,
          feeDeductedSats: bc.feeDeductedSats,
          finderBonusSats: bc.finderBonusSats,
          remainderSats: bc.remainderSats,
          minerCount: bc.minerCount,
          fallbackUsed: bc.fallbackUsed,
        })),
        minerCount: plan.minerCredits.length,
        batchCount: redactedBatches.length,
        batches: redactedBatches,
        skippedCount: (plan.skipped || []).length,
        warningCount: (plan.warnings || []).length,
        warnings: (plan.warnings || []).slice(0, 100),
        note: note,
      });
    } catch (e) {
      res.status(500).json({ error: sanitizeError(e) });
    }
  });

  app.post('/admin/consolidation/plan', auth, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }

      const cc = config.consolidation || {};
      if (cc.enabled !== false) {
        return res.status(400).json({ error: 'Safety gate: consolidation.enabled must be false' });
      }
      if (cc.dryRunOnly !== true) {
        return res.status(400).json({ error: 'Safety gate: consolidation.dryRunOnly must be true' });
      }
      const automation = config.automation || {};
      if (automation.consolidationBroadcastEnabled !== false) {
        return res.status(400).json({ error: 'Safety gate: automation.consolidationBroadcastEnabled must be false' });
      }

      const rpc = sharedState.rpc;
      if (!rpc || typeof rpc !== 'function') {
        return res.status(503).json({ error: 'RPC client not available for consolidation planning' });
      }

      const destinationAddress = typeof body.destinationAddress === 'string' && body.destinationAddress.length > 0
        ? body.destinationAddress
        : cc.destinationAddress;
      if (!destinationAddress) {
        return res.status(400).json({ error: 'destinationAddress is required' });
      }
      if (!isP2PKHAddress(destinationAddress)) {
        return res.status(400).json({ error: 'destinationAddress must be a valid Hemp0x P2PKH address' });
      }

      const maxBatchesPreview = clampLimit(body.maxBatchesPreview, 20, 100);
      const requestedMinConfirmations = parseOptionalPositiveInt(body.minConfirmations, 'minConfirmations');
      if (requestedMinConfirmations && requestedMinConfirmations.error) {
        return res.status(400).json({ error: requestedMinConfirmations.error });
      }
      const minConfirmations = requestedMinConfirmations && requestedMinConfirmations.value
        ? Math.max(requestedMinConfirmations.value, cc.minConfirmations || 100)
        : cc.minConfirmations;

      const planConfig = {
        ...config,
        consolidation: { ...cc, minConfirmations },
      };

      const plan = await planConsolidation({
        rpc,
        config: planConfig,
        destinationAddress,
        walletLabel: cc.destinationAddress === destinationAddress ? null : destinationAddress,
      });

      const previewBatches = (plan.batches || []).slice(0, maxBatchesPreview);

      const redactedBatches = previewBatches.map((b) => ({
        batchIndex: b.batchIndex,
        inputCount: b.selectedInputs.length,
        destinationAddress: b.destinationAddress,
        totalInputSats: b.totalInputSats,
        estimatedFeeSats: b.estimatedFeeSats,
        estimatedTxSizeBytes: b.estimatedTxSizeBytes,
        expectedOutputCount: b.expectedOutputCount,
        expectedPostConsolidationShape: b.expectedPostConsolidationShape,
      }));

      res.json({
        generatedAt: plan.generatedAt,
        configSnapshot: plan.configSnapshot,
        totalCandidates: plan.totalCandidates,
        reserved: plan.reserved,
        reservedSats: plan.reservedSats,
        batchCount: plan.batches.length,
        totalInputs: plan.totalInputs,
        totalInputSats: plan.totalInputSats,
        totalFeeSats: plan.totalFeeSats,
        batches: redactedBatches,
        warningCount: (plan.warnings || []).length,
        warnings: (plan.warnings || []).slice(0, 100),
        operatorChecklist: plan.operatorChecklist,
      });
    } catch (e) {
      res.status(500).json({ error: sanitizeError(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Plan History & Review
  // ---------------------------------------------------------------------------

  app.get('/admin/payout/runs', auth, async (req, res) => {
    try {
      const rawDb = sharedState.rawDb;
      if (!rawDb) {
        return res.status(503).json({ error: 'Database not available' });
      }

      const limit = clampLimit(req.query && req.query.limit ? Number(req.query.limit) : 20, 20, 100);
      const offset = Math.max(0, Number(req.query && req.query.offset) || 0);

      const ledger = new PayoutLedger(rawDb);
      const result = await ledger.getRunsPaginated(limit, offset);

      const redactedRuns = result.runs.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        block_height_start: r.block_height_start,
        block_height_end: r.block_height_end,
        total_blocks: r.total_blocks,
        total_miners: r.total_miners,
        total_amount_sats: r.total_amount_sats,
        fee_amount_sats: r.fee_amount_sats,
        net_amount_sats: r.net_amount_sats,
        completed_at: r.completed_at || null,
      }));

      res.json({
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        runs: redactedRuns,
      });
    } catch (e) {
      res.status(500).json({ error: sanitizeError(e) });
    }
  });

  app.get('/admin/payout/runs/:runId', auth, async (req, res) => {
    try {
      const rawDb = sharedState.rawDb;
      if (!rawDb) {
        return res.status(503).json({ error: 'Database not available' });
      }

      const runId = parseInt(req.params.runId, 10);
      if (!Number.isSafeInteger(runId) || runId < 1) {
        return res.status(400).json({ error: 'runId must be a positive integer' });
      }

      const ledger = new PayoutLedger(rawDb);
      const detail = await ledger.getRunDetail(runId);

      if (!detail) {
        return res.status(404).json({ error: 'Payout run not found' });
      }

      const redacted = {
        run: {
          id: detail.run.id,
          created_at: detail.run.created_at,
          status: detail.run.status,
          block_height_start: detail.run.block_height_start,
          block_height_end: detail.run.block_height_end,
          total_blocks: detail.run.total_blocks,
          total_miners: detail.run.total_miners,
          total_amount_sats: detail.run.total_amount_sats,
          fee_amount_sats: detail.run.fee_amount_sats,
          net_amount_sats: detail.run.net_amount_sats,
          completed_at: detail.run.completed_at || null,
        },
        blockCredits: (detail.blockCredits || []).map((bc) => ({
          height: bc.height,
          finder: bc.finder,
          mode: bc.mode,
          reward_sats: bc.reward_sats,
          fee_deducted_sats: bc.fee_deducted_sats,
          finder_bonus_sats: bc.finder_bonus_sats,
          remainder_sats: bc.remainder_sats,
          miner_count: bc.miner_count,
        })),
        minerCredits: (detail.minerCredits || []).map((mc) => ({
          miner: mc.miner,
          category: mc.category,
          amount_sats: mc.amount_sats,
        })),
        batches: (detail.batches || []).map((b) => ({
          batch_index: b.batch_index,
          status: b.status,
          output_count: b.output_count,
          total_amount_sats: b.total_amount_sats,
          fee_estimate_sats: b.fee_estimate_sats,
          outputs: (b.outputs || []).map((o) => ({
            address: o.address,
            amount_sats: o.amount_sats,
          })),
        })),
        events: (detail.events || []).map((ev) => ({
          event_type: ev.event_type,
          detail: ev.detail,
          created_at: ev.created_at,
        })),
      };

      res.json(redacted);
    } catch (e) {
      res.status(500).json({ error: sanitizeError(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Non-Broadcast Approval / Rejection
  // ---------------------------------------------------------------------------

  app.post('/admin/payout/runs/:runId/approve', auth, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }

      const rawDb = sharedState.rawDb;
      if (!rawDb) {
        return res.status(503).json({ error: 'Database not available' });
      }

      const runId = parseInt(req.params.runId, 10);
      if (!Number.isSafeInteger(runId) || runId < 1) {
        return res.status(400).json({ error: 'runId must be a positive integer' });
      }

      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

      const ledger = new PayoutLedger(rawDb);
      const run = await ledger.getRun(runId);
      if (!run) {
        return res.status(404).json({ error: 'Payout run not found' });
      }

      await ledger.createReviewEvent(runId, 'approve', note);

      res.json({
        runId,
        action: 'approve',
        status: 'operator_review_intent_recorded',
        note: note || null,
        reviewedAt: new Date().toISOString(),
        message: 'Operator approval recorded. This is a review-only action. No transaction was signed or broadcast.',
      });
    } catch (e) {
      res.status(500).json({ error: sanitizeError(e) });
    }
  });

  app.post('/admin/payout/runs/:runId/reject', auth, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }

      const rawDb = sharedState.rawDb;
      if (!rawDb) {
        return res.status(503).json({ error: 'Database not available' });
      }

      const runId = parseInt(req.params.runId, 10);
      if (!Number.isSafeInteger(runId) || runId < 1) {
        return res.status(400).json({ error: 'runId must be a positive integer' });
      }

      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
      if (!reason) {
        return res.status(400).json({ error: 'reason is required for rejection' });
      }

      const ledger = new PayoutLedger(rawDb);
      const run = await ledger.getRun(runId);
      if (!run) {
        return res.status(404).json({ error: 'Payout run not found' });
      }

      await ledger.createReviewEvent(runId, 'reject', reason);

      res.json({
        runId,
        action: 'reject',
        status: 'operator_review_intent_recorded',
        reason,
        reviewedAt: new Date().toISOString(),
        message: 'Operator rejection recorded. This is a review-only action. No transaction was signed or broadcast.',
      });
    } catch (e) {
      res.status(500).json({ error: sanitizeError(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Dry-Run Plan Cleanup Policy (Report-Only)
  // ---------------------------------------------------------------------------

  app.get('/admin/payout/cleanup-report', auth, async (req, res) => {
    try {
      const rawDb = sharedState.rawDb;
      if (!rawDb) {
        return res.status(503).json({ error: 'Database not available' });
      }

      const days = clampLimit(
        req.query && req.query.days ? Number(req.query.days) : 30,
        7,
        365
      );

      const ledger = new PayoutLedger(rawDb);
      const staleRuns = await ledger.getStaleRuns(days);

      const redactedRuns = staleRuns.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        total_blocks: r.total_blocks,
        total_miners: r.total_miners,
        total_amount_sats: r.total_amount_sats,
      }));

      let batchCount = 0;
      let outputCount = 0;
      for (const r of staleRuns) {
        const batches = await ledger.getBatchesForRun(r.id);
        batchCount += batches.length;
        for (const b of batches) {
          const outputs = await ledger.getBatchOutputs(b.id);
          outputCount += outputs.length;
        }
      }

      res.json({
        eligibleReport: true,
        olderThanDays: days,
        staleRunCount: staleRuns.length,
        staleBatchCount: batchCount,
        staleOutputCount: outputCount,
        staleRuns: redactedRuns,
        policy: {
          action: 'report_only',
          reason: 'Deletion is not implemented in this release. Dry-run records are safe but may accumulate over time. Manual review is recommended before any future cleanup.',
          recommendation: 'Periodically review and archive old dry-run plans. This endpoint identifies candidates.',
        },
      });
    } catch (e) {
      res.status(500).json({ error: sanitizeError(e) });
    }
  });

  app.post('/admin/config/validate', auth, (req, res) => {
    const proposed = req.body;

    if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
      return res.status(400).json({
        valid: false,
        errors: [{ message: 'Request body must be a JSON object' }],
        validatedAt: new Date().toISOString(),
      });
    }

    const validationResult = validateConfig(proposed);

    const safetyCheck = (() => {
      if (proposed.payout?.dryRun === false) {
        return { name: 'payout.dryRun', passing: false, message: 'Safety gate violated: payout.dryRun must be true' };
      }
      if (proposed.consolidation?.enabled === true) {
        return { name: 'consolidation.enabled', passing: false, message: 'Safety gate violated: consolidation.enabled must be false' };
      }
      if (proposed.consolidation?.dryRunOnly === false) {
        return { name: 'consolidation.dryRunOnly', passing: false, message: 'Safety gate violated: consolidation.dryRunOnly must be true' };
      }
      if (proposed.automation?.consolidationBroadcastEnabled === true) {
        return { name: 'automation.consolidationBroadcastEnabled', passing: false, message: 'Safety gate violated: automation.consolidationBroadcastEnabled must be false' };
      }
      if (proposed.automation?.routinePayoutEnabled === true) {
        return { name: 'automation.routinePayoutEnabled', passing: false, message: 'Safety gate violated: automation.routinePayoutEnabled must be false' };
      }
      return null;
    })();

    const schemaErrors = validationResult.errors.map((e) => ({
      path: e.path,
      message: e.message,
    }));

    const allErrors = [];
    if (safetyCheck && !safetyCheck.passing) {
      allErrors.push({ path: safetyCheck.name, message: safetyCheck.message });
    }
    allErrors.push(...schemaErrors);

    res.json({
      valid: allErrors.length === 0,
      errors: allErrors,
      schemaErrors: schemaErrors.length,
      safetyGateErrors: safetyCheck && !safetyCheck.passing ? 1 : 0,
      validatedAt: new Date().toISOString(),
      readonly: true,
    });
  });

  app.use(adminJsonErrorHandler);
}

function formatUptime(uptimeSec) {
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = Math.floor(uptimeSec % 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

module.exports = {
  adminAuth,
  getAdminRouteConfig,
  initAdminRoutes,
  safeCompare,
  formatUptime,
  adminJsonErrorHandler,
};
