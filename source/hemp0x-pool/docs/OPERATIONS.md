# Operations Guide

## Processes

```bash
pm2 start server.js --name hemp0x-pool
pm2 start confirmation.js --name hemp0x-confirmations
pm2 start run-live-payout-loop.sh --name hemp0x-pool-payouts
pm2 start run-live-consolidation-loop.sh --name hemp0x-pool-consolidation
pm2 save
```

Ensure PM2 restarts on reboot:

```bash
pm2 startup
pm2 save
```

For hardened production deployments, run PM2 under a dedicated pool user and order the service after `hemp0xd.service`. When using Hemp0x Core Next cookie auth, `hemp0xd` should create its cookie at a pool-readable path such as `/var/lib/hemp0x-pool/rpc.cookie`; see `CORE_NEXT_COOKIE_AUTH.md`.

All runtime processes wait for daemon RPC and wallet readiness before doing work. The wait can be tuned with:

```bash
HEMP0X_RPC_READY_TIMEOUT_MS=300000
HEMP0X_RPC_READY_INTERVAL_MS=5000
```

## Logs

```bash
pm2 logs hemp0x-pool
pm2 logs hemp0x-confirmations
pm2 logs hemp0x-pool-payouts
```

## Database

- SQLite file: `pool.db`
- WAL mode is enabled for better write throughput.
- If the pool runs long-term, periodically archive or prune paid shares.

Recommended maintenance:

```bash
node maintenance.js
```

Retention is controlled by `maintenance.retentionDays` in `config.json`.

To run maintenance daily at 03:00:

```bash
cat <<'EOF' > /etc/cron.d/hemp0x-maintenance
0 3 * * * root cd /srv/hemp0x-pool/source/hemp0x-pool && /usr/bin/node maintenance.js >> /var/log/hemp0x-maintenance.log 2>&1
EOF
```

## Backups

```bash
sqlite3 pool.db ".backup pool.db.bak"
```

For wallet backups, prefer the daemon RPC so the wallet is copied safely while
the daemon is running:

```bash
HEMP0X_DATADIR=/var/lib/hemp0x/.hemp0x
HEMP0X_CONF="$HEMP0X_DATADIR/hemp0x.conf"
HEMP0X_CLI=/usr/local/bin/hemp0x-cli
"$HEMP0X_CLI" -conf="$HEMP0X_CONF" backupwallet /secure/backups/poolwallet-Rxx-yyy.dat
```

## Pool Wallet Rotation

Long-running pool wallets can accumulate a very large wallet transaction
history. UTXO consolidation reduces spendable output count, but it does not
reduce wallet transaction history. If wallet RPC calls become slow because the
wallet has millions of transactions, rotate to a fresh default wallet.

Use the rotation script only after all active payout runs and broadcasted payout
batches are confirmed. The script refuses to run while payout work is unresolved.

Example using explicit operator paths:

```bash
cd /srv/hemp0x-pool
sudo -E \
  HEMP0X_DATADIR=/var/lib/hemp0x/.hemp0x \
  HEMP0X_CLI=/usr/local/bin/hemp0x-cli \
  BACKUP_DIR=/var/backups/hemp0x-pool/wallets \
  scripts/rotate-pool-wallet.sh --execute
```

The script performs these steps:

- Stops pool, confirmation, payout, and consolidation PM2 processes.
- Backs up the current wallet with `backupwallet`.
- Stops `hemp0xd`.
- Archives the current `wallet.dat` in the Hemp0x data directory.
- Starts `hemp0xd` so it creates a fresh default wallet.
- Generates a new pool address.
- Assigns the new address to the configured payout wallet label
  (`pool.walletLabel`, default `hemp0xpool`) so balance checks and `sendmany`
  use the funded account.
- Backs up the fresh wallet.
- Updates `miningaddress` in `hemp0x.conf`.
- Updates `pool.wallet`, `frontend.donationAddress`, and
  `consolidation.destinationAddress` in `config.json`.
- Restarts `hemp0xd` so the new mining address is active.
- Starts the pool and confirmation processes.
- Leaves the payout loop stopped by default until the new wallet is funded.

After the script prints `NEW_POOL_ADDRESS=...`, fund that address with one
larger transaction rather than many small transactions. Once the funding
transaction is confirmed and `getwalletinfo` shows enough spendable balance,
verify the payout label sees the same spendable funds:

```bash
"$HEMP0X_CLI" -conf="$HEMP0X_CONF" getbalance hemp0xpool 1
```

If `pool.walletLabel` is not `hemp0xpool`, use that configured label in the
command above. The value must be non-zero before the live payout worker can
resume. If the label balance is zero while `getbalance "*" 1` shows funds,
assign the new address to the configured label:

