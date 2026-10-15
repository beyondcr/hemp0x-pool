/**
 * Operator configuration schema and metadata.
 *
 * Every config key is tagged with:
 *   - category: "public" | "tunable" | "dangerous" | "secret"
 *   - description: human-readable label for admin UIs
 *   - type: expected primitive type
 *   - validation: optional validation function or constraint object
 *
 * This module is read-only; it does not mutate any config. The config loader
 * in config.js imports the validation functions to enforce correctness.
 */

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const VALID_ALERT_STATES = ['failed', 'stale_lock', 'balance_low', 'db_integrity_fail'];
const VALID_REWARD_MODELS = ['finder-plus-equal', 'finder-plus-share-weighted', 'pplns'];

const schema = {
  pool: {
    name: {
      category: 'public',
      description: 'Pool display name',
      type: 'string',
    },
    stratumPort: {
      category: 'tunable',
      description: 'Stratum TCP port for miner connections',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1024 && v <= 65535,
      message: 'stratumPort must be an integer between 1024 and 65535',
    },
    webPort: {
      category: 'tunable',
      description: 'Web UI HTTP port',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1024 && v <= 65535,
      message: 'webPort must be an integer between 1024 and 65535',
    },
    maxStratumConnections: {
      category: 'tunable',
      description: 'Maximum simultaneous Stratum TCP connections',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1 && v <= 10000,
      message: 'maxStratumConnections must be an integer between 1 and 10000',
    },
    maxStratumLineBytes: {
      category: 'tunable',
      description: 'Maximum UTF-8 bytes accepted for one Stratum request line',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1024 && v <= 1048576,
      message: 'maxStratumLineBytes must be an integer between 1024 and 1048576',
    },
    maxPendingShareValidations: {
      category: 'tunable',
      description: 'Maximum concurrent share validations allowed per connection',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1 && v <= 128,
      message: 'maxPendingShareValidations must be an integer between 1 and 128',
    },
    maxConcurrentShareValidations: {
      category: 'tunable',
      description: 'Maximum concurrent KawPoW share RPC validations across the pool',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1 && v <= 4096,
      message: 'maxConcurrentShareValidations must be an integer between 1 and 4096',
    },
    maxWorkers: {
      category: 'tunable',
      description: 'Maximum retained worker identities',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 100 && v <= 1000000,
      message: 'maxWorkers must be an integer between 100 and 1000000',
    },
    workerRetentionMs: {
      category: 'tunable',
      description: 'How long disconnected workers remain in memory',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 60000 && v <= 604800000,
      message: 'workerRetentionMs must be an integer between 60000 and 604800000',
    },
    templateRefreshIntervalMs: {
      category: 'tunable',
      description: 'getblocktemplate polling interval in milliseconds',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 250 && v <= 60000,
      message: 'templateRefreshIntervalMs must be an integer between 250 and 60000',
    },
    submitBlockRpcTimeoutMs: {
      category: 'tunable',
      description: 'RPC timeout for submitblock calls in milliseconds',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1000 && v <= 60000,
      message: 'submitBlockRpcTimeoutMs must be an integer between 1000 and 60000',
    },
    submitBlockRetries: {
      category: 'tunable',
      description: 'Number of retry attempts after submitblock RPC failures',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
      message: 'submitBlockRetries must be an integer between 0 and 5',
    },
    submitBlockRetryDelayMs: {
      category: 'tunable',
      description: 'Delay between submitblock retry attempts in milliseconds',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 0 && v <= 30000,
      message: 'submitBlockRetryDelayMs must be an integer between 0 and 30000',
    },
    wallet: {
      category: 'public',
      description: 'Pool wallet address for pool-mode blocks',
      type: 'string',
    },
    walletLabel: {
      category: 'tunable',
      description: 'Wallet label/account used for payouts (daemon wallet)',
      type: 'string',
    },
    hashrateScalar: {
      category: 'public',
      description: 'UI scaling factor for hashrate display',
      type: 'number',
    },
    fee: {
      category: 'tunable',
      description: 'Pool fee as a decimal (0.0 = 0%, 1.0 = 100%)',
      type: 'number',
      validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
      message: 'fee must be between 0 and 1',
    },
    soloFee: {
      category: 'tunable',
      description: 'Fee for solo mining mode',
      type: 'number',
      validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
      message: 'soloFee must be between 0 and 1',
    },
    minPayout: {
      category: 'tunable',
      description: 'Minimum payout threshold for standard runs',
      type: 'number',
      validate: (v) => v > 0,
      message: 'minPayout must be > 0',
    },
    payoutInterval: {
      category: 'tunable',
      description: 'Payout frequency in milliseconds',
      type: 'number',
    },
    flushIntervalMs: {
      category: 'tunable',
      description: 'Periodic flush interval (ms) for small balances',
      type: 'number',
    },
    flushMinPayout: {
      category: 'tunable',
      description: 'Minimum payout during flush runs',
      type: 'number',
    },
    blockConfirmations: {
      category: 'tunable',
      description: 'Confirmation depth before a block is credited',
      type: 'number',
    },
    rewardModel: {
      category: 'public',
      description: 'Payout reward distribution model',
      type: 'string',
      validate: (v) => VALID_REWARD_MODELS.includes(v),
      message: `rewardModel must be one of: ${VALID_REWARD_MODELS.join(', ')}`,
    },
    finderBonusPercent: {
      category: 'tunable',
      description: 'Finder reward percentage for pool-mode blocks',
      type: 'number',
      validate: (v) => typeof v === 'number' && v >= 0 && v <= 100,
      message: 'finderBonusPercent must be between 0 and 100',
    },
    activeWindowMinutes: {
      category: 'tunable',
      description: 'Recent activity window for shared rewards (minutes)',
      type: 'number',
    },
    minActiveMinutes: {
      category: 'tunable',
      description: 'Minimum active time required for shared rewards (minutes)',
      type: 'number',
    },
    pplnsWindowDifficulty: {
      category: 'tunable',
      description: 'PPLNS window difficulty units (beta/testing only)',
      type: 'number',
      validate: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      message: 'pplnsWindowDifficulty must be a finite number greater than 0',
    },
  },

  daemon: {
    host: {
      category: 'tunable',
      description: 'RPC daemon hostname or IP',
      type: 'string',
    },
    port: {
      category: 'tunable',
      description: 'RPC daemon port',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
      message: 'daemon.port must be an integer between 1 and 65535',
    },
    user: {
      category: 'secret',
      description: 'RPC username',
      type: 'string',
    },
    pass: {
      category: 'secret',
      description: 'RPC password',
      type: 'string',
    },
    cliPath: {
      category: 'tunable',
      description: 'Path to hemp0x-cli binary',
      type: 'string',
    },
    confPath: {
      category: 'tunable',
      description: 'Path to hemp.conf',
      type: 'string',
    },
    cookiePath: {
      category: 'secret',
      description: 'Path to daemon .cookie file for cookie-based authentication',
      type: 'string',
    },
    useCookieAuth: {
      category: 'tunable',
      description: 'When true, use cookie-based auth instead of user/pass',
      type: 'boolean',
    },
  },

  vardiff: {
    minDiff: {
      category: 'tunable',
      description: 'Minimum difficulty target',
      type: 'number',
      validate: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      message: 'vardiff.minDiff must be > 0',
    },
    maxDiff: {
      category: 'tunable',
      description: 'Maximum difficulty target',
      type: 'number',
      validate: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      message: 'vardiff.maxDiff must be > 0',
    },
    targetTime: {
      category: 'tunable',
      description: 'Ideal share time in seconds',
      type: 'number',
      validate: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      message: 'vardiff.targetTime must be > 0',
    },
    retargetTime: {
      category: 'tunable',
      description: 'Vardiff retarget interval in seconds',
      type: 'number',
      validate: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      message: 'vardiff.retargetTime must be > 0',
    },
    variance: {
      category: 'tunable',
      description: 'Allowed variance on share timing',
      type: 'number',
      validate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1,
      message: 'vardiff.variance must be >= 0 and < 1',
    },
  },

  frontend: {
    poolName: {
      category: 'public',
      description: 'Pool name displayed in the web UI',
      type: 'string',
    },
    poolDescription: {
      category: 'public',
      description: 'Pool description / subtitle',
      type: 'string',
    },
    discord: {
      category: 'public',
      description: 'Discord community URL',
      type: 'string',
    },
    twitter: {
      category: 'public',
      description: 'X/Twitter handle',
      type: 'string',
    },
    historyHours: {
      category: 'tunable',
      description: 'Miner history window in hours',
      type: 'number',
    },
    donationAddress: {
      category: 'public',
      description: 'Donation address shown on the connect page',
      type: 'string',
    },
  },

  maintenance: {
    retentionDays: {
      category: 'tunable',
      description: 'Days to keep paid shares before pruning',
      type: 'number',
    },
  },

  payout: {
    dryRun: {
      category: 'dangerous',
      description: 'When true, payouts simulate but do not broadcast',
      type: 'boolean',
    },
    staleLockTimeoutMs: {
      category: 'tunable',
      description: 'Duration after which a stale lock is recoverable (ms)',
      type: 'number',
    },
    blockConfirmations: {
      category: 'tunable',
      description: 'Minimum confirmations before payout batch eligibility',
      type: 'number',
    },
    maxPayoutBatch: {
      category: 'tunable',
      description: 'Max payouts per batch (1-200)',
      type: 'number',
    },
    maxPayoutBatchAmountSats: {
      category: 'tunable',
      description: 'Max total sats per payout batch',
      type: 'number',
    },
    maxPayoutPerAddressSats: {
      category: 'tunable',
      description: 'Max sats paid to one address per batch',
      type: 'number',
    },
    flushIntervalMs: {
      category: 'tunable',
      description: 'Interval for periodic flush runs (ms)',
      type: 'number',
    },
    flushMinPayoutSats: {
      category: 'tunable',
      description: 'Minimum sats threshold for flush-run payouts',
      type: 'number',
    },
    batchBroadcastMaxRetries: {
      category: 'tunable',
      description: 'Max retries for a failed batch broadcast',
      type: 'number',
    },
    batchBroadcastBackoffMs: {
      category: 'tunable',
      description: 'Retry backoff intervals (array of ms values)',
      type: 'array',
    },
    payoutRunTimeoutMs: {
      category: 'tunable',
      description: 'Max duration for a single payout run (ms)',
      type: 'number',
    },
    sharePaidAfterConfirmed: {
      category: 'tunable',
      description: 'When true, mark shares paid only after payout confirms',
      type: 'boolean',
    },
    rpcDelayMs: {
      category: 'tunable',
      description: 'Minimum delay between payout-worker daemon RPC calls (ms)',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 0,
      message: 'rpcDelayMs must be a non-negative integer',
    },
    rpcTransientRetries: {
      category: 'tunable',
      description: 'Retry count for transient read-only payout RPC failures',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 0,
      message: 'rpcTransientRetries must be a non-negative integer',
    },
    rpcTransientBackoffMs: {
      category: 'tunable',
      description: 'Base backoff for transient payout RPC retries (ms)',
      type: 'number',
      validate: (v) => Number.isInteger(v) && v >= 0,
      message: 'rpcTransientBackoffMs must be a non-negative integer',
    },
  },

  consolidation: {
    enabled: {
      category: 'dangerous',
      description: 'Master switch for consolidation (must be false in the example config)',
      type: 'boolean',
    },
    dryRunOnly: {
      category: 'dangerous',
      description: 'When true, produce plans without signing (required by the example config)',
      type: 'boolean',
    },
    minConfirmations: {
      category: 'tunable',
      description: 'Minimum confirmations for a consolidation candidate (min 100)',
      type: 'number',
    },
    maxInputsPerBatch: {
      category: 'tunable',
      description: 'Max inputs per consolidation tx (10-600)',
      type: 'number',
    },
    maxTxSizeBytes: {
      category: 'tunable',
      description: 'Max tx size in bytes (1000-100000)',
      type: 'number',
    },
    feeRateSatsPerByte: {
      category: 'tunable',
      description: 'Fallback fee rate in sats/byte',
      type: 'number',
    },
    useSmartFeeEstimate: {
      category: 'tunable',
      description: 'Use estimatesmartfee RPC for dynamic fees',
      type: 'boolean',
    },
    smartFeeConfirmTarget: {
      category: 'tunable',
      description: 'Confirmation target for smart fee estimation',
      type: 'number',
    },
    destinationAddress: {
      category: 'tunable',
      description: 'Destination address for consolidated funds',
      type: 'string',
    },
    autoRunIntervalMs: {
      category: 'tunable',
      description: 'Interval for auto consolidation runs (0 = disabled)',
      type: 'number',
    },
    operatorApprovalRequired: {
      category: 'tunable',
      description: 'Require explicit operator approval before broadcast',
      type: 'boolean',
    },
    broadcastMaxRetries: {
      category: 'tunable',
      description: 'Max retries for a failed consolidation broadcast',
      type: 'number',
    },
    broadcastBackoffMs: {
      category: 'tunable',
      description: 'Retry backoff intervals (array of ms values)',
      type: 'array',
    },
  },

  health: {
    utxoReportIntervalMs: {
      category: 'tunable',
      description: 'Interval between UTXO health reports (ms)',
      type: 'number',
    },
    maturityConfirmations: {
      category: 'tunable',
      description: 'Confirmations for UTXO maturity',
      type: 'number',
    },
    warnUtxoCountAbove: {
      category: 'tunable',
      description: 'Warning threshold: total UTXOs too high',
      type: 'number',
    },
    warnUtxoCountBelow: {
      category: 'tunable',
      description: 'Warning threshold: total UTXOs too low',
      type: 'number',
    },
    warnBalanceBelowSats: {
      category: 'tunable',
      description: 'Warning threshold: mature balance too low',
      type: 'number',
    },
    warnDustUtxoCountAbove: {
      category: 'tunable',
      description: 'Warning threshold: dust UTXOs too high',
      type: 'number',
    },
    dbIntegrityCheckIntervalMs: {
      category: 'tunable',
      description: 'Interval between DB integrity checks (ms)',
      type: 'number',
    },
  },

  automation: {
    readOnlyChecksEnabled: {
      category: 'tunable',
      description: 'Allow read-only health checks to run automatically',
      type: 'boolean',
    },
    dryRunPlanningEnabled: {
      category: 'tunable',
      description: 'Allow dry-run consolidation planning to run automatically',
      type: 'boolean',
    },
    routinePayoutEnabled: {
      category: 'dangerous',
      description: 'Enable routine automated payout broadcasts (disabled in the example config)',
      type: 'boolean',
    },
    payoutBroadcastEnabled: {
      category: 'dangerous',
      description: 'Enable actual broadcast of payout transactions (disabled in the example config)',
      type: 'boolean',
    },
    consolidationBroadcastEnabled: {
      category: 'dangerous',
      description: 'Enable consolidation tx broadcasts (disabled in the example config)',
      type: 'boolean',
    },
    staleLockRecoveryEnabled: {
      category: 'tunable',
      description: 'Auto-recover stale payout locks',
      type: 'boolean',
    },
    staleLockTimeoutMs: {
      category: 'tunable',
      description: 'Duration before a lock is considered stale',
      type: 'number',
    },
    maxConsecutiveFailures: {
      category: 'tunable',
      description: 'Max consecutive failures before alerting',
      type: 'number',
    },
    alertOnState: {
      category: 'tunable',
      description: 'Event states that trigger alerts',
      type: 'array',
    },
    logLevel: {
      category: 'tunable',
      description: 'Logging verbosity',
      type: 'string',
      validate: (v) => VALID_LOG_LEVELS.includes(v),
      message: `logLevel must be one of: ${VALID_LOG_LEVELS.join(', ')}`,
    },
  },
};

