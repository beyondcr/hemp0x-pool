<div align="center">
  <img src="source/hemp0x-pool/public/logo.png" alt="Hemp0x Pool logo" width="96" height="96">

  # Hemp0x Pool

  **KawPoW mining pool software for Hemp0x.**

  [![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-00cc66?style=flat-square)](#requirements)
  [![KawPoW](https://img.shields.io/badge/Algorithm-KawPoW-00ff66?style=flat-square)](#features)
  [![RPC Cookie Auth](https://img.shields.io/badge/RPC-Cookie%20Auth-00cc66?style=flat-square)](source/hemp0x-pool/docs/CORE_NEXT_COOKIE_AUTH.md)
  [![License: ISC](https://img.shields.io/badge/License-ISC-00cc66?style=flat-square)](LICENSE)
</div>

Hemp0x Pool is a full mining pool stack for Hemp0x. It includes a KawPoW stratum server, miner-facing web UI, ledger-backed automated payouts, UTXO health and consolidation automation, and operator documentation for running the pool as a long-lived service.

The application code lives in [`source/hemp0x-pool`](source/hemp0x-pool/).

## Features

- KawPoW stratum server with VARDIFF per worker
- Pool and solo mining from the same stratum port
- Miner-facing dashboard, miner lookup, connection helper, and payout activity
- Ledger-backed payout planning, broadcast, confirmation, and idempotency controls
- UTXO health reports and live-gated consolidation worker
- Hemp0x Core Next RPC cookie-auth support
- Non-root PM2/systemd deployment path
- Beta groundwork for optional PPLNS reward mode

## Requirements

- Linux server, preferably Ubuntu 20.04+ or similar
- Node.js 18+ and npm
- Hemp0x Core Next daemon with RPC enabled
- PM2 or another process manager
- A pool wallet controlled by the daemon wallet

## Get Started

Start with the [Setup Guide](source/hemp0x-pool/docs/SETUP.md). It covers daemon requirements, cookie-auth RPC setup, pool configuration, first-run checks, and production process management.

## Documentation

- [Setup Guide](source/hemp0x-pool/docs/SETUP.md)
- [Operations Guide](source/hemp0x-pool/docs/OPERATIONS.md)
- [Core Next Cookie Auth](source/hemp0x-pool/docs/CORE_NEXT_COOKIE_AUTH.md)
- [Configuration Reference](source/hemp0x-pool/docs/CONFIG.md)
- [Architecture](source/hemp0x-pool/docs/ARCHITECTURE.md)
- [Self-Healing Policy](source/hemp0x-pool/docs/SELF_HEALING.md)
- [Release Runbook](source/hemp0x-pool/docs/RELEASE.md)

## Runtime Notes

Run the pool as a dedicated non-root user. Hemp0x Core Next cookie auth is the recommended RPC setup, and the default example config keeps payout/consolidation broadcast gates disabled until an operator intentionally enables live mode.

The default reward mode is `finder-plus-equal`. PPLNS support is included as beta groundwork for operators who want to test it outside production first.

Before launching a configured pool, run:

```bash
cd source/hemp0x-pool
npm run doctor
npm test
```

## Project Files

The runnable pool is under `source/hemp0x-pool`. Live configuration, databases,
logs, wallet files, and daemon credentials belong on the operator's server and
are intentionally excluded from this repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and
[SECURITY.md](SECURITY.md) for reporting security issues.
