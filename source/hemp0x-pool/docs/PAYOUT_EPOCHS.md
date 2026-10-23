# Payout Accounting Boundaries

A payout epoch identifies the receiving wallet and the last block excluded from
settlement. Only confirmed pool rewards after that height can fund new payouts.
The wallet's existing funds remain available for transaction fees; old recorded
obligations do not become new payment instructions.

Live payout commands require an initialized epoch. On a fresh installation,
initialize it before directing miners to the pool and before enabling the payout
worker. Do not reset an existing installation as routine maintenance.

## Starting An Epoch

Stop the payout worker first. Back up the wallet and take a consistent SQLite
backup of `pool.db`. For a running database, use SQLite's backup API or `.backup`
command rather than copying only the database file without its WAL.

Run from the pool directory as the pool service user:

```bash
HEMP0X_PAYOUT_EPOCH_CONFIRM=I_ACCEPT_ARCHIVING_OLD_PAYOUT_CLAIMS \
  node scripts/start-payout-epoch.js --archive-and-start
```

This is an explicit accounting reset. It archives payout tables and legacy
balances inside the database under a timestamped name, starts empty payout
tables, and records the current chain tip and owned receiving address. Older
unsettled pool blocks are marked `archived`, not `paid`. The separate database
backup retains their original state. Mining data and wallet keys are retained.

For a controlled recovery, `--start-height N` can select an earlier verified
checkpoint after payouts were stopped. The command rejects a future height or
a boundary overlapping rewards that have already been broadcast. This allows
recent unpaid mining to remain eligible while older accounting is archived.

Existing unbroadcast obligations are excluded from future automatic payouts.
Use this only when the operator has explicitly approved that treatment. The
command refuses uncertain broadcasts or a live payout lock. Known broadcast
transactions remain on-chain; starting an epoch cannot reverse a payment.

After reviewing the printed boundary, restart the normal payout worker. New
blocks still need the configured maturity confirmations before payment. The
standard finder bonus and configured reward model remain unchanged.

## Payment Safeguards

Each source block has a database-enforced claim belonging to one payout run.
A failed run does not release its source blocks for a replacement payout.
Retry the original run, whose already broadcast batches are preserved.

Before broadcast, the worker checks source ownership, the epoch boundary,
reward conservation, miner credits, batch totals, and duplicate recipients.
Each batch must atomically move from `created` to `broadcasting` before it can
send. The financial connection uses SQLite FULL synchronous writes so the
claim is durable before the wallet request. Uncertain send outcomes block automatic retries. Never clear that state
without checking whether the daemon accepted the original payment.

Changing the receiving wallet requires an explicit accounting boundary and
wallet rotation plan. A mismatched wallet or invalid source stops payments
without stopping mining.