/**
 * Return schema entries for a given category.
 * @param {string} category - "public" | "tunable" | "dangerous" | "secret"
 * @returns {Array<{path: string, schema: object}>}
 */
function getFieldsByCategory(category) {
  const result = [];
  for (const section of Object.keys(schema)) {
    for (const key of Object.keys(schema[section])) {
      const entry = schema[section][key];
      if (entry.category === category) {
        result.push({ path: `${section}.${key}`, schema: entry });
      }
    }
  }
  return result;
}

/**
 * Return all secret keys (paths that must be redacted in logs/API/docs).
 * @returns {string[]}
 */
function getSecretKeys() {
  return getFieldsByCategory('secret').map((f) => f.path);
}

/**
 * Return all dangerous keys.
 * @returns {string[]}
 */
function getDangerousKeys() {
  return getFieldsByCategory('dangerous').map((f) => f.path);
}

/**
 * Validate a single config value against its schema entry.
 * Returns { valid: boolean, message?: string }.
 */
function validateField(section, key, value) {
  const sectionSchema = schema[section];
  if (!sectionSchema) return { valid: true };
  const fieldSchema = sectionSchema[key];
  if (!fieldSchema) return { valid: true };
  if (value === undefined) return { valid: true };
  if (fieldSchema.validate) {
    const ok = fieldSchema.validate(value);
    if (!ok) return { valid: false, message: fieldSchema.message || `${section}.${key} validation failed` };
  }
  return { valid: true };
}

/**
 * Validate an entire merged config object against the schema.
 * Returns { valid: boolean, errors: Array<{path: string, message: string}> }.
 */
function validateConfig(mergedConfig) {
  const errors = [];
  for (const section of Object.keys(schema)) {
    const sectionData = mergedConfig[section] || {};
    for (const key of Object.keys(schema[section])) {
      const value = sectionData[key];
      if (value !== undefined) {
        const result = validateField(section, key, value);
        if (!result.valid) {
          errors.push({ path: `${section}.${key}`, message: result.message });
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  schema,
  getFieldsByCategory,
  getSecretKeys,
  getDangerousKeys,
  validateField,
  validateConfig,
  VALID_LOG_LEVELS,
  VALID_ALERT_STATES,
  VALID_REWARD_MODELS,
};
