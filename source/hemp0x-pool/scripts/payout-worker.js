#!/usr/bin/env node
const db = require('../database');
const { loadConfig } = require('../config');
const { createRpcClient } = require('../rpcClient');
const { PayoutLedger } = require('../payoutLedger');
const { PayoutWorker } = require('../payoutWorker');
const { planPayout } = require('../payoutPlanner');
const { createPacedRpc } = require('../payoutRpcPacing');
const { MigrationRunner } = require('../migrations');
const path = require('path');

const LIVE_CONFIRM_VALUE = 'I_UNDERSTAND_THIS_BROADCASTS_REAL_PAYOUTS';

function usage() {
  console.error(`Usage:
  node scripts/payout-worker.js --plan [--max-blocks N]
  node scripts/payout-worker.js --process [--run-id N] [--live]
  node scripts/payout-worker.js --confirm [--run-id N]
  node scripts/payout-worker.js --cycle [--max-blocks N] [--live]

Live broadcast requires both:
  --live
  HEMP0X_POOL_LIVE_PAYOUT_CONFIRM=${LIVE_CONFIRM_VALUE}
`);
}

function parseArgs(argv) {
  const args = {
    plan: false,
    process: false,
    confirm: false,
    cycle: false,
    live: false,
    runId: null,
    maxBlocks: 500,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan') args.plan = true;
    else if (arg === '--process') args.process = true;
    else if (arg === '--confirm') args.confirm = true;
    else if (arg === '--cycle') args.cycle = true;
    else if (arg === '--live') args.live = true;
    else if (arg === '--run-id') args.runId = Number(argv[++i]);
    else if (arg === '--max-blocks') args.maxBlocks = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const actionCount = [args.plan, args.process, args.confirm, args.cycle].filter(Boolean).length;
  if (actionCount !== 1) {
    throw new Error('Choose exactly one action: --plan, --process, --confirm, or --cycle');
  }
  if (args.runId !== null && (!Number.isInteger(args.runId) || args.runId <= 0)) {
    throw new Error('--run-id must be a positive integer');
  }
  if (!Number.isInteger(args.maxBlocks) || args.maxBlocks <= 0 || args.maxBlocks > 2000) {
    throw new Error('--max-blocks must be an integer between 1 and 2000');
  }
  return args;
}

function enableLivePayoutConfig(config, args) {
  if (!args.live) return config;

  if (process.env.HEMP0X_POOL_LIVE_PAYOUT_CONFIRM !== LIVE_CONFIRM_VALUE) {
    throw new Error('Refusing live payout broadcast: missing explicit HEMP0X_POOL_LIVE_PAYOUT_CONFIRM value');
  }

  return {
    ...config,
    payout: {
      ...config.payout,
      dryRun: false,
    },
    automation: {
      ...config.automation,
      routinePayoutEnabled: true,
      payoutBroadcastEnabled: true,
    },
  };
}

async function createPayoutPlan({ db, ledger, config, maxBlocks }) {
  const activeRuns = [
    ...(await ledger.getRunsByStatus('planned')),
    ...(await ledger.getRunsByStatus('broadcasting')),
    ...(await ledger.getRunsByStatus('broadcasted')),
  ];
  if (activeRuns.length > 0) {
    return {
      runId: null,
      blocksConsidered: [],
      minerCredits: [],
      batches: [],
      totals: {
        grossRewardSats: 0,
        feeDeductedSats: 0,
        finderBonusTotalSats: 0,
        remainderTotalSats: 0,
        batchCount: 0,
        totalBatchedSats: 0,
        uniqueMiners: 0,
        payableMiners: 0,
      },
      warnings: [`Payout planning skipped: ${activeRuns.length} active payout run(s) must finish or confirm first`],
      noOp: true,
      blockedByActiveRuns: activeRuns.map((run) => ({ id: run.id, status: run.status })),
    };
  }

  const blocks = await db.getUnpaidConfirmedBlocks();
  const limitedBlocks = blocks.slice(0, maxBlocks);
  if (limitedBlocks.length === 0) {
    return {
      runId: null,
      blocksConsidered: [],
      minerCredits: [],
      batches: [],
      totals: {
        grossRewardSats: 0,
        feeDeductedSats: 0,
        finderBonusTotalSats: 0,
        remainderTotalSats: 0,
        batchCount: 0,
        totalBatchedSats: 0,
        uniqueMiners: 0,
        payableMiners: 0,
      },
      warnings: [],
      noOp: true,
    };
  }

  const settledHeights = new Set(
    await ledger.getHeightsWithBroadcastedBatches(limitedBlocks.map((block) => block.height))
  );
  const safeBlocks = limitedBlocks.filter((block) => !settledHeights.has(Number(block.height)));
  const payoutRisk = {
    contaminatedBlockCount: settledHeights.size,
    firstContaminatedHeight: settledHeights.size > 0 ? Math.min(...settledHeights) : null,
    lastContaminatedHeight: settledHeights.size > 0 ? Math.max(...settledHeights) : null,
  };
  const payoutRiskWarning = settledHeights.size > 0
    ? `Skipped ${settledHeights.size} source block(s) with existing broadcasted or confirmed payout batches; reconciliation required before retrying them`
    : null;

  if (safeBlocks.length === 0) {
    return {
      runId: null,
      blocksConsidered: [],
      minerCredits: [],
      batches: [],
      totals: {
        grossRewardSats: 0,
        feeDeductedSats: 0,
        finderBonusTotalSats: 0,
        remainderTotalSats: 0,
        batchCount: 0,
        totalBatchedSats: 0,
        uniqueMiners: 0,
        payableMiners: 0,
      },
      warnings: [payoutRiskWarning],
      noOp: true,
      payoutRisk,
    };
  }

  const plan = await planPayout({
    db: {
      getUnpaidConfirmedBlocks: async () => safeBlocks,
      getActiveMinersForBlock: db.getActiveMinersForBlock.bind(db),
      getMinersForBlockWindow: db.getMinersForBlockWindow.bind(db),
      getPplnsWeightsForBlock: db.getPplnsWeightsForBlock.bind(db),
    },
    config,
    payoutLedger: ledger,
  });
  plan.payoutRisk = payoutRisk;
  if (payoutRiskWarning) plan.warnings.unshift(payoutRiskWarning);
  return plan;
}

function summarizePlan(plan) {
  return {
    runId: plan.runId,
    blocksConsidered: plan.blocksConsidered.length,
    minerCount: plan.minerCredits.length,
    batchCount: plan.batches.length,
    totals: plan.totals,
    warningCount: plan.warnings.length,
    warnings: plan.warnings.slice(0, 20),
    noOp: plan.noOp === true,
    blockedByActiveRuns: plan.blockedByActiveRuns || [],
    payoutRisk: plan.payoutRisk || null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = enableLivePayoutConfig(loadConfig(), args);
  const rawDb = db.getConnection();
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  await new MigrationRunner(rawDb, migrationsDir).applyMigrations();
  const ledger = new PayoutLedger(rawDb);

  if (args.plan) {
    const plan = await createPayoutPlan({ db, ledger, config, maxBlocks: args.maxBlocks });
    console.log(JSON.stringify({ action: 'plan', ...summarizePlan(plan) }, null, 2));
    return;
  }

  const baseRpc = createRpcClient(config);
  const rpc = createPacedRpc(baseRpc, {
    delayMs: config.payout?.rpcDelayMs ?? 500,
    maxRetries: config.payout?.rpcTransientRetries ?? 2,
    backoffMs: config.payout?.rpcTransientBackoffMs ?? 2000,
  });
  const worker = new PayoutWorker({ db: rawDb, ledger, config, rpc });

  if (args.process) {
    const result = args.runId
      ? await worker.processRun(args.runId)
      : await worker.processActiveRuns();
    console.log(JSON.stringify({
      action: 'process',
      liveRequested: args.live,
      automation: worker.getAutomationStatus(),
      result,
    }, null, 2));
    return;
  }

  if (args.confirm) {
    const result = await worker.confirmBroadcastedBatches(args.runId || undefined);
    console.log(JSON.stringify({
      action: 'confirm',
      result,
    }, null, 2));
    return;
  }

  if (args.cycle) {
    const confirmation = await worker.confirmBroadcastedBatches();
    const activeProcessing = await worker.processActiveRuns();
    const plan = await createPayoutPlan({ db, ledger, config, maxBlocks: args.maxBlocks });
    let processResult = null;
    if (!plan.noOp && plan.batches.length > 0) {
      processResult = await worker.processRun(plan.runId);
    }
    console.log(JSON.stringify({
      action: 'cycle',
      liveRequested: args.live,
      automation: worker.getAutomationStatus(),
      confirmation,
      activeProcessing,
      plan: summarizePlan(plan),
      process: processResult,
    }, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(`[payout-worker] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    db.getConnection().close(() => {});
  });
