const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createPacedRpc,
  isTransientRpcError,
  isSafeToRetry,
  SAFE_TO_RETRY_METHODS,
  UNSAFE_TO_RETRY_METHODS,
  TRANSIENT_ERROR_PATTERNS,
} = require('../payoutRpcPacing');

// ---------------------------------------------------------------------------
// isTransientRpcError
// ---------------------------------------------------------------------------
describe('isTransientRpcError', () => {
  it('returns true for Work queue depth exceeded', () => {
    assert.equal(isTransientRpcError(new Error('RPC getkawpowhash HTTP 500: Work queue depth exceeded')), true);
  });

  it('returns true for timeout errors', () => {
    assert.equal(isTransientRpcError(new Error('RPC getbalance timed out')), true);
    assert.equal(isTransientRpcError(new Error('ETIMEDOUT')), true);
  });

  it('returns true for connection reset', () => {
    assert.equal(isTransientRpcError(new Error('read ECONNRESET')), true);
    assert.equal(isTransientRpcError(new Error('socket hang up')), true);
  });

  it('returns false for non-transient errors', () => {
    assert.equal(isTransientRpcError(new Error('insufficient funds')), false);
    assert.equal(isTransientRpcError(new Error('transaction not found')), false);
    assert.equal(isTransientRpcError(new Error('RPC getbalance HTTP 403: Forbidden')), false);
  });

  it('returns false for null/undefined', () => {
    assert.equal(isTransientRpcError(null), false);
    assert.equal(isTransientRpcError(undefined), false);
  });

  it('covers all defined transient patterns', () => {
    for (const pattern of TRANSIENT_ERROR_PATTERNS) {
      assert.equal(isTransientRpcError(new Error(pattern)), true, `Pattern "${pattern}" should be transient`);
    }
  });
});

// ---------------------------------------------------------------------------
// isSafeToRetry
// ---------------------------------------------------------------------------
describe('isSafeToRetry', () => {
  it('returns true for read-only methods', () => {
    assert.equal(isSafeToRetry('getbalance'), true);
    assert.equal(isSafeToRetry('gettransaction'), true);
    assert.equal(isSafeToRetry('getblockcount'), true);
    assert.equal(isSafeToRetry('listunspent'), true);
  });

  it('returns false for write methods', () => {
    assert.equal(isSafeToRetry('sendmany'), false);
    assert.equal(isSafeToRetry('sendtoaddress'), false);
    assert.equal(isSafeToRetry('sendrawtransaction'), false);
  });

  it('returns false for unknown methods (safe default)', () => {
    assert.equal(isSafeToRetry('unknown_method'), false);
  });

  it('all safe methods are actually in the set', () => {
    const expected = ['getbalance', 'gettransaction', 'getblockcount', 'getwalletinfo', 'getblockchaininfo', 'listunspent'];
    for (const m of expected) {
      assert.equal(isSafeToRetry(m), true, `${m} should be safe to retry`);
    }
  });

  it('all unsafe methods are actually in the set', () => {
    const expected = ['sendmany', 'sendtoaddress', 'sendrawtransaction', 'createrawtransaction', 'signrawtransaction', 'signrawtransactionwithwallet'];
    for (const m of expected) {
      assert.equal(isSafeToRetry(m), false, `${m} must NOT be safe to retry`);
    }
  });
});

