#!/usr/bin/env node

const { loadConfig } = require('../config');
const { createRpcClient } = require('../rpcClient');
const { waitForRpcReady } = require('../rpcReady');

function readPositiveInt(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function main() {
  const timeoutMs = readPositiveInt('HEMP0X_RPC_READY_TIMEOUT_MS', 300000);
  const intervalMs = readPositiveInt('HEMP0X_RPC_READY_INTERVAL_MS', 5000);
  const config = loadConfig();
  const rpc = createRpcClient(config);

  const result = await waitForRpcReady({
    rpc,
    timeoutMs,
    intervalMs,
    log: (message) => console.log(message),
  });

  console.log(`[rpc-ready] ready height=${result.height}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
