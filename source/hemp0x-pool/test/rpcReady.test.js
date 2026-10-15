const test = require('node:test');
const assert = require('node:assert/strict');
const { isWarmupRpcError, waitForRpcReady } = require('../rpcReady');

test('isWarmupRpcError recognizes daemon warm-up messages', () => {
  assert.equal(isWarmupRpcError(new Error('RPC getblockcount HTTP 500: {"error":{"code":-28,"message":"Loading wallet..."}}')), true);
  assert.equal(isWarmupRpcError(new Error('RPC getblocktemplate HTTP 500: {"error":{"code":-28,"message":"Rewinding blocks..."}}')), true);
  assert.equal(isWarmupRpcError(new Error('RPC getblockcount HTTP 401: unauthorized')), false);
});

test('waitForRpcReady waits through warm-up errors and returns height', async () => {
  let calls = 0;
  const rpc = async (method) => {
    calls += 1;
    if (calls <= 2) {
      throw new Error(`RPC ${method} HTTP 500: {"error":{"code":-28,"message":"Loading block index..."}}`);
    }
    if (method === 'getblockcount') return 123;
    if (method === 'getwalletinfo') return { walletname: 'wallet.dat' };
    throw new Error(`unexpected method ${method}`);
  };

  const result = await waitForRpcReady({ rpc, timeoutMs: 1000, intervalMs: 1, log: () => {} });

  assert.deepEqual(result, { ready: true, height: 123 });
});

test('waitForRpcReady times out when RPC never becomes ready', async () => {
  const rpc = async () => {
    throw new Error('RPC getblockcount HTTP 500: {"error":{"code":-28,"message":"Loading wallet..."}}');
  };

  await assert.rejects(
    () => waitForRpcReady({ rpc, timeoutMs: 5, intervalMs: 1, log: () => {} }),
    /RPC did not become ready/
  );
});
