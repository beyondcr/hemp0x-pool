#!/usr/bin/env node
const db = require('../database');
const { loadConfig } = require('../config');
const { createRpcClient } = require('../rpcClient');
const { MigrationRunner } = require('../migrations');
const { startPayoutEpoch } = require('../payoutEpoch');
const path = require('path');

async function main() {
  const options = process.argv.slice(2);
  const explicitHeight = options.length === 3 && options[1] === '--start-height' ? Number(options[2]) : null;
  if (![1, 3].includes(options.length) || options[0] !== '--archive-and-start' ||
      (options.length === 3 && (!Number.isSafeInteger(explicitHeight) || explicitHeight < 0)) ||
      process.env.HEMP0X_PAYOUT_EPOCH_CONFIRM !== 'I_ACCEPT_ARCHIVING_OLD_PAYOUT_CLAIMS') {
    throw new Error('Requires --archive-and-start and HEMP0X_PAYOUT_EPOCH_CONFIRM=I_ACCEPT_ARCHIVING_OLD_PAYOUT_CLAIMS. Stop the payout worker and back up the database first.');
  }
  const config = loadConfig();
  const rpc = createRpcClient(config);
  const wallet = await rpc('validateaddress', [config.pool.wallet]);
  if (!wallet.isvalid || !wallet.ismine || wallet.iswatchonly) {
    throw new Error('Pool receiving address must belong to the active spendable wallet');
  }
  const tipHeight = await rpc('getblockcount', []);
  const startHeight = explicitHeight ?? tipHeight;
  if (startHeight > tipHeight) throw new Error('Payout boundary is above the current chain tip');
  const startHash = await rpc('getblockhash', [startHeight]);
  const rawDb = db.getConnection();
  await new MigrationRunner(rawDb, path.resolve(__dirname, '..', 'migrations')).applyMigrations();
  const result = await startPayoutEpoch({ db: rawDb, startHeight, startHash, walletAddress: config.pool.wallet });
  console.log(JSON.stringify({ action: 'new_payout_epoch', ...result }));
}

main().catch((error) => {
  console.error('[payout-epoch]', error.message);
  process.exitCode = 1;
}).finally(() => db.getConnection().close(() => {}));
