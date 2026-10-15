#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

INTERVAL_SECONDS="${HEMP0X_CONSOLIDATION_INTERVAL_SECONDS:-1800}"
TARGET_UTXOS="${HEMP0X_CONSOLIDATION_TARGET_UTXOS:-200}"
LARGE_BATCH_THRESHOLD="${HEMP0X_CONSOLIDATION_LARGE_BATCH_THRESHOLD:-700}"
LARGE_BATCH_MAX_INPUTS="${HEMP0X_CONSOLIDATION_LARGE_BATCH_MAX_INPUTS:-599}"
MAINTENANCE_BATCH_MAX_INPUTS="${HEMP0X_CONSOLIDATION_MAINTENANCE_BATCH_MAX_INPUTS:-50}"
MAX_BATCHES="${HEMP0X_CONSOLIDATION_MAX_BATCHES:-1}"
BLOCKED_RETRY_SECONDS="${HEMP0X_CONSOLIDATION_BLOCKED_RETRY_SECONDS:-120}"
BLOCKED_RETRIES="${HEMP0X_CONSOLIDATION_BLOCKED_RETRIES:-5}"
LIVE_CONFIRM="I_UNDERSTAND_THIS_BROADCASTS_REAL_CONSOLIDATION"

log() {
  printf '[%s] [consolidation-loop] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

count_mature_utxos() {
  node - <<'NODE'
const { loadConfig } = require('./config');
const { createRpcClient } = require('./rpcClient');

(async () => {
  const config = loadConfig();
  const minConfirmations = Number(config.consolidation?.minConfirmations || 100);
  const rpc = createRpcClient(config);
  const utxos = await rpc('listunspent', [0, 9999999]);
  const matureSpendable = utxos.filter((u) =>
    u.spendable !== false &&
    u.solvable !== false &&
    Number(u.confirmations || 0) >= minConfirmations
  );
  console.log(JSON.stringify({
    total: utxos.length,
    matureSpendable: matureSpendable.length,
    minConfirmations,
  }));
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
NODE
}

run_cycle() {
  log "checking wallet UTXO health"
  node scripts/consolidation-worker.js --confirm || true

  local status
  status="$(count_mature_utxos)"
  local mature
  mature="$(node -e 'const s=JSON.parse(process.argv[1]); console.log(s.matureSpendable)' "$status")"
  local max_inputs
  if [ "$mature" -gt "$LARGE_BATCH_THRESHOLD" ]; then
    max_inputs="$LARGE_BATCH_MAX_INPUTS"
  else
    max_inputs="$MAINTENANCE_BATCH_MAX_INPUTS"
  fi
  log "mature_spendable_utxos=${mature} target=${TARGET_UTXOS} large_threshold=${LARGE_BATCH_THRESHOLD} max_inputs=${max_inputs}"

  if [ "$mature" -le "$TARGET_UTXOS" ]; then
    log "wallet is at or below target; skipping consolidation"
    return 0
  fi

  local attempt
  for attempt in $(seq 0 "$BLOCKED_RETRIES"); do
    if [ "$attempt" -gt 0 ]; then
      log "retrying consolidation after payout batch preflight block attempt=${attempt}/${BLOCKED_RETRIES}"
    fi

    log "wallet is above threshold; attempting one live consolidation batch"
    local output
    output="$(
      HEMP0X_POOL_LIVE_CONSOLIDATION_CONFIRM="$LIVE_CONFIRM" \
        node scripts/consolidation-worker.js --process --live --max-batches "$MAX_BATCHES" --max-inputs "$max_inputs" --target-utxos "$TARGET_UTXOS" 2>&1
    )" || true
    printf '%s\n' "$output"

    if printf '%s\n' "$output" | grep -q '"error": "payout_unresolved_batches"'; then
      if [ "$attempt" -lt "$BLOCKED_RETRIES" ]; then
        log "payout batch is in created/broadcasting state; retrying in ${BLOCKED_RETRY_SECONDS}s"
        sleep "$BLOCKED_RETRY_SECONDS"
        continue
      fi
      log "payout batch still unresolved after retries; waiting until next interval"
    fi
    break
  done
}

log "started interval=${INTERVAL_SECONDS}s target=${TARGET_UTXOS} large_threshold=${LARGE_BATCH_THRESHOLD} large_max_inputs=${LARGE_BATCH_MAX_INPUTS} maintenance_max_inputs=${MAINTENANCE_BATCH_MAX_INPUTS} max_batches=${MAX_BATCHES} blocked_retries=${BLOCKED_RETRIES} blocked_retry_seconds=${BLOCKED_RETRY_SECONDS}"

while true; do
  log "waiting for RPC readiness"
  node scripts/wait-for-rpc-ready.js || {
    log "RPC is not ready; retrying after interval"
    sleep "$INTERVAL_SECONDS"
    continue
  }
  run_cycle
  sleep "$INTERVAL_SECONDS"
done