```bash
"$HEMP0X_CLI" -conf="$HEMP0X_CONF" \
  setaccount NEW_POOL_ADDRESS hemp0xpool
```

Then confirm the label balance again and start the payout loop:

```bash
sudo -u hemp0xpool env PM2_HOME=/var/lib/hemp0x-pool/.pm2 \
  pm2 start hemp0x-pool-payouts
```

If you intentionally want the script to restart payouts immediately, set:

```bash
START_PAYOUTS=1 scripts/rotate-pool-wallet.sh --execute
```

Emergency rotations should normally wait for all payouts to finish. If the
wallet must be rotated while a payout run still has `created` batches, stop the
payout loop first, reconcile any `broadcasting` batch with wallet history, and
run:

```bash
ALLOW_UNRESOLVED_PAYOUTS=1 scripts/rotate-pool-wallet.sh --execute
```

Use this only when the remaining batches are expected to resume from the fresh
wallet after it is funded.

Keep the archived old wallet and its `backupwallet` copy. It may be needed for
audits, old transaction lookups, or reserve recovery.

## Scaling considerations

- Share inserts are per-share; at high rates you may need batching.
- `getkawpowhash` RPC calls scale linearly with shares.
- Consider multiple stratum instances or Node.js clustering for large loads.

## Health checks

- Web UI: `http://HOST:WEB_PORT`
- Stratum port: `STRATUM_PORT`

## Health and Consolidation Operations

### UTXO Health Reports

Health reports run at `health.utxoReportIntervalMs` (default: every 24 hours). Reports include:

- Total UTXO count, mature/immature breakdown
- Amount and confirmation distribution buckets
- Dust UTXO count and total
- Transaction pressure estimates for payout batching
- Warnings based on configured thresholds

To run a manual health report:

```bash
node -e "const { runHealthReport } = require('./utxoHealth'); const { loadConfig } = require('./config'); const config = loadConfig(); /* rpc function here */ runHealthReport({ rpc, config }).then(console.log)"
```

### Dry-Run Consolidation Planning

Consolidation planning runs at `consolidation.autoRunIntervalMs` (default: 0 / disabled). Plans include:

- Selected inputs sorted by oldest confirmations first
- Reserve policy exclusions
- Batch grouping with fee estimates
- Operator checklist for manual review

To run a manual dry-run plan using the consolidation worker CLI:

```bash
node scripts/consolidation-worker.js --plan
node scripts/consolidation-worker.js --plan --max-batches 5 --max-inputs 100
```

The `--plan` command prints a JSON plan without signing or broadcasting anything.

### UTXO Health Check

```bash
node scripts/consolidation-worker.js --health
```

### Dry-Run Process Simulation

Simulates processing without signing or broadcasting:

```bash
node scripts/consolidation-worker.js --process
node scripts/consolidation-worker.js --process --max-batches 1 --max-inputs 25
```

### Live Consolidation (One Small Batch First)

**Warning: This broadcasts real consolidation transactions.** Always test with dry-run first.

```bash
HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS_REAL_CONSOLIDATION \
  node scripts/consolidation-worker.js --process --live --max-batches 1 --max-inputs 25
```

Required for live mode:
- `--live` flag
- Environment variable `HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM` set to the exact confirmation string
- No unresolved payout batches or non-terminal payout runs
- Config destination address must be valid
- Wallet must have sufficient balance

### Confirm Broadcasted Consolidation Batches

```bash
node scripts/consolidation-worker.js --confirm
```

### Full Cycle (Confirm + Plan + Process)

Dry-run by default:

```bash
node scripts/consolidation-worker.js --cycle
```

Live single-batch cycle:

```bash
HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS_REAL_CONSOLIDATION \
  node scripts/consolidation-worker.js --cycle --live --max-batches 1 --max-inputs 25
```

### Live Consolidation Loop Policy

The production loop checks UTXO health on `HEMP0X_CONSOLIDATION_INTERVAL_SECONDS` (default: 1800 seconds). It keeps consolidation hands-off while avoiding unnecessary large transactions:

