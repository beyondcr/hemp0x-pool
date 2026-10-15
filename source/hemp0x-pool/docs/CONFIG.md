# Config Reference

`config.json` controls pool behavior, payout scheduling, and frontend settings. This file is required for both the stratum and payout services.

## Operator Config Categories

Every setting is tagged with one of four visibility/risk categories in the schema module (`configSchema.js`):

| Category     | Description | Example keys |
|-------------|-------------|-------------|
| **public**   | Settings safe to display in APIs and public UIs. No secrets. | `pool.name`, `pool.wallet`, `frontend.poolName`, `frontend.donationAddress` |
| **tunable**  | Operator-adjustable runtime settings. Safe to change without code review in most cases. | `payout.maxPayoutBatch`, `consolidation.minConfirmations`, `automation.logLevel` |
| **dangerous** | Settings that control real payout/consolidation behavior. Keep disabled until wallet, RPC, and process isolation are reviewed. | `payout.dryRun`, `consolidation.enabled`, `consolidation.dryRunOnly`, `automation.routinePayoutEnabled`, `automation.consolidationBroadcastEnabled` |
| **secret**   | Credentials that must **never** be returned by APIs, logged, or written to docs. Redacted by `configRedaction.js` before any public exposure. | `daemon.user`, `daemon.pass` |

### Dangerous Settings

The example config keeps these in dry-run positions. Live operation requires intentionally setting the corresponding gates, or using the reviewed CLI `--live` path that applies the same gates after checking the confirmation environment variable:

- Payout live mode: `payout.dryRun: false`, `automation.routinePayoutEnabled: true`, `automation.payoutBroadcastEnabled: true`
- Consolidation live mode: `consolidation.enabled: true`, `consolidation.dryRunOnly: false`, `automation.consolidationBroadcastEnabled: true`

### Which Settings Are Safe to Change Locally

Tunable settings can be adjusted in `config.json` without touching source code:

- Payout batch sizes: `payout.maxPayoutBatch`, `payout.maxPayoutBatchAmountSats`, `payout.maxPayoutPerAddressSats`
- Consolidation parameters: `consolidation.minConfirmations`, `consolidation.maxInputsPerBatch`, `consolidation.maxTxSizeBytes`
- Health thresholds: `health.warnUtxoCountAbove`, `health.warnUtxoCountBelow`, `health.warnBalanceBelowSats`
- Log level: `automation.logLevel` (valid: `debug`, `info`, `warn`, `error`)
- Pool fee: `pool.fee` (0.0 - 1.0), `pool.finderBonusPercent` (0-100)
- Ports: `pool.stratumPort`, `pool.webPort` (1024-65535), `daemon.port` (1-65535)

### Secrets Handling

- `daemon.user` and `daemon.pass` are tagged as `secret` in the schema.
- The `configRedaction.js` module provides `redactSecrets()` which deep-clones config objects and replaces secret values with `***REDACTED***`.
- Any API endpoint or log message that emits config data must pass through `redactSecrets()` first.
- Error messages returned to public clients are sanitized by `sanitizeError()` to strip RPC credentials, file paths, and stack traces.
- Secret-like keys at any nesting depth (matching `pass`, `password`, `token`, `secret`, `key`, `auth`, `credential`) are automatically redacted.

## pool

