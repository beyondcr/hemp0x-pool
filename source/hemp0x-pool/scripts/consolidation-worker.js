#!/usr/bin/env node
const db = require('../database');
const { loadConfig } = require('../config');
const { createRpcClient } = require('../rpcClient');
const { ConsolidationLedger } = require('../consolidationLedger');
const { ConsolidationExecutor, LIVE_CONFIRM_VALUE } = require('../consolidationExecutor');
const { PayoutLedger } = require('../payoutLedger');
const { MigrationRunner } = require('../migrations');
const path = require('path');

function usage() {
  console.error(`Usage:
  node scripts/consolidation-worker.js --health
  node scripts/consolidation-worker.js --plan [--max-batches N] [--max-inputs N] [--target-utxos N]
  node scripts/consolidation-worker.js --process [--max-batches N] [--max-inputs N] [--target-utxos N] [--batch-index N] [--live]
  node scripts/consolidation-worker.js --confirm
  node scripts/consolidation-worker.js --cycle [--max-batches N] [--max-inputs N] [--target-utxos N] [--batch-index N] [--live]

Live broadcast requires both:
  --live
  HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM=${LIVE_CONFIRM_VALUE}
`);
}

function parseArgs(argv) {
  const args = {
    health: false,
    plan: false,
    process: false,
    confirm: false,
    cycle: false,
    live: false,
    maxBatches: null,
    maxInputs: null,
    targetUtxos: null,
    batchIndex: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--health') args.health = true;
    else if (arg === '--plan') args.plan = true;
    else if (arg === '--process') args.process = true;
    else if (arg === '--confirm') args.confirm = true;
    else if (arg === '--cycle') args.cycle = true;
    else if (arg === '--live') args.live = true;
    else if (arg === '--max-batches') args.maxBatches = Number(argv[++i]);
    else if (arg === '--max-inputs') args.maxInputs = Number(argv[++i]);
    else if (arg === '--target-utxos') args.targetUtxos = Number(argv[++i]);
    else if (arg === '--batch-index') args.batchIndex = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const actionCount = [args.health, args.plan, args.process, args.confirm, args.cycle].filter(Boolean).length;
  if (actionCount !== 1) {
    throw new Error('Choose exactly one action: --health, --plan, --process, --confirm, or --cycle');
  }
  if (args.maxBatches !== null && (!Number.isInteger(args.maxBatches) || args.maxBatches <= 0)) {
    throw new Error('--max-batches must be a positive integer');
  }
  if (args.maxInputs !== null && (!Number.isInteger(args.maxInputs) || args.maxInputs <= 0)) {
    throw new Error('--max-inputs must be a positive integer');
  }
  if (args.targetUtxos !== null && (!Number.isInteger(args.targetUtxos) || args.targetUtxos <= 0)) {
    throw new Error('--target-utxos must be a positive integer');
  }
  if (args.batchIndex !== null && (!Number.isInteger(args.batchIndex) || args.batchIndex < 0)) {
    throw new Error('--batch-index must be a non-negative integer');
  }
  return args;
}

function applyTargetUtxoReserve(config, args) {
  if (args.targetUtxos === null) return config;

  return {
    ...config,
    consolidation: {
      ...config.consolidation,
      reservePolicy: {
        ...(config.consolidation?.reservePolicy || {}),
        minUtxosToKeep: args.targetUtxos,
      },
    },
  };
}

function enableLiveConsolidationConfig(config, args) {
  if (!args.live) return config;

  if (process.env.HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM !== LIVE_CONFIRM_VALUE) {
    throw new Error('Refusing live consolidation broadcast: missing or incorrect HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM value');
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

async function main() {
  const args = parseArgs(process.argv);
  const config = applyTargetUtxoReserve(enableLiveConsolidationConfig(loadConfig(), args), args);
  const rawDb = db.getConnection();
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  await new MigrationRunner(rawDb, migrationsDir).applyMigrations();

  const rpc = createRpcClient(config);
  const consolidationLedger = new ConsolidationLedger(rawDb);
  const payoutLedger = new PayoutLedger(rawDb);

  const executor = new ConsolidationExecutor({
    db: rawDb,
    rpc,
    config,
    consolidationLedger,
    payoutLedger,
    walletLabel: config.pool?.walletLabel || '',
  });

  if (args.health) {
    const report = await executor.runHealth();
    console.log(JSON.stringify({
      action: 'health',
      report: {
        generatedAt: report.generatedAt,
        summary: report.summary,
        warnings: report.warnings,
        recommendedActions: report.recommendedActions,
      },
    }, null, 2));
    return;
  }

  if (args.plan) {
    const plan = await executor.createPlan({
      maxBatches: args.maxBatches,
      maxInputs: args.maxInputs,
    });
    console.log(JSON.stringify({
      action: 'plan',
      planId: plan.planId,
      generatedAt: plan.generatedAt,
      configSnapshot: plan.configSnapshot,
      totalCandidates: plan.totalCandidates,
      reserved: plan.reserved,
      reservedSats: plan.reservedSats,
      totalBatches: plan.batches.length,
      totalInputs: plan.totalInputs,
      totalInputSats: plan.totalInputSats,
      totalFeeSats: plan.totalFeeSats,
      warnings: plan.warnings,
      operatorChecklist: plan.operatorChecklist,
      batches: plan.batches.map((b) => ({
        batchIndex: b.batchIndex,
        inputCount: b.selectedInputs.length,
        totalInputSats: b.totalInputSats,
        estimatedFeeSats: b.estimatedFeeSats,
        estimatedTxSizeBytes: b.estimatedTxSizeBytes,
        destinationAddress: b.destinationAddress,
      })),
    }, null, 2));
    return;
  }

  if (args.process) {
    const plan = await executor.createPlan({
      maxBatches: args.maxBatches,
      maxInputs: args.maxInputs,
    });

    if (!plan.batches || plan.batches.length === 0) {
      console.log(JSON.stringify({ action: 'process', processed: false, reason: 'no_batches_in_plan' }, null, 2));
      return;
    }

    let planId = null;
    const ledgerPlan = await executor.createLedgerPlan(plan);
    planId = ledgerPlan.plan_id;

    const result = await executor.processPlan(plan, {
      live: args.live,
      planId,
      maxBatches: args.maxBatches,
      maxInputs: args.maxInputs,
      batchIndex: args.batchIndex,
    });
    const status = executor.getAutomationStatus();
    console.log(JSON.stringify({
      action: 'process',
      liveRequested: args.live,
      mode: status.mode,
      planId,
      result,
    }, null, 2));
    return;
  }

  if (args.confirm) {
    const result = await executor.confirmBroadcastedBatches();
    console.log(JSON.stringify({
      action: 'confirm',
      result,
    }, null, 2));
    return;
  }

  if (args.cycle) {
    const result = await executor.executeCycle({
      live: args.live,
      maxBatches: args.maxBatches,
      maxInputs: args.maxInputs,
      batchIndex: args.batchIndex,
    });
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(`[consolidation-worker] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    db.getConnection().close(() => {});
  });
