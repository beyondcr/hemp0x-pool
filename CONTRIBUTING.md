# Contributing

## Development Setup

The pool application is in `source/hemp0x-pool`.

```bash
cd source/hemp0x-pool
npm ci
npm run doctor
npm test
```

Tests use mock RPC responses and in-memory or temporary SQLite databases. They
must not require access to a live daemon or wallet.

## Changes

- Keep live configuration, databases, logs, wallet files, RPC cookies, and
  deployment credentials out of commits.
- Keep payout, consolidation, and share-accounting changes focused and add
  regression tests for changed behavior.
- Do not enable live broadcasts in `config.example.json`.
- Run `git diff --check`, `npm run doctor`, and `npm test` before opening a change.
- Update the relevant operator documentation when configuration or recovery
  behavior changes.

Please describe operational risk and rollback steps for changes that affect
stratum jobs, payout accounting, wallet use, or database migrations.