- `name` (string): Display name for logs and UI.
- `stratumPort` (number): Stratum TCP port.
- `webPort` (number): Web UI port.
- `maxStratumConnections` (number): Maximum simultaneous Stratum connections (default: 256).
- `maxStratumLineBytes` (number): Maximum request-line size in UTF-8 bytes (default: 65536).
- `maxPendingShareValidations` (number): Maximum in-flight share validations per connection (default: 8).
- `maxConcurrentShareValidations` (number): Maximum in-flight share validation RPCs across the pool (default: 256).
- `maxWorkers` (number): Maximum retained worker identities (default: 10000).
- `workerRetentionMs` (number): Retention period for disconnected workers (default: 1800000 / 30 minutes).
- `templateRefreshIntervalMs` (number, optional): `getblocktemplate` polling interval in milliseconds. Defaults to `1000`; shorter intervals reduce stale work on fast block times while curtime-only template changes remain suppressed.
- `submitBlockRpcTimeoutMs` (number, optional): RPC timeout for `submitblock` calls. Defaults to `15000`.
- `submitBlockRetries` (number, optional): Retry attempts after transient `submitblock` RPC failures. Defaults to `2`.
- `submitBlockRetryDelayMs` (number, optional): Delay between `submitblock` retry attempts. Defaults to `1000`.
- `wallet` (string): Pool wallet address used for pool-mode blocks.
- `walletLabel` (string): Wallet label/account used for payouts (daemon wallet).
- `hashrateScalar` (number): UI scaling factor for hashrate display.
- `fee` (number): Pool fee as a decimal (0.0 = 0%).
- `soloFee` (number, optional): Fee for solo mining; defaults to `fee`.
- `minPayout` (number): Minimum payout threshold for standard runs.
- `payoutInterval` (number): Payout frequency in milliseconds.
- `flushIntervalMs` (number): Periodic flush interval (ms) for small balances.
- `flushMinPayout` (number): Minimum payout during flush runs.
- `blockConfirmations` (number): Confirmation depth before a block is credited.
- `rewardModel` (string): Payout model. Valid values: `finder-plus-equal` (default, equal split), `finder-plus-share-weighted` (proportional by share difficulty), `pplns` (rolling-window share-difficulty snapshots, **beta/testing only, not recommended for production use**).
- `finderBonusPercent` (number): Finder reward percentage for pool-mode blocks.
- `pplnsWindowDifficulty` (number, optional): Total difficulty units for the PPLNS rolling window (default: 2000). **Only used when `rewardModel = "pplns"`. This feature is beta/testing: it snapshots miner share aggregates at block-found time and does not mutate individual shares, allowing shares to count in multiple block windows. Do not enable in production without explicit testing.**
- `activeWindowMinutes` (number): Recent activity window for shared rewards.
- `minActiveMinutes` (number): Minimum active time required for shared rewards.

## daemon

- `host` (string): RPC host.
- `port` (number): RPC port.
- `user` (string): RPC username.
- `pass` (string): RPC password.
- `cliPath` (string): Path to `hemp0x-cli`.
- `confPath` (string): Path to `hemp.conf`.

## vardiff

- `minDiff` (number): Minimum difficulty.
- `maxDiff` (number): Maximum difficulty.
- `targetTime` (number): Ideal share time (seconds).
- `retargetTime` (number): Vardiff retarget interval (seconds).
- `variance` (number): Allowed variance on share timing.

## frontend

- `poolName` (string): UI pool name.
- `poolDescription` (string): UI subtitle.
- `discord` (string): Discord URL.
- `twitter` (string): X/Twitter handle.
- `historyHours` (number): Miner history window (hours).
- `donationAddress` (string, optional): Address shown on the connect page.

## maintenance

- `retentionDays` (number): Days to keep paid shares before pruning.

## payout

Payout scheduling and batching configuration. All values are in satoshis where noted.

- `dryRun` (boolean): When `true`, payout runs simulate but do not broadcast transactions. Set to `false` only with the payout automation gates enabled intentionally.
- `staleLockTimeoutMs` (number): Duration after which a stale payout lock is considered recoverable (default: 3600000 / 1 hour).
- `blockConfirmations` (number): Minimum confirmations required before a payout batch is eligible.
- `maxPayoutBatch` (number): Maximum number of payouts per batch (default: 50, range: 1-200).
- `maxPayoutBatchAmountSats` (number): Maximum total satoshis per payout batch.
- `maxPayoutPerAddressSats` (number): Maximum satoshis payable to a single address per batch.
- `flushIntervalMs` (number): Interval for periodic flush runs that process small balances.
- `flushMinPayoutSats` (number): Minimum satoshi threshold for flush-run payouts.
- `batchBroadcastMaxRetries` (number): Maximum retry attempts for a failed batch broadcast.
- `batchBroadcastBackoffMs` (array of numbers): Retry backoff intervals in milliseconds.
- `payoutRunTimeoutMs` (number): Maximum duration for a single payout run before timeout.
- `sharePaidAfterConfirmed` (boolean): When `true`, shares are marked paid only after the payout batch confirms.
- `rpcDelayMs` (number): Minimum delay between payout-worker daemon RPC calls. This smooths payout cycles so they do not starve Stratum share validation.
- `rpcTransientRetries` (number): Retry count for transient read-only payout RPC failures such as daemon work-queue pressure. Transaction broadcast calls are not retried by this setting.
- `rpcTransientBackoffMs` (number): Base retry backoff in milliseconds for transient read-only payout RPC failures.

