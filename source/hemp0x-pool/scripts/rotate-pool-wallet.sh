#!/usr/bin/env bash
set -euo pipefail

POOL_DIR="${POOL_DIR:-/srv/hemp0x-pool}"
DATADIR="${HEMP0X_DATADIR:-${XDG_DATA_HOME:-$HOME/.local/share}/hemp0x}"
CONF="${HEMP0X_CONF:-$DATADIR/hemp0x.conf}"
CLI="${HEMP0X_CLI:-hemp0x-cli}"
SERVICE="${HEMP0X_SERVICE:-hemp0xd.service}"
PM2_HOME_DIR="${PM2_HOME_DIR:-/var/lib/hemp0x-pool/.pm2}"
PM2_USER="${PM2_USER:-hemp0xpool}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/hemp0x-pool/wallets}"
BACKUP_OWNER="${BACKUP_OWNER:-root:root}"
POOL_PROCESS="${POOL_PROCESS:-hemp0x-pool}"
CONFIRM_PROCESS="${CONFIRM_PROCESS:-hemp0x-pool-confirmations}"
PAYOUT_PROCESS="${PAYOUT_PROCESS:-hemp0x-pool-payouts}"
CONSOLIDATION_PROCESS="${CONSOLIDATION_PROCESS:-hemp0x-pool-consolidation}"
ADDRESS_LABEL="${ADDRESS_LABEL:-pool-rotation}"
PAYOUT_WALLET_LABEL="${PAYOUT_WALLET_LABEL:-hemp0xpool}"
START_PAYOUTS="${START_PAYOUTS:-0}"
ALLOW_UNRESOLVED_PAYOUTS="${ALLOW_UNRESOLVED_PAYOUTS:-0}"

usage() {
  cat <<EOF
Usage: sudo -E $0 --execute

Rotates the production pool default wallet.dat after payout preflight checks.

Environment overrides:
  POOL_DIR                  default: /srv/hemp0x-pool
  HEMP0X_DATADIR            default: \$XDG_DATA_HOME/hemp0x or \$HOME/.local/share/hemp0x
  HEMP0X_CONF               default: \$HEMP0X_DATADIR/hemp0x.conf
  HEMP0X_CLI                default: hemp0x-cli from PATH
  BACKUP_DIR                default: /var/backups/hemp0x-pool/wallets
  BACKUP_OWNER              default: root:root
  START_PAYOUTS=1           restart payout loop after rotation; default leaves it stopped
  PAYOUT_WALLET_LABEL        daemon account label used by pool.walletLabel; default: hemp0xpool
  ALLOW_UNRESOLVED_PAYOUTS=1 allow rotation with unresolved payout ledger state;
                            only use when payout loop is already stopped and
                            remaining batches are intentionally resumed after funding

The script writes the new address to stdout as NEW_POOL_ADDRESS=...
EOF
}

if [[ "${1:-}" != "--execute" ]]; then
  usage
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run as root or through sudo" >&2
  exit 1
fi

ts="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

run_pm2() {
  sudo -n -u "$PM2_USER" env PM2_HOME="$PM2_HOME_DIR" pm2 "$@" --no-color
}

rpc() {
  timeout "${RPC_TIMEOUT_SECONDS:-90}s" "$CLI" -conf="$CONF" "$@"
}

secure_backup_file() {
  local file="$1"
  chmod 600 "$file"
  chown "$BACKUP_OWNER" "$file" 2>/dev/null || true
}

wait_rpc() {
  local tries="${1:-120}"
  local i
  for ((i = 1; i <= tries; i++)); do
    if rpc getblockcount >/dev/null 2>&1 && rpc getwalletinfo >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "error: RPC did not become ready" >&2
  return 1
}

preflight_payouts_clear() {
  cd "$POOL_DIR"
  sudo -n -u "$PM2_USER" node <<'NODE'
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('pool.db', sqlite3.OPEN_READONLY);
const checks = [
  [
    'active payout runs',
    'SELECT COUNT(*) AS count FROM payout_runs WHERE status IN ("planned","broadcasting","broadcasted")'
  ],
  [
    'unresolved payout batches',
    'SELECT COUNT(*) AS count FROM payout_batches WHERE status IN ("created","broadcasting","broadcasted")'
  ],
];

function get(sql) {
  return new Promise((resolve, reject) => {
    db.get(sql, [], (err, row) => (err ? reject(err) : resolve(row || { count: 0 })));
  });
}

(async () => {
  for (const [label, sql] of checks) {
    const row = await get(sql);
    if (Number(row.count) > 0) {
      throw new Error(`${label} must be zero before wallet rotation; found ${row.count}`);
    }
  }
})()
  .then(() => db.close())
  .catch((err) => {
    console.error(`preflight failed: ${err.message}`);
    db.close();
    process.exit(1);
  });
NODE
}

