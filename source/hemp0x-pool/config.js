const fs = require('fs');
const path = require('path');
const { validateConfig } = require('./configSchema');
const { isValidAddress, isP2PKHAddress } = require('./address');

function envInt(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

const DEFAULTS = Object.freeze({
  payout: Object.freeze({
    dryRun: true,
    staleLockTimeoutMs: 3600000,
    blockConfirmations: 100,
    maxPayoutBatch: 50,
    maxPayoutBatchAmountSats: 50000000000,
    maxPayoutPerAddressSats: 50000000000,
    flushIntervalMs: 43200000,
    flushMinPayoutSats: 10000000,
    batchBroadcastMaxRetries: 3,
    batchBroadcastBackoffMs: [300000, 900000, 3600000],
    payoutRunTimeoutMs: 1800000,
    sharePaidAfterConfirmed: true,
    rpcDelayMs: envInt('HEMP0X_PAYOUT_RPC_DELAY_MS', 500),
    rpcTransientRetries: envInt('HEMP0X_PAYOUT_RPC_TRANSIENT_RETRIES', 2),
    rpcTransientBackoffMs: envInt('HEMP0X_PAYOUT_RPC_TRANSIENT_BACKOFF_MS', 2000),
  }),
  consolidation: Object.freeze({
    enabled: false,
    dryRunOnly: true,
    minConfirmations: 100,
    maxInputsPerBatch: 200,
    maxTxSizeBytes: 80000,
    feeRateSatsPerByte: 10,
    useSmartFeeEstimate: true,
    smartFeeConfirmTarget: 6,
    destinationAddress: '',
    reservePolicy: Object.freeze({
      minUtxosToKeep: 500,
      maxUtxoSizeToKeepSats: 2000000000,
      minTotalReserveSats: 200000000000,
    }),
    autoRunIntervalMs: 0,
    operatorApprovalRequired: true,
    broadcastMaxRetries: 3,
    broadcastBackoffMs: [300000, 900000, 3600000],
  }),
  health: Object.freeze({
    utxoReportIntervalMs: 86400000,
    maturityConfirmations: 100,
    warnUtxoCountAbove: 10000,
    warnUtxoCountBelow: 100,
    warnBalanceBelowSats: 100000000000,
    warnDustUtxoCountAbove: 500,
    dbIntegrityCheckIntervalMs: 86400000,
  }),
  vardiff: Object.freeze({
    minDiff: 0.2,
    maxDiff: 1024,
    targetTime: 15,
    retargetTime: 30,
    variance: 0.4,
  }),
  automation: Object.freeze({
    readOnlyChecksEnabled: true,
    dryRunPlanningEnabled: true,
    routinePayoutEnabled: false,
    payoutBroadcastEnabled: false,
    consolidationBroadcastEnabled: false,
    staleLockRecoveryEnabled: true,
    staleLockTimeoutMs: 3600000,
    maxConsecutiveFailures: 5,
    alertOnState: ['failed', 'stale_lock', 'balance_low', 'db_integrity_fail'],
    logLevel: 'info',
  }),
});

/**
 * Load and validate pool configuration.
 * @param {string} [explicitPath] - Optional absolute path to a config JSON file.
 * @returns {object} Frozen configuration object with safe defaults merged.
 */
function loadConfig(explicitPath) {
  const configPath = explicitPath ||
    process.env.HEMP0X_POOL_CONFIG ||
    process.env.CONFIG_PATH ||
    path.join(__dirname, 'config.json');

  let raw = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse config at ${configPath}: ${e.message}`);
    }
  }

  // Preserve existing top-level sections and merge new ones with safe defaults.
  const merged = {};
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] === 'object' && raw[key] !== null) {
      merged[key] = { ...raw[key] };
    } else {
      merged[key] = raw[key];
    }
  }

  // Merge known new sections with defaults.
  for (const section of Object.keys(DEFAULTS)) {
    if (!merged[section]) {
      merged[section] = {};
    }
    const base = { ...DEFAULTS[section] };
    const provided = merged[section];
    if (
      section === 'consolidation' &&
      provided.feeRateSatsPerByte === undefined &&
      provided.feeRateSatsPerKb !== undefined
    ) {
      provided.feeRateSatsPerByte = Math.ceil(provided.feeRateSatsPerKb / 1000);
    }
    for (const key of Object.keys(provided)) {
      if (key === 'reservePolicy' && typeof provided[key] === 'object' && provided[key] !== null) {
        base[key] = { ...base[key], ...provided[key] };
      } else {
        base[key] = provided[key];
      }
    }
    merged[section] = base;
  }

  // Safety gates keep the example configuration non-broadcasting.
  if (merged.payout?.dryRun !== true) {
    throw new Error('Safety gate violated: payout.dryRun must be true');
  }
  if (merged.consolidation?.enabled !== false) {
    throw new Error('Safety gate violated: consolidation.enabled must be false');
  }
  if (merged.consolidation?.dryRunOnly !== true) {
    throw new Error('Safety gate violated: consolidation.dryRunOnly must be true');
  }
  if (merged.automation?.consolidationBroadcastEnabled !== false) {
    throw new Error('Safety gate violated: automation.consolidationBroadcastEnabled must be false');
  }
  if (merged.automation?.routinePayoutEnabled !== false) {
    throw new Error('Safety gate violated: automation.routinePayoutEnabled must be false');
  }

  // Light range validation for a few key integer fields.
  const payout = merged.payout;
  if (payout.staleLockTimeoutMs < 60000) {
    throw new Error('payout.staleLockTimeoutMs must be >= 60000');
  }
  if (payout.maxPayoutBatch < 1 || payout.maxPayoutBatch > 200) {
    throw new Error('payout.maxPayoutBatch must be between 1 and 200');
  }
  if (payout.maxPayoutBatchAmountSats <= 0) {
    throw new Error('payout.maxPayoutBatchAmountSats must be > 0');
  }
  if (payout.flushMinPayoutSats <= 0) {
    throw new Error('payout.flushMinPayoutSats must be > 0');
  }

  const consolidation = merged.consolidation;
  if (consolidation.minConfirmations < 100) {
    throw new Error('consolidation.minConfirmations must be >= 100');
  }
  if (consolidation.maxInputsPerBatch < 10 || consolidation.maxInputsPerBatch > 600) {
    throw new Error('consolidation.maxInputsPerBatch must be between 10 and 600');
  }
  if (consolidation.maxTxSizeBytes < 1000 || consolidation.maxTxSizeBytes > 100000) {
    throw new Error('consolidation.maxTxSizeBytes must be between 1000 and 100000');
  }
  if (consolidation.feeRateSatsPerByte <= 0) {
    throw new Error('consolidation.feeRateSatsPerByte must be > 0');
  }

  // Schema-based validation
  const schemaResult = validateConfig(merged);
  if (!schemaResult.valid) {
    const messages = schemaResult.errors.map((e) => e.message).join('; ');
    throw new Error(`Config validation failed: ${messages}`);
  }

  const vardiff = merged.vardiff;
  if (vardiff.maxDiff < vardiff.minDiff) {
    throw new Error('vardiff.maxDiff must be >= vardiff.minDiff');
  }

  // Address validation for public-facing addresses
  if (merged.pool?.wallet && !isValidAddress(merged.pool.wallet)) {
    throw new Error(`pool.wallet is not a valid Hemp0x address: ${merged.pool.wallet}`);
  }

  if (merged.consolidation?.destinationAddress) {
    if (!isP2PKHAddress(merged.consolidation.destinationAddress)) {
      throw new Error(`consolidation.destinationAddress is not a valid P2PKH address: ${merged.consolidation.destinationAddress}`);
    }
  }

  if (merged.frontend?.donationAddress && !isValidAddress(merged.frontend.donationAddress)) {
    throw new Error(`frontend.donationAddress is not a valid Hemp0x address: ${merged.frontend.donationAddress}`);
  }

  // Deep-freeze the result so callers cannot mutate it accidentally.
  return Object.freeze(deepFreeze(merged));
}

function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

const SAFETY_GATES = Object.freeze({
  payoutDryRun: 'payout.dryRun',
  consolidationEnabled: 'consolidation.enabled',
  consolidationDryRunOnly: 'consolidation.dryRunOnly',
  consolidationBroadcastEnabled: 'automation.consolidationBroadcastEnabled',
  routinePayoutEnabled: 'automation.routinePayoutEnabled',
  payoutBroadcastEnabled: 'automation.payoutBroadcastEnabled',
});

/**
 * Return the current safety gate status for a loaded config.
 * @param {object} config - A config object loaded by loadConfig().
 * @returns {object} { gates: Array<{name, path, currentValue, safeValue, safe}>, allSafe: boolean }
 */
function getSafetyGateStatus(config) {
  const gates = [
    {
      name: 'payoutDryRun',
      path: 'payout.dryRun',
      currentValue: config.payout?.dryRun,
      safeValue: true,
      safe: config.payout?.dryRun === true,
    },
    {
      name: 'consolidationEnabled',
      path: 'consolidation.enabled',
      currentValue: config.consolidation?.enabled,
      safeValue: false,
      safe: config.consolidation?.enabled === false,
    },
    {
      name: 'consolidationDryRunOnly',
      path: 'consolidation.dryRunOnly',
      currentValue: config.consolidation?.dryRunOnly,
      safeValue: true,
      safe: config.consolidation?.dryRunOnly === true,
    },
    {
      name: 'consolidationBroadcastEnabled',
      path: 'automation.consolidationBroadcastEnabled',
      currentValue: config.automation?.consolidationBroadcastEnabled,
      safeValue: false,
      safe: config.automation?.consolidationBroadcastEnabled === false,
    },
    {
      name: 'routinePayoutEnabled',
      path: 'automation.routinePayoutEnabled',
      currentValue: config.automation?.routinePayoutEnabled,
      safeValue: false,
      safe: config.automation?.routinePayoutEnabled === false,
    },
    {
      name: 'payoutBroadcastEnabled',
      path: 'automation.payoutBroadcastEnabled',
      currentValue: config.automation?.payoutBroadcastEnabled,
      safeValue: false,
      safe: config.automation?.payoutBroadcastEnabled === false,
    },
  ];

  return {
    gates,
    allSafe: gates.every((g) => g.safe),
  };
}

module.exports = { loadConfig, DEFAULTS, getSafetyGateStatus, SAFETY_GATES };