## consolidation

UTXO consolidation planning and execution settings. Keep dry-run defaults for review-only operation; enable live mode only after validating wallet state and payout-worker interaction.

- `enabled` (boolean): Master switch for consolidation.
- `dryRunOnly` (boolean): When `true`, consolidation only produces plans without signing or broadcasting.
- `minConfirmations` (number): Minimum confirmations for a UTXO to be a consolidation candidate (default: 100, minimum: 100).
- `maxInputsPerBatch` (number): Maximum inputs per consolidation transaction (default: 200, range: 10-600).
- `maxTxSizeBytes` (number): Maximum transaction size in bytes (default: 80000, range: 1000-100000).
- `feeRateSatsPerByte` (number): Fallback fee rate in satoshis per byte (default: 10). Older `feeRateSatsPerKb` values are translated at config load for compatibility.
- `useSmartFeeEstimate` (boolean): When `true`, use `estimatesmartfee` RPC for dynamic fee estimation.
- `smartFeeConfirmTarget` (number): Confirmation target for smart fee estimation (default: 6).
- `destinationAddress` (string): Destination address for consolidated funds. Must be a valid P2PKH address.
- `autoRunIntervalMs` (number): Interval for automatic consolidation runs. `0` disables automatic runs.
- `operatorApprovalRequired` (boolean): When `true`, consolidation requires explicit operator approval before broadcast.
- `broadcastMaxRetries` (number): Maximum retry attempts for a failed consolidation broadcast.
- `broadcastBackoffMs` (array of numbers): Retry backoff intervals in milliseconds.

### reservePolicy

Controls which UTXOs are excluded from consolidation to maintain pool liquidity.

- `minUtxosToKeep` (number): Minimum number of UTXOs to reserve (default: 500).
- `maxUtxoSizeToKeepSats` (number): Maximum size of a single UTXO to reserve (default: 2000000000 / 20 HEMP).
- `minTotalReserveSats` (number): Minimum total reserved satoshis across all reserve UTXOs (default: 200000000000 / 2000 HEMP).

## health

UTXO health monitoring thresholds and intervals.

- `utxoReportIntervalMs` (number): Interval between UTXO health report runs (default: 86400000 / 24 hours).
- `maturityConfirmations` (number): Confirmations required for a UTXO to be considered mature (default: 100).
- `warnUtxoCountAbove` (number): Warn when total UTXO count exceeds this value (default: 10000).
- `warnUtxoCountBelow` (number): Warn when total UTXO count falls below this value (default: 100).
- `warnBalanceBelowSats` (number): Warn when mature balance falls below this satoshi value (default: 100000000000 / 1000 HEMP).
- `warnDustUtxoCountAbove` (number): Warn when dust UTXO count (below 546 sats) exceeds this value (default: 500).
- `dbIntegrityCheckIntervalMs` (number): Interval between database integrity checks (default: 86400000 / 24 hours).

## automation

Controls which automated processes may run unattended and which require operator approval.

- `readOnlyChecksEnabled` (boolean): When `true`, allows read-only health checks and reporting to run automatically.
- `dryRunPlanningEnabled` (boolean): When `true`, allows dry-run consolidation planning to run automatically.
- `routinePayoutEnabled` (boolean): When `true`, allows the payout worker to run unattended.
- `payoutBroadcastEnabled` (boolean): When `true`, enables actual broadcast of payout transactions.
- `consolidationBroadcastEnabled` (boolean): When `true`, enables consolidation transaction broadcasts.
- `staleLockRecoveryEnabled` (boolean): When `true`, allows automatic recovery of stale payout locks.
- `staleLockTimeoutMs` (number): Duration before a lock is considered stale and eligible for recovery.
- `maxConsecutiveFailures` (number): Maximum consecutive failures before alerting (default: 5).
- `alertOnState` (array of strings): Event states that trigger alerts. Valid values: `failed`, `stale_lock`, `balance_low`, `db_integrity_fail`.
- `logLevel` (string): Logging verbosity (default: `info`).

## Example

