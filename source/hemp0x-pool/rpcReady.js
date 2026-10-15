const { sanitizeError } = require('./configRedaction');

function isWarmupRpcError(error) {
  const message = error?.message || String(error || '');
  return (
    message.includes('"code":-28') ||
    /Loading block index|Rewinding blocks|Verifying blocks|Loading wallet|Verifying wallet|Warmup/i.test(message)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRpcReady({ rpc, timeoutMs = 300000, intervalMs = 5000, requireWallet = true, log = console.log } = {}) {
  if (typeof rpc !== 'function') {
    throw new Error('waitForRpcReady requires an rpc function');
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const height = await rpc('getblockcount', []);
      if (requireWallet) {
        await rpc('getwalletinfo', []);
      }
      return { ready: true, height: Number(height) || 0 };
    } catch (error) {
      lastError = error;
      const clean = sanitizeError(error);
      if (!isWarmupRpcError(error)) {
        log(`[rpc-ready] waiting for RPC readiness: ${clean}`);
      }
      await sleep(intervalMs);
    }
  }

  throw new Error(`RPC did not become ready within ${timeoutMs}ms: ${sanitizeError(lastError)}`);
}

module.exports = {
  isWarmupRpcError,
  waitForRpcReady,
};