- `HEMP0X_CONSOLIDATION_TARGET_UTXOS` (default: 200): skip live consolidation when mature spendable UTXOs are at or below this target.
- `HEMP0X_CONSOLIDATION_LARGE_BATCH_THRESHOLD` (default: 700): use large batches only while the wallet is above this count.
- `HEMP0X_CONSOLIDATION_LARGE_BATCH_MAX_INPUTS` (default: 599): maximum inputs for high-UTXO catch-up batches.
- `HEMP0X_CONSOLIDATION_MAINTENANCE_BATCH_MAX_INPUTS` (default: 50): maximum inputs for maintenance batches below the large-batch threshold.
- `HEMP0X_CONSOLIDATION_MAX_BATCHES` (default: 1): maximum batches per loop cycle.
- `HEMP0X_CONSOLIDATION_BLOCKED_RETRY_SECONDS` (default: 120): wait time before retrying when a payout batch is briefly in `created` or `broadcasting` state.
- `HEMP0X_CONSOLIDATION_BLOCKED_RETRIES` (default: 5): number of short retries before waiting for the next full loop interval.

With defaults, the loop uses up to 599 inputs above 700 mature spendable UTXOs, up to 50 inputs from 201-700 UTXOs, and skips at 200 or below. The worker still enforces payout/consolidation locks before signing or broadcasting.

### Recommended First-Time Operator Workflow

1. **Health check**: `node scripts/consolidation-worker.js --health`
2. **View the plan**: `node scripts/consolidation-worker.js --plan --max-batches 1 --max-inputs 25`
3. **Review**: Verify the destination address, confirm fee rate, verify reserve policy leaves enough for pending payouts.
4. **Dry-run process**: `node scripts/consolidation-worker.js --process --max-batches 1 --max-inputs 25`
5. **Live one batch**: Set the env var and run with `--process --live --max-batches 1 --max-inputs 25`
6. **Verify txid**: Check the output for the txid, look it up on a block explorer
7. **Confirm**: Run `node scripts/consolidation-worker.js --confirm` after the transaction has enough confirmations
8. **Do NOT enable automatic scheduling** until you have successfully run several small manual batches and verified all transactions confirmed correctly.

### Stopping Before Automatic Scheduling

Consolidation is designed to be manual-only initially. Do NOT set:
- `consolidation.autoRunIntervalMs` to a positive value
- `automation.consolidationBroadcastEnabled` to `true` (will be rejected at config load)

Live broadcast is only possible through the worker CLI with explicit `--live` flag and environment variable confirmation. The PM2 loop scripts provide unattended scheduling after those gates are intentionally enabled.

### Safety Gates

The default example config keeps these gates in safe dry-run positions. Operators may intentionally enable them in config after validation, or use the reviewed `--live` loop scripts that apply the same gates after checking confirmation environment variables:

- `payout.dryRun: false`
- `automation.routinePayoutEnabled: true`
- `automation.payoutBroadcastEnabled: true`
- `consolidation.enabled: true`
- `consolidation.dryRunOnly: false`
- `automation.consolidationBroadcastEnabled: true`

### Ambiguous Payout Broadcasts

The payout worker treats a timeout or connection failure after `sendmany` has
started as an unresolved broadcast. The batch is recorded as
`broadcast_unknown`, the run remains active, and the worker will not retry the
batch or plan its source blocks again automatically. This prevents a lost RPC
response from becoming a duplicate payout.

Explicit daemon rejections such as insufficient funds remain retryable after
the underlying condition is corrected. An operator must reconcile an
`broadcast_unknown` batch against wallet transaction history before changing
its status or resuming that run. Never reset it to `created` based only on the
client-side error message.

### Payout Automation Status

Check current payout automation mode via the admin status endpoint:

```bash
curl -s http://localhost:8080/admin/status | python3 -m json.tool | grep -A10 payoutAutomation
```

The `payoutAutomation` object reports:
- `mode`: `dry_run` (default, no broadcast), `disabled` (automation off), or `live` (all gates open)
- `message`: human-readable description of current mode
- `gates`: individual gate statuses (`dryRun`, `routinePayoutEnabled`, `payoutBroadcastEnabled`, `liveCapable`)

Or in the admin dashboard at `http://localhost:8080/admin.html` → Status tab.

### Stale Lock Recovery

When `automation.staleLockRecoveryEnabled` is `true`, stale payout locks are automatically cleared after `staleLockTimeoutMs` (default: 1 hour). No operator action is required.

### Database Integrity Checks

Integrity checks run at `health.dbIntegrityCheckIntervalMs` (default: every 24 hours). If a check fails:

1. An alert is emitted (if `db_integrity_fail` is in `alertOnState`)
2. The consecutive failure counter increments
3. Automated operations halt after `maxConsecutiveFailures` (default: 5)

### Alerts

Alerts are emitted for states configured in `automation.alertOnState`. Valid states:

- `failed` - automated operation failure
- `stale_lock` - stale payout lock recovery
- `balance_low` - mature balance below warning threshold
- `db_integrity_fail` - database integrity check failure
