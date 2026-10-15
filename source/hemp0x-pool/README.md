# Hemp0x Pool

A KawPoW pool for Hemp0x. It supports pooled mining and true solo mining from the same stratum port, with ledger-backed payouts, UTXO health automation, and a miner-facing web UI.

## Features

- Full KawPoW job building and share validation via daemon `getkawpowhash`
- Correct block assembly with template transactions
- Ledger-backed pool payouts with configurable reward modes
- True solo mining (coinbase pays the miner directly)
- VARDIFF per worker
- Live stats and miner dashboards
- UTXO health reporting and live-gated consolidation automation
- Safe self-healing automation with explicit payout and consolidation gates

## Prerequisites

- Ubuntu 20.04+ (or similar Linux)
- Node.js 18+ and npm
- Running hemp0xd with RPC enabled
- PM2 for process management

## Installation

```bash
npm install
npm install -g pm2
```

Copy `config.example.json` to `config.json` and edit it with your wallet, RPC, and port settings.

## Documentation

- `docs/SETUP.md`: setup guide, first-run checks, tests, and process management
- `docs/CONFIG.md`: full configuration reference
- `docs/ARCHITECTURE.md`: system design, payout flow, all components
- `docs/OPERATIONS.md`: deployment, logs, status checks, and maintenance
- `docs/CORE_NEXT_COOKIE_AUTH.md`: Hemp0x Core Next daemon and RPC cookie-auth setup
- `docs/SELF_HEALING.md`: self-healing policy, alert states, and recovery procedures
- `docs/RELEASE.md`: release, update, verification, and rollback runbook

## Running

```bash
pm2 start server.js --name hemp0x-pool
pm2 start confirmation.js --name hemp0x-confirmations
pm2 save
```

### Payout Workers

The ledger-backed payout worker is the current payout path. It supports dry-run simulation, idempotency, run-level locking, confirmation tracking, and explicit live broadcast gates.

```bash
pm2 start run-live-payout-loop.sh --name hemp0x-pool-payouts
pm2 start run-live-consolidation-loop.sh --name hemp0x-pool-consolidation
```

## Miner Connection

Pool mode (payouts from pool wallet):

```bash
miner -a kawpow -o stratum+tcp://YOUR.IP:3032 -u YOUR_WALLET.worker1 -p x
```

Solo mode (block pays the miner directly):

```bash
miner -a kawpow -o stratum+tcp://YOUR.IP:3032 -u YOUR_WALLET.worker1 -p s
```

Open `/connect.html` in the web UI for a connection helper and auto-generated templates.

## Payouts

- Pool payouts use confirmed pool blocks only.
- Solo blocks are tracked but not paid by the pool (coinbase pays the miner).
- Minimum payout is set by `pool.minPayout` in `config.json`.
- A 12-hour flush window is controlled by `pool.flushIntervalMs` with a lower minimum set by `pool.flushMinPayout`.
- Confirmation depth is set by `pool.blockConfirmations` in `config.json`.
- Pool reward model is configured by:
  - `pool.rewardModel` (default `finder-plus-equal`; `pplns` is beta/testing only)
  - `pool.finderBonusPercent` (finder bonus portion)
  - `pool.activeWindowMinutes` (recent activity window for shared rewards)
  - `pool.minActiveMinutes` (minimum active time before sharing)
- Pool fee is set by `pool.fee` (0.0 = no fee).
- Payout frequency is set by `pool.payoutInterval` (milliseconds).

## Database

- SQLite runs in WAL mode for better write throughput.
- See `docs/OPERATIONS.md` for backups and pruning guidance.
- Schema migrations are managed by `migrations.js` with checksums and foreign key enforcement.

## Frontend

- Miner history window is controlled by `frontend.historyHours` in `config.json`.

## Safety Gates

The default example config is dry-run only. Live payout and consolidation broadcasts require explicit operator action. The CLI loop scripts use `--live` plus confirmation environment variables to override the dry-run defaults at process runtime:

- Payout live mode: `payout.dryRun: false`, `automation.routinePayoutEnabled: true`, `automation.payoutBroadcastEnabled: true`
- Consolidation live mode: `consolidation.enabled: true`, `consolidation.dryRunOnly: false`, `automation.consolidationBroadcastEnabled: true`

See `docs/SELF_HEALING.md` for the full self-healing policy.

## Notes

- The pool uses the daemon's `getkawpowhash` RPC for share validation.
- The pool wallet address must belong to the node wallet (or have its private key imported),
  otherwise the daemon balance will stay near zero and payouts will fail.
- If the pool wallet has a label/account, set `pool.walletLabel` so payouts draw from the correct account.
- Do not point miners to this server using HTTP or a browser; use a stratum client.

## Maintenance

```bash
pm2 logs hemp0x-pool
pm2 logs hemp0x-confirmations
pm2 logs hemp0x-pool-payouts
pm2 logs hemp0x-pool-consolidation
node maintenance.js
```