update_conf_mining_address() {
  local address="$1"
  if grep -q '^miningaddress=' "$CONF"; then
    sed -i.bak-"$ts" "s/^miningaddress=.*/miningaddress=$address/" "$CONF"
  else
    printf '\nminingaddress=%s\n' "$address" >> "$CONF"
  fi
}

update_pool_config_address() {
  local address="$1"
  cd "$POOL_DIR"
  node <<NODE
const fs = require('fs');
const path = 'config.json';
const address = '$address';
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
config.pool = config.pool || {};
config.frontend = config.frontend || {};
config.consolidation = config.consolidation || {};
config.pool.wallet = address;
config.frontend.donationAddress = address;
config.consolidation.destinationAddress = address;
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\\n');
NODE
  chown "$PM2_USER:$PM2_USER" "$POOL_DIR/config.json"
  chmod 600 "$POOL_DIR/config.json"
}

echo "[wallet-rotate] checking payout ledger state"
if [[ "$ALLOW_UNRESOLVED_PAYOUTS" == "1" ]]; then
  echo "[wallet-rotate] WARNING: ALLOW_UNRESOLVED_PAYOUTS=1, skipping payout-clear preflight"
  if run_pm2 pid "$PAYOUT_PROCESS" | grep -qE '^[1-9][0-9]*$'; then
    echo "error: $PAYOUT_PROCESS must be stopped before unresolved-payout rotation" >&2
    exit 1
  fi
  if pgrep -af 'scripts/payout-worker.js --cycle --live' >/dev/null; then
    echo "error: live payout worker process is still running" >&2
    exit 1
  fi
else
  preflight_payouts_clear
fi

echo "[wallet-rotate] stopping pool automation"
run_pm2 stop "$PAYOUT_PROCESS" || true
run_pm2 stop "$CONSOLIDATION_PROCESS" || true
run_pm2 stop "$CONFIRM_PROCESS" || true
run_pm2 stop "$POOL_PROCESS" || true

echo "[wallet-rotate] waiting for current wallet RPC"
wait_rpc 60

old_wallet="$DATADIR/wallet.dat"
old_backup="$BACKUP_DIR/poolwallet-current-before-rotation-$ts.dat"
old_archive="$DATADIR/wallet.dat.archived-$ts"

echo "[wallet-rotate] backing up current wallet to $old_backup"
rpc backupwallet "$old_backup"
secure_backup_file "$old_backup"

echo "[wallet-rotate] stopping $SERVICE"
systemctl stop "$SERVICE"

if [[ -e "$old_wallet" ]]; then
  echo "[wallet-rotate] archiving $old_wallet to $old_archive"
  mv "$old_wallet" "$old_archive"
  chmod 600 "$old_archive"
fi

echo "[wallet-rotate] starting $SERVICE with fresh wallet"
systemctl start "$SERVICE"
wait_rpc 180

new_address="$(rpc getnewaddress "$ADDRESS_LABEL-$ts" | tr -d '[:space:]')"
if [[ ! "$new_address" =~ ^R[1-9A-HJ-NP-Za-km-z]{25,34}$ ]]; then
  echo "error: generated address does not look like a Hemp0x address: $new_address" >&2
  exit 1
fi

echo "[wallet-rotate] assigning $new_address to payout wallet label $PAYOUT_WALLET_LABEL"
rpc setaccount "$new_address" "$PAYOUT_WALLET_LABEL" >/dev/null

new_backup="$BACKUP_DIR/poolwallet-${new_address:0:3}-${new_address: -3}-$ts.dat"
echo "[wallet-rotate] backing up fresh wallet to $new_backup"
rpc backupwallet "$new_backup"
secure_backup_file "$new_backup"

echo "[wallet-rotate] updating Core miningaddress and pool config"
update_conf_mining_address "$new_address"
update_pool_config_address "$new_address"

echo "[wallet-rotate] restarting $SERVICE so miningaddress is active"
systemctl restart "$SERVICE"
wait_rpc 180

echo "[wallet-rotate] starting pool and confirmation services"
run_pm2 start "$POOL_PROCESS"
run_pm2 start "$CONFIRM_PROCESS"

if [[ "$START_PAYOUTS" == "1" ]]; then
  echo "[wallet-rotate] START_PAYOUTS=1, starting payout loop"
  run_pm2 start "$PAYOUT_PROCESS"
else
  echo "[wallet-rotate] leaving payout loop stopped until the new wallet is funded"
fi

echo "NEW_POOL_ADDRESS=$new_address"
echo "NEW_WALLET_BACKUP=$new_backup"
echo "OLD_WALLET_BACKUP=$old_backup"
echo "OLD_WALLET_ARCHIVE=$old_archive"
