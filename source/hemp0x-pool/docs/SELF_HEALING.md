# Self-Healing Policy

This document defines what the pool automation system may do unattended, what requires operator approval, and how the system recovers from failure states.

## Principles

- The default configuration is read-only/dry-run. Live broadcast requires explicit operator gates or the reviewed CLI `--live` path with confirmation environment variables.
- Safety gates and worker locks prevent accidental overlapping payout/consolidation execution.
- All automated actions are logged at the configured `automation.logLevel`.
- Alerts are emitted for states listed in `automation.alertOnState`.

## What May Run Unattended

The following operations may run without operator approval when their corresponding `automation` flags are enabled:

| Operation | Config Flag | Description |
|---|---|---|
| UTXO health reports | `readOnlyChecksEnabled` | Periodic `listunspent` queries and health summary generation |
| DB integrity checks | `readOnlyChecksEnabled` | Periodic SQLite integrity verification |
| Dry-run consolidation planning | `dryRunPlanningEnabled` | Generates consolidation plans without signing or broadcast |
| Routine payout broadcast | `routinePayoutEnabled` + `payoutBroadcastEnabled` | Runs the ledger-backed payout worker when live gates are intentionally enabled |
| Consolidation broadcast | `consolidation.enabled` + `consolidationBroadcastEnabled` | Runs the consolidation executor when live gates are intentionally enabled |
| Stale lock recovery | `staleLockRecoveryEnabled` | Clears payout locks older than `staleLockTimeoutMs` |
| Alert emission | N/A | Automatic alerts for configured failure states |

## What Requires Operator Approval

The following operations require explicit operator action before proceeding:

| Operation | Config Gate | Notes |
|---|---|---|
| Config changes to live gates | Operator review | Confirm wallet/RPC settings, backups, and rollback before enabling |

## Stale Lock Recovery

Payout operations use locks to prevent concurrent runs. A lock becomes stale when:

- The process that acquired it crashes or times out
- The lock age exceeds `payout.staleLockTimeoutMs` (default: 1 hour)
- The lock age exceeds `automation.staleLockTimeoutMs`

When `automation.staleLockRecoveryEnabled` is `true`, the system automatically clears stale locks after the timeout period. This allows subsequent payout runs to proceed without manual intervention.

### Recovery process

1. Check lock age against configured timeout
2. If exceeded, clear the lock and log the recovery event
3. Emit a `stale_lock` alert if configured in `alertOnState`
4. Allow the next scheduled run to proceed

## Database Health Checks

The system performs periodic SQLite integrity checks at `health.dbIntegrityCheckIntervalMs` (default: 24 hours).

### Check scope

- `PRAGMA integrity_check` on the pool database
- Verification of expected table existence
- Foreign key constraint validation (enabled during migrations)

### Failure response

1. Log the integrity failure at `error` level
2. Emit a `db_integrity_fail` alert if configured
3. Increment the consecutive failure counter
4. If failures exceed `automation.maxConsecutiveFailures`, halt automated operations

### Recovery

- Restore from the most recent backup
- Run `PRAGMA integrity_check` manually to assess damage
- Do not resume automated operations until integrity is confirmed

## Warning and Alert Events

The system emits alerts for the following states (configurable via `automation.alertOnState`):

| State | Trigger | Severity |
|---|---|---|
| `failed` | Any automated operation fails | Error |
| `stale_lock` | A payout lock is recovered as stale | Warning |
| `balance_low` | Mature UTXO balance falls below `health.warnBalanceBelowSats` | Warning |
| `db_integrity_fail` | SQLite integrity check fails | Critical |

### Consecutive failure handling

- Each failure increments a counter
- When the counter reaches `automation.maxConsecutiveFailures` (default: 5), automated operations halt
- Manual intervention is required to reset the failure counter and resume operations

## UTXO Health Warnings

The health report generates warnings based on configurable thresholds:

- **High UTXO count**: `utxos.length > health.warnUtxoCountAbove` (default: 10000)
- **Low UTXO count**: `utxos.length < health.warnUtxoCountBelow` (default: 100)
- **High dust count**: `dustUtxos.length > health.warnDustUtxoCountAbove` (default: 500)
- **Low balance**: `matureBalanceSats < health.warnBalanceBelowSats` (default: 100000000000 / 1000 HEMP)

Dust is defined as UTXOs below 546 satoshis (`DUST_THRESHOLD_SATS` in `txConstants.js`), matching the standard Bitcoin dust threshold.

## Maturity Warnings

The health report tracks UTXO maturity states:

- **Coinbase unspendable**: 0 confirmations (newly mined or otherwise unconfirmed)
- **Under 6 confirmations**: low-confirmation outputs, treated as unavailable for automated pool maintenance
- **Under maturity confirmations**: below the pool's configured maturity threshold (default: 100)
- **Mature**: meets or exceeds `health.maturityConfirmations`

Transactions involving immature coinbase outputs will be rejected by the network. The health report warns when a significant portion of the wallet balance is immature.

## Transaction Pressure Estimates

The health report estimates transaction pressure for payout batching:

- Estimated inputs per batch (capped at 15 or UTXO count)
- Estimated transaction size per batch
- Size ratio of inputs to outputs
- Recommended batch count for the current UTXO set

These estimates help operators plan for high-UTXO scenarios and determine when consolidation is warranted.