// ---------------------------------------------------------------------------
// createPacedRpc
// ---------------------------------------------------------------------------
describe('createPacedRpc', () => {
  it('calls the underlying rpc and returns the result', async () => {
    const baseRpc = async (method, params) => {
      if (method === 'getbalance') return 42.5;
      return null;
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 0 });
    const result = await rpc('getbalance');
    assert.equal(result, 42.5);
  });

  it('passes method and params to baseRpc', async () => {
    const calls = [];
    const baseRpc = async (method, params) => {
      calls.push({ method, params });
      return 'ok';
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 0 });
    await rpc('gettransaction', ['txid123']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'gettransaction');
    assert.deepEqual(calls[0].params, ['txid123']);
  });

  it('retries transient errors on safe methods up to maxRetries', async () => {
    let callCount = 0;
    const baseRpc = async (method) => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('RPC getbalance HTTP 500: Work queue depth exceeded');
      }
      return 99.9;
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 2, backoffMs: 10 });
    const result = await rpc('getbalance');
    assert.equal(result, 99.9);
    assert.equal(callCount, 3); // 1 initial + 2 retries
  });

  it('does NOT retry sendmany even on transient error', async () => {
    let callCount = 0;
    const baseRpc = async (method) => {
      callCount++;
      throw new Error('RPC sendmany HTTP 500: Work queue depth exceeded');
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 3, backoffMs: 10 });
    await assert.rejects(() => rpc('sendmany'), /Work queue depth exceeded/);
    assert.equal(callCount, 1, 'sendmany must not be retried');
  });

  it('does NOT retry non-transient errors', async () => {
    let callCount = 0;
    const baseRpc = async (method) => {
      callCount++;
      throw new Error('insufficient funds');
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 3, backoffMs: 10 });
    await assert.rejects(() => rpc('getbalance'), /insufficient funds/);
    assert.equal(callCount, 1, 'non-transient error must not be retried');
  });

  it('throws after exhausting retries', async () => {
    let callCount = 0;
    const baseRpc = async (method) => {
      callCount++;
      throw new Error('RPC gettransaction HTTP 500: Work queue depth exceeded');
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 2, backoffMs: 10 });
    await assert.rejects(() => rpc('gettransaction'), /Work queue depth exceeded/);
    assert.equal(callCount, 3); // 1 initial + 2 retries
  });

  it('enforces minimum delay between consecutive calls', async () => {
    const timestamps = [];
    const baseRpc = async (method) => {
      timestamps.push(Date.now());
      return 'ok';
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 50, maxRetries: 0 });
    await rpc('getbalance');
    await rpc('gettransaction');
    await rpc('getblockcount');
    assert.ok(timestamps.length === 3);
    // Each call should be at least 50ms apart
    assert.ok(timestamps[1] - timestamps[0] >= 40, `Gap 0-1: ${timestamps[1] - timestamps[0]}ms`);
    assert.ok(timestamps[2] - timestamps[1] >= 40, `Gap 1-2: ${timestamps[2] - timestamps[1]}ms`);
  });

  it('logs warnings on transient retry', async () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    let callCount = 0;
    const baseRpc = async (method) => {
      callCount++;
      if (callCount === 1) throw new Error('RPC getbalance HTTP 500: Work queue depth exceeded');
      return 100;
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 2, backoffMs: 10, logger });
    const result = await rpc('getbalance');
    assert.equal(result, 100);
    assert.ok(warnings.length >= 1, 'Should have logged a warning');
    assert.ok(warnings[0].includes('getbalance'));
    assert.ok(warnings[0].includes('retrying'));
  });

  it('logs exhaustion warning when retries exhausted', async () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    const baseRpc = async () => {
      throw new Error('RPC gettransaction HTTP 500: Work queue depth exceeded');
    };
    const rpc = createPacedRpc(baseRpc, { delayMs: 0, maxRetries: 1, backoffMs: 10, logger });
    await assert.rejects(() => rpc('gettransaction'));
    assert.ok(warnings.length >= 1, 'Should have logged exhaustion warning');
    assert.ok(warnings.some((w) => w.includes('exhausted')));
  });
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------
describe('payoutRpcPacing config defaults', () => {
  it('DEFAULTS.payout contains rpcDelayMs, rpcTransientRetries, rpcTransientBackoffMs', () => {
    const { DEFAULTS } = require('../config');
    assert.equal(typeof DEFAULTS.payout.rpcDelayMs, 'number');
    assert.ok(DEFAULTS.payout.rpcDelayMs > 0);
    assert.equal(typeof DEFAULTS.payout.rpcTransientRetries, 'number');
    assert.ok(DEFAULTS.payout.rpcTransientRetries >= 0);
    assert.equal(typeof DEFAULTS.payout.rpcTransientBackoffMs, 'number');
    assert.ok(DEFAULTS.payout.rpcTransientBackoffMs > 0);
  });
});
