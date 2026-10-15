/**
 * Patterns indicating transient daemon RPC overload or connectivity issues.
 * These are safe to retry because the operation did not (or may not have) executed.
 */
const TRANSIENT_ERROR_PATTERNS = [
  'Work queue depth exceeded',
  'RPC request timed out',
  'timed out',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'socket hang up',
  'read ECONNRESET',
];

/**
 * RPC methods that are SAFE to retry on transient failure because they are
 * read-only / idempotent. A retry either returns the same result or fails again.
 */
const SAFE_TO_RETRY_METHODS = new Set([
  'getbalance',
  'gettransaction',
  'getblockcount',
  'getwalletinfo',
  'getblockchaininfo',
  'listunspent',
]);

/**
 * RPC methods that must NEVER be retried on transient failure because
 * the original call may have succeeded on the daemon side even though
 * the response was lost. Retrying risks double-spend / double-payment.
 */
const UNSAFE_TO_RETRY_METHODS = new Set([
  'sendmany',
  'sendtoaddress',
  'sendrawtransaction',
  'createrawtransaction',
  'signrawtransaction',
  'signrawtransactionwithwallet',
]);

function isTransientRpcError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

function isSafeToRetry(method) {
  if (UNSAFE_TO_RETRY_METHODS.has(method)) return false;
  if (SAFE_TO_RETRY_METHODS.has(method)) return true;
  // For unknown methods, err on the side of NOT retrying
  return false;
}

/**
 * Create a paced, transient-retry-aware RPC wrapper for payout operations.
 *
 * Behaviour:
 *   - Inserts a configurable delay between consecutive RPC calls so the
 *     daemon's work queue can drain between payout reads/writes.
 *   - On transient errors (Work queue depth exceeded, timeouts, connection
 *     resets) for read-only methods, retries with bounded exponential backoff.
 *   - NEVER retries write methods (sendmany etc.) to prevent double-payment.
 *   - Non-transient errors propagate immediately.
 *
 * @param {function} baseRpc - The underlying (method, params) => Promise RPC caller
 * @param {object} [options]
 * @param {number} [options.delayMs=500] - Minimum ms between consecutive RPC calls
 * @param {number} [options.maxRetries=2] - Max retries for transient errors on safe methods
 * @param {number} [options.backoffMs=2000] - Base backoff in ms (doubled each retry)
 * @param {function} [options.logger] - Optional logger (defaults to console)
 * @returns {function} Paced RPC caller with same (method, params) => Promise signature
 */
function createPacedRpc(baseRpc, options = {}) {
  const delayMs = options.delayMs ?? 500;
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 2000;
  const log = options.logger || console;

  let lastCallTime = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pacedRpc(method, params = []) {
    // Enforce minimum delay between consecutive calls
    const now = Date.now();
    const elapsed = now - lastCallTime;
    if (elapsed < delayMs) {
      await sleep(delayMs - elapsed);
    }

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        lastCallTime = Date.now();
        const result = await baseRpc(method, params);
        return result;
      } catch (err) {
        lastErr = err;

        if (!isTransientRpcError(err)) {
          throw err;
        }

        if (!isSafeToRetry(method)) {
          throw err;
        }

        if (attempt < maxRetries) {
          const backoff = backoffMs * Math.pow(2, attempt);
          log.warn(
            `[payoutRpcPacing] Transient RPC error on ${method} (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}; retrying in ${backoff}ms`
          );
          await sleep(backoff);
        } else {
          log.warn(
            `[payoutRpcPacing] Transient RPC error on ${method} exhausted ${maxRetries + 1} attempts: ${err.message}`
          );
        }
      }
    }

    throw lastErr;
  }

  return pacedRpc;
}

module.exports = {
  createPacedRpc,
  isTransientRpcError,
  isSafeToRetry,
  SAFE_TO_RETRY_METHODS,
  UNSAFE_TO_RETRY_METHODS,
  TRANSIENT_ERROR_PATTERNS,
};