This example matches `config.example.json` and uses cookie auth (recommended). Do not include `daemon.user` or `daemon.pass` when `useCookieAuth` is enabled.

```json
{
  "pool": {
    "name": "Hemp0x Mining Pool",
    "stratumPort": 3032,
    "webPort": 8080,
    "maxStratumConnections": 256,
    "maxStratumLineBytes": 65536,
    "maxPendingShareValidations": 8,
    "maxConcurrentShareValidations": 256,
    "maxWorkers": 10000,
    "workerRetentionMs": 1800000,
    "wallet": "YOUR_POOL_WALLET_ADDRESS",
    "walletLabel": "hemp0xpool",
    "hashrateScalar": 1100,
    "fee": 0,
    "rewardModel": "finder-plus-equal",
    "finderBonusPercent": 20,
    "pplnsWindowDifficulty": 2000,
    "activeWindowMinutes": 30,
    "minActiveMinutes": 0,
    "minPayout": 1,
    "payoutInterval": 1800000,
    "flushIntervalMs": 43200000,
    "flushMinPayout": 0.1,
    "blockConfirmations": 100
  },
  "daemon": {
    "host": "127.0.0.1",
    "port": 42070,
    "useCookieAuth": true,
    "cookiePath": "/var/lib/hemp0x-pool/rpc.cookie",
    "cliPath": "/path/to/hemp0x-cli",
    "confPath": "/path/to/hemp.conf"
  },
  "vardiff": {
    "minDiff": 0.2,
    "maxDiff": 1024,
    "targetTime": 15,
    "retargetTime": 30,
    "variance": 0.4
  },
  "frontend": {
    "poolName": "Hemp0x Pool",
    "poolDescription": "Premium KawPoW Mining Pool",
    "discord": "https://discord.gg/hemp0x",
    "twitter": "@hemp0x",
    "historyHours": 4
  },
  "maintenance": {
    "retentionDays": 14
  },
  "payout": {
    "dryRun": true,
    "staleLockTimeoutMs": 3600000,
    "blockConfirmations": 100,
    "maxPayoutBatch": 50,
    "maxPayoutBatchAmountSats": 50000000000,
    "maxPayoutPerAddressSats": 50000000000,
    "flushIntervalMs": 43200000,
    "flushMinPayoutSats": 10000000,
    "batchBroadcastMaxRetries": 3,
    "batchBroadcastBackoffMs": [300000, 900000, 3600000],
    "payoutRunTimeoutMs": 1800000,
    "sharePaidAfterConfirmed": true,
    "rpcDelayMs": 500,
    "rpcTransientRetries": 2,
    "rpcTransientBackoffMs": 2000
  },
  "consolidation": {
    "enabled": false,
    "dryRunOnly": true,
    "minConfirmations": 100,
    "maxInputsPerBatch": 200,
    "maxTxSizeBytes": 80000,
    "feeRateSatsPerByte": 10,
    "useSmartFeeEstimate": true,
    "smartFeeConfirmTarget": 6,
    "destinationAddress": "",
    "reservePolicy": {
      "minUtxosToKeep": 500,
      "maxUtxoSizeToKeepSats": 2000000000,
      "minTotalReserveSats": 200000000000
    },
    "autoRunIntervalMs": 0,
    "operatorApprovalRequired": true,
    "broadcastMaxRetries": 3,
    "broadcastBackoffMs": [300000, 900000, 3600000]
  },
  "health": {
    "utxoReportIntervalMs": 86400000,
    "maturityConfirmations": 100,
    "warnUtxoCountAbove": 10000,
    "warnUtxoCountBelow": 100,
    "warnBalanceBelowSats": 100000000000,
    "warnDustUtxoCountAbove": 500,
    "dbIntegrityCheckIntervalMs": 86400000
  },
  "automation": {
    "readOnlyChecksEnabled": true,
    "dryRunPlanningEnabled": true,
    "routinePayoutEnabled": false,
    "payoutBroadcastEnabled": false,
    "consolidationBroadcastEnabled": false,
    "staleLockRecoveryEnabled": true,
    "staleLockTimeoutMs": 3600000,
    "maxConsecutiveFailures": 5,
    "alertOnState": ["failed", "stale_lock", "balance_low", "db_integrity_fail"],
    "logLevel": "info"
  }
}
```
