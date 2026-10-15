const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { submitBlockWithRetry } = require('../server');

describe('submitBlockWithRetry', () => {
  it('retries submitblock failures and returns success', async () => {
    const calls = [];
    const rpc = async (method, params, options) => {
      calls.push({ method, params, options });
      if (calls.length < 3) throw new Error('RPC submitblock timed out');
      return null;
    };

    const result = await submitBlockWithRetry(rpc, 'deadbeef', {
      timeoutMs: 1234,
      retries: 2,
      retryDelayMs: 0,
      logger: { warn: () => {} },
    });

    assert.equal(result.ok, true);
    assert.equal(result.result, null);
    assert.equal(result.attempts, 3);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], {
      method: 'submitblock',
      params: ['deadbeef'],
      options: { timeoutMs: 1234 },
    });
  });

  it('returns a failed result after retry exhaustion', async () => {
    let attempts = 0;
    const rpc = async () => {
      attempts += 1;
      throw new Error('RPC submitblock timed out');
    };

    const result = await submitBlockWithRetry(rpc, 'deadbeef', {
      retries: 1,
      retryDelayMs: 0,
      logger: { warn: () => {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
    assert.match(result.error.message, /timed out/);
  });

  it('does not retry daemon-level submitblock rejections', async () => {
    let attempts = 0;
    const rpc = async () => {
      attempts += 1;
      return 'duplicate';
    };

    const result = await submitBlockWithRetry(rpc, 'deadbeef', {
      retries: 2,
      retryDelayMs: 0,
      logger: { warn: () => {} },
    });

    assert.equal(result.ok, true);
    assert.equal(result.result, 'duplicate');
    assert.equal(result.attempts, 1);
    assert.equal(attempts, 1);
  });
});
