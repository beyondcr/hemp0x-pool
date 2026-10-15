#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export HEMP0X_POOL_LIVE_PAYOUT_CONFIRM="I_UNDERSTAND_THIS_BROADCASTS_REAL_PAYOUTS"
INTERVAL_SECONDS="${HEMP0X_PAYOUT_INTERVAL_SECONDS:-600}"
MAX_BLOCKS="${HEMP0X_PAYOUT_MAX_BLOCKS:-500}"

log() {
  printf '[%s] [payout-loop] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

log "started interval=${INTERVAL_SECONDS}s max_blocks=${MAX_BLOCKS}"

while true; do
  log "waiting for RPC readiness"
  node scripts/wait-for-rpc-ready.js || {
    log "RPC is not ready; retrying after interval"
    sleep "$INTERVAL_SECONDS"
    continue
  }
  log "running payout cycle"
  node scripts/payout-worker.js --cycle --live --max-blocks "$MAX_BLOCKS" || true
  sleep "$INTERVAL_SECONDS"
done
