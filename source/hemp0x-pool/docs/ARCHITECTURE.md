# Architecture Overview

This pool is a single Node.js service that runs a KawPoW stratum server and a lightweight web UI, with an admin dashboard for operator visibility.

## Components

### Web Server (server.js)
- Express app serving the public UI (`/public`) and API endpoints
- Public endpoints: `/stats`, `/miners`, `/connect-info`, `/blocks`, `/miner/:address/stats`, `/miner/:address/workers`
- Admin endpoints: `/admin/config`, `/admin/status`, `/admin/payout/*`, `/admin/consolidation/*`
- Admin access: localhost-only by default, or Bearer token via `adminToken` config or `HEMP0X_POOL_ADMIN_TOKEN` env
- Security: headers (X-Content-Type-Options, X-Frame-Options, etc.), error sanitization, config redaction

### Stratum Server
- Raw TCP server on `pool.stratumPort`
- Connection, request-size, worker-retention, and concurrent-validation limits
  protect the public TCP service from resource exhaustion
- KawPoW job building using daemon `getblocktemplate`
- Share validation via `getkawpowhash` RPC
- Pool mode (pass = x): rewards go to pool wallet, credited via payout system
- Solo mode (pass = s): coinbase pays miner directly
- VARDIFF per worker based on share timing

### Database (SQLite)
- WAL mode for write throughput
- Active tables: `shares`, `blocks`, `process_locks`, `pplns_windows`
- Historical compatibility tables: `payouts`, `reward_balances`
- Ledger tables: `payout_runs`, `payout_block_credits`, `payout_miner_credits`, `payout_batches`, `payout_batch_outputs`, `payout_events`
- Consolidation tables: `consolidation_plans`, `consolidation_batches`, `consolidation_batch_inputs`, `consolidation_events`
- Migrations managed by `migrations.js` with SHA-256 checksums and foreign keys

### Payout System

#### Payout Pipeline (Live-Gated)

**Payout Planner (payoutPlanner.js):**
- Reads unpaid confirmed blocks from the database
- Computes miner credits using the configured reward model (`finder-plus-equal` by default; `pplns` is beta/testing only)
- Writes durable plan into `payout_runs`, `payout_block_credits`, `payout_miner_credits`, `payout_batches`, `payout_batch_outputs`
- Creates review-only events (approve/reject) via admin API
- All amounts in integer satoshis

**Payout Ledger (payoutLedger.js):**
- DAO for ledger tables with non-negative safe-integer validation
- Methods: `createRun`, `createBatch`, `createBatchOutput`, `getRunsPaginated`, `getRunDetail`, `getEventsForRun`, `createReviewEvent`, `getStaleRuns`
- All money values stored as integer satoshis

**Payout Worker (payoutWorker.js):**
- Processes planned runs from the ledger
- Dry-run mode (default): simulates batch processing, records events, does NOT change status
- Live mode (triple-gated): broadcasts batches via `sendmany` RPC
- Run-level locking via `process_locks` table to prevent overlapping execution
- Stale lock recovery when `automation.staleLockRecoveryEnabled` is true
- Confirmation checking via `confirmBroadcastedBatches`
- Stale run/batch detection for recovery visibility
- **Does not auto-start from imports.** It is run by the operator-managed loop script or scheduler.

#### Live Broadcast Gates (all three must be explicitly `true`)
1. `payout.dryRun === false`
2. `automation.routinePayoutEnabled === true`
3. `automation.payoutBroadcastEnabled === true`

Under the default example config, all three are false. The live CLI workers can override these gates only when called with `--live` and the matching confirmation environment variable. Production operators should do this only after validating wallet/RPC settings.

### UTXO Health & Consolidation

**UTXO Health (utxoHealth.js):**
- Read-only UTXO health reports via `listunspent` RPC
- Maturity breakdown, dust detection, transaction pressure estimates
- Warnings based on configurable thresholds
- No signing or broadcast

**Consolidation Planner (consolidationPlanner.js):**
- Builds consolidation plans for dry-run review or live-gated execution
- Selects mature UTXOs, applies reserve policy, batches by size
- Estimates fees using fallback rate or `estimatesmartfee`
- Produces operator checklist
- Live execution is gated by `consolidation.enabled`, `consolidation.dryRunOnly`, and `automation.consolidationBroadcastEnabled`

**Consolidation Ledger (consolidationLedger.js):**
- DAO for consolidation plan storage
- Plans, batches, inputs, events

### Admin Dashboard (admin.html)
- Built-in web UI served from `/public/admin.html`
- Tabs: Config, Status, Payout Plan, Consolidation Plan, Review
- Read-only config display with redacted secrets
- Dry-run payout and consolidation planning
- Plan history with pagination
- Review-only approve/reject with audit trail

### Config System (config.js + configSchema.js + configRedaction.js)
- Schema-driven validation with categorized fields (public/tunable/dangerous/secret)
- Safety gates enforced at config load
- Config redaction for API exposure
- Address validation via shared `address.js` module

## Payout Model (finder-plus-equal)

For each confirmed pool-mode block:
- A finder reward (percentage) is credited to the block finder
- The remainder is split equally among active miners
- Active miners must have contributed for at least `minActiveMinutes` inside the `activeWindowMinutes` window

## Block Lifecycle

Blocks in the database move through states:
- `pending`: submitted to network, not yet confirmed
- `confirmed`: reached `blockConfirmations`
- `credited`: block rewards credited to miner balances
- `paid`: payout completed

## Production-Ready vs Future-Gated

| Component | Status |
|-----------|--------|
| Stratum server | Production-ready |
| Web UI | Production-ready |
| Admin dashboard (Config, Status, Review tabs) | Production-ready |
| Payout planner (dry-run) | Production-ready |
| Payout worker (dry-run) | Production-ready |
| Payout worker (live broadcast) | Production-ready when explicitly gated on |
| Consolidation planner/executor | Production-ready when explicitly gated on |
| UTXO health reports | Read-only, production-ready |
| Config validation | Production-ready |

## Safety Gates

The default example config keeps all broadcast paths disabled. Live mode requires either explicit operator config or the reviewed CLI live override path:
- Payout live mode: `payout.dryRun === false`, `automation.routinePayoutEnabled === true`, `automation.payoutBroadcastEnabled === true`
- Consolidation live mode: `consolidation.enabled === true`, `consolidation.dryRunOnly === false`, `automation.consolidationBroadcastEnabled === true`

## Web UI

The UI is static files served from `/public`:
- `index.html`: pool stats + miner view
- `miner.html`: standalone miner stats page
- `connect.html`: connection guide and payout model
- `admin.html`: operator dashboard (read-only config, status, planning, review)
