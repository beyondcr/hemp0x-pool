# Release and Update Runbook

This runbook covers how to cut a release, apply an update, verify it, and roll
back if needed. It describes the operator steps; it does not perform a deployment.

## Preflight Before Tagging / Release

Run these checks on a clean checkout of the target branch before tagging:

```bash
cd source/hemp0x-pool

# 1. Install dependencies fresh
npm ci

# 2. Safety and config checks (no live RPC)
npm run doctor

# 3. Full test suite (in-memory DB, mock RPC)
npm test

# 4. Production dependency audit
npm audit --omit=dev

# 5. Whitespace and conflict markers
git diff --check
```

All of these must pass with zero failures and zero warnings before a release tag
is created.

## Prerequisites for Production Update

Before touching a running pool:

- Read `docs/SELF_HEALING.md` to understand what automation is active.
- Confirm the safety gates in `config.json` are **all** in safe position:
  - `payout.dryRun` = `true`
  - `consolidation.enabled` = `false`
  - `consolidation.dryRunOnly` = `true`
  - `automation.routinePayoutEnabled` = `false`
  - `automation.payoutBroadcastEnabled` = `false`
  - `automation.consolidationBroadcastEnabled` = `false`
- Confirm no payout run or consolidation plan is in progress.
- Have SSH access and `sudo` (or equivalent) available on the pool host.

## Backup Requirements

Before applying any update:

1. **Stop the pool processes:**
   ```bash
   pm2 stop all
   ```

2. **Backup the database:**
   ```bash
   sqlite3 pool.db ".backup pool.db.pre-update-$(date +%Y%m%d-%H%M%S)"
   ```

3. **Backup the working config:**
   ```bash
   cp config.json config.json.pre-update-$(date +%Y%m%d-%H%M%S)
   ```

4. **Backup the current release tree** (entire pool project directory from the
   running server).

5. **Confirm backup integrity** before proceeding:
   ```bash
   sqlite3 pool.db.pre-update-* "PRAGMA integrity_check"
   ```

Store backups off-server if possible before the update.

## Optional Parallel Test

For a chain-critical pool, test a new release beside the running pool before
cutover when practical.

1. Deploy the new release into a separate directory.
2. Copy `config.json`, change only `pool.stratumPort` and `pool.webPort` to free
   temporary ports, and keep payout/consolidation live gates disabled.
3. Copy a backup of `pool.db` into the new directory for compatibility checks.
4. Run `npm ci`, `npm run doctor`, and `npm test`.
5. Start temporary PM2 processes with non-production names.
6. Point a controlled miner at the temporary stratum port and verify:
   - Miner authorization, job delivery, share acceptance, and VARDIFF behavior.
   - Web stats and admin status load on the temporary web port.
   - Payout automation remains dry-run and no broadcast attempts appear in logs.
7. Stop and delete the temporary PM2 processes before cutover.

Never run two live payout workers against the same wallet.

## Production Cutover Process

1. Deploy the verified release to the pool host side-by-side with the running
   tree. Do not overwrite the running tree.

2. Copy the production `config.json` and latest `pool.db` into the new tree.

3. Run preflight in the new tree *without starting the pool*:
   ```bash
   cd /path/to/new-release
   npm ci
   npm run doctor
   npm test
   ```

4. Validate the live config against the new code:
   ```bash
   node -e "const { loadConfig } = require('./config'); loadConfig(); console.log('Config OK');"
   ```

5. If all checks pass, stop the old processes and start the new ones:
   ```bash
   # Old tree
   pm2 stop hemp0x-pool hemp0x-confirmations

   # New tree
   cd /path/to/new-release
   pm2 start server.js --name hemp0x-pool
   pm2 start confirmation.js --name hemp0x-confirmations
   pm2 save
   ```

6. Verify miner connectivity, web UI, and admin status within the first few minutes.
   See **Post-Update Checks** below.

## Rollback Plan

If the update introduces problems:

1. Stop the new processes:
   ```bash
   pm2 stop all
   ```

2. Restore the database from the pre-update backup:
   ```bash
   cp pool.db.pre-update-* pool.db
   ```

3. Restore the config if it was modified:
   ```bash
   cp config.json.pre-update-* config.json
   ```

4. Start the old release:
   ```bash
   cd /path/to/old-release
   pm2 start server.js --name hemp0x-pool
   pm2 start confirmation.js --name hemp0x-confirmations
   pm2 save
   ```

5. Confirm the pool is serving shares and miners are reconnecting.

**Do not run both old and new pool instances simultaneously** — two stratum
servers bound to the same port will conflict, and two payout workers would risk
double payouts.

## Post-Update Checks

Immediately after starting the updated pool:

- **Stratum**: Confirm miners are submitting shares. Check PM2 logs:
  ```bash
  pm2 logs hemp0x-pool --lines 50
  ```

- **Web UI**: Load the public dashboards and confirm pool stats are updating.

- **Admin dashboard**: Verify safety gate status in the Status tab or via:
  ```bash
  curl -s http://localhost:8080/admin/status | python3 -m json.tool | grep -A10 payoutAutomation
  ```
  Confirm the payout automation mode reports `dry_run`.

- **Confirmation tracking**: Check that `hemp0x-confirmations` is logging block
  confirmation updates normally.

- **Database**: Run a manual integrity check after the first 5 minutes:
  ```bash
  node -e "const { openDb } = require('./database'); const db = openDb('pool.db'); db.get('PRAGMA integrity_check').then(r => console.log(r)); db.close();"
  ```

## Miner-Operation Protection

- **Always stop the pool before applying an update.** Miners will disconnect
  briefly; they will retry and reconnect when the pool comes back.

- **Do not change the stratum port or web port** during an update unless you
  also notify miners and update any public pool listings.

- **Do not modify the pool wallet address** or `daemon` section during an update
  without a full rollback plan — these changes can cause payouts to fail or
  miners to mine to an unintended address.

- **Payouts may be delayed during the update window.** The pool does not lose
  share data during a restart — shares are persisted to SQLite. Payouts resume
  normally once the server and confirmation tracker are running again.
