const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { createRpcClient } = require('../rpcClient');
const { generateTestUtxos, POOL_ADDRESS } = require('./fixtures');
const { createMockRpcWithUtxos } = require('./mockRpc');
const { planConsolidation } = require('../consolidationPlanner');
const { DEFAULTS } = require('../config');

describe('consolidationPlanner', () => {
  let server;
  let port;
  let rpc;
  let utxos;
  let config;

  before(async () => {
    utxos = generateTestUtxos();
    const mock = await createMockRpcWithUtxos(utxos);
    server = mock.server;
    port = mock.port;

    rpc = createRpcClient({
      daemon: { host: '127.0.0.1', port, user: 'test', pass: 'test' },
    });

    config = { ...DEFAULTS };
    config.consolidation = { ...config.consolidation };
    config.consolidation.destinationAddress = POOL_ADDRESS;
  });

  after(() => {
    server.close();
  });

  it('rejects missing destinationAddress', async () => {
    const noDestConfig = { ...config };
    noDestConfig.consolidation = { ...config.consolidation, destinationAddress: '' };
    await assert.rejects(
      planConsolidation({ rpc, config: noDestConfig, destinationAddress: '' }),
      /destinationAddress is required/
    );
  });

  it('rejects invalid destination address format', async () => {
    await assert.rejects(
      planConsolidation({ rpc, config, destinationAddress: 'invalid123' }),
      /Invalid destination address/
    );
  });

  it('throws if consolidation.enabled is true (safety gate)', async () => {
    const badConfig = {
      ...config,
      consolidation: { ...config.consolidation, enabled: true },
    };
    await assert.rejects(
      planConsolidation({ rpc, config: badConfig, destinationAddress: POOL_ADDRESS }),
      /Consolidation is not enabled by the current safety gates/
    );
  });

  it('throws if consolidation.dryRunOnly is false (safety gate)', async () => {
    const badConfig = {
      ...config,
      consolidation: { ...config.consolidation, dryRunOnly: false },
    };
    await assert.rejects(
      planConsolidation({ rpc, config: badConfig, destinationAddress: POOL_ADDRESS }),
      /Consolidation must remain dry-run under the current safety gates/
    );
  });

  it('produces a plan with batches for the default investigation-size fixture', async () => {
    const plan = await planConsolidation({ rpc, config, destinationAddress: POOL_ADDRESS });

    assert.ok(plan.generatedAt);
    assert.ok(plan.totalCandidates > 0);
    assert.ok(plan.reserved >= 0);
    assert.ok(plan.batches.length > 0);
    assert.ok(plan.operatorChecklist.length > 0);

    const firstBatch = plan.batches[0];
    assert.ok(firstBatch.selectedInputs.length > 0);
    assert.ok(firstBatch.selectedInputs.length <= config.consolidation.maxInputsPerBatch);
    assert.strictEqual(firstBatch.destinationAddress, POOL_ADDRESS);
    assert.ok(firstBatch.totalInputSats > 0);
    assert.ok(firstBatch.estimatedFeeSats > 0);
    assert.ok(firstBatch.estimatedTxSizeBytes > 0);
    assert.strictEqual(firstBatch.expectedOutputCount, 1);
  });

  it('enforces reserve policy - retains at least minUtxosToKeep UTXOs', async () => {
    const plan = await planConsolidation({ rpc, config, destinationAddress: POOL_ADDRESS });
    const defaultMinKeep = config.consolidation.reservePolicy.minUtxosToKeep;
    const totalConsolidated = plan.batches.reduce((s, b) => s + b.selectedInputs.length, 0);

    assert.ok(plan.reserved >= defaultMinKeep);
    assert.ok(totalConsolidated <= plan.totalCandidates - defaultMinKeep);
  });

  it('allows a lower maintenance reserve target for post-bulk cleanup', async () => {
    const maintenanceConfig = {
      ...config,
      consolidation: {
        ...config.consolidation,
        maxInputsPerBatch: 50,
        reservePolicy: {
          ...config.consolidation.reservePolicy,
          minUtxosToKeep: 200,
        },
      },
    };
    const plan = await planConsolidation({ rpc, config: maintenanceConfig, destinationAddress: POOL_ADDRESS });

    assert.ok(plan.reserved >= 200);
    assert.ok(plan.totalCandidates > 200);
    assert.ok(plan.batches.length > 0);
    assert.ok(plan.batches[0].selectedInputs.length <= 50);
  });

  it('enforces maxInputsPerBatch (200) on each batch', async () => {
    const limitConfig = {
      ...config,
      consolidation: { ...config.consolidation, maxInputsPerBatch: 50 },
    };
    const plan = await planConsolidation({ rpc, config: limitConfig, destinationAddress: POOL_ADDRESS });

    for (const batch of plan.batches) {
      assert.ok(batch.selectedInputs.length <= 50);
    }
  });

  it('enforces maxTxSizeBytes by limiting batch size', async () => {
    const sizeConfig = {
      ...config,
      consolidation: { ...config.consolidation, maxTxSizeBytes: 50000 },
    };
    const plan = await planConsolidation({ rpc, config: sizeConfig, destinationAddress: POOL_ADDRESS });

    for (const batch of plan.batches) {
      assert.ok(batch.estimatedTxSizeBytes <= 51000);
    }
  });

  it('falls back to config fee rate when smart fee estimate fails', async () => {
    const noFeeConfig = {
      ...config,
      consolidation: {
        ...config.consolidation,
        useSmartFeeEstimate: false,
        feeRateSatsPerByte: 5,
      },
    };
    const plan = await planConsolidation({ rpc, config: noFeeConfig, destinationAddress: POOL_ADDRESS });

    for (const batch of plan.batches) {
      assert.ok(batch.estimatedFeeSats > 0);
    }
    assert.strictEqual(plan.configSnapshot.feeRateSatsPerByte, 5);
  });

  it('returns empty plan with no candidates when all UTXOs are immature', async () => {
    const immatureUtxos = utxos.map((u) => ({ ...u, confirmations: 1 }));
    const emptyMock = await createMockRpcWithUtxos(immatureUtxos);
    const emptyRpc = createRpcClient({
      daemon: { host: '127.0.0.1', port: emptyMock.port, user: 'test', pass: 'test' },
    });

    const plan = await planConsolidation({ rpc: emptyRpc, config, destinationAddress: POOL_ADDRESS });

    assert.strictEqual(plan.totalCandidates, 0);
    assert.strictEqual(plan.batches.length, 0);
    assert.ok(plan.warnings.length > 0);

    emptyMock.server.close();
  });

  it('includes post-consolidation shape in each batch plan', async () => {
    const plan = await planConsolidation({ rpc, config, destinationAddress: POOL_ADDRESS });

    for (const batch of plan.batches) {
      assert.ok(batch.expectedPostConsolidationShape);
      assert.strictEqual(typeof batch.expectedPostConsolidationShape.totalUtxos, 'number');
      assert.strictEqual(typeof batch.expectedPostConsolidationShape.matureSpendable, 'number');
      assert.strictEqual(typeof batch.expectedPostConsolidationShape.totalAmountSats, 'number');
    }
  });

  it('produces deterministic output for same fixture', async () => {
    const plan1 = await planConsolidation({ rpc, config, destinationAddress: POOL_ADDRESS });
    const plan2 = await planConsolidation({ rpc, config, destinationAddress: POOL_ADDRESS });

    assert.strictEqual(plan1.totalCandidates, plan2.totalCandidates);
    assert.strictEqual(plan1.reserved, plan2.reserved);
    assert.strictEqual(plan1.reservedSats, plan2.reservedSats);
    assert.strictEqual(plan1.batches.length, plan2.batches.length);
    assert.strictEqual(plan1.totalInputs, plan2.totalInputs);
    assert.strictEqual(plan1.totalInputSats, plan2.totalInputSats);
  });

  it('has no broadcast path - no signing or raw tx creation functions exposed', () => {
    const module = require('../consolidationPlanner');
    assert.strictEqual(typeof module.planConsolidation, 'function');
    assert.ok(module.planConsolidation.toString().indexOf('sendrawtransaction') === -1);
    assert.ok(module.planConsolidation.toString().indexOf('signrawtransaction') === -1);
    assert.ok(module.planConsolidation.toString().indexOf('createrawtransaction') === -1);
  });

  it('includes operator checklist in the plan', async () => {
    const plan = await planConsolidation({ rpc, config, destinationAddress: POOL_ADDRESS });

    assert.ok(Array.isArray(plan.operatorChecklist));
    assert.ok(plan.operatorChecklist.length >= 7);
    assert.ok(plan.operatorChecklist.every((item) => item.id && item.description));
  });

  it('batches are ordered by batchIndex', async () => {
    const plan = await planConsolidation({ rpc, config, destinationAddress: POOL_ADDRESS });

    for (let i = 0; i < plan.batches.length; i++) {
      assert.strictEqual(plan.batches[i].batchIndex, i);
    }
  });

  it('sorts selected inputs by oldest confirmations first, then smaller amounts', async () => {
    const customUtxos = [
      { txid: 'a'.repeat(64), vout: 0, amount: 10, confirmations: 500, address: POOL_ADDRESS, spendable: true, solvable: true },
      { txid: 'b'.repeat(64), vout: 0, amount: 10, confirmations: 900, address: POOL_ADDRESS, spendable: true, solvable: true },
      { txid: 'c'.repeat(64), vout: 0, amount: 50, confirmations: 900, address: POOL_ADDRESS, spendable: true, solvable: true },
    ];
    const customMock = await createMockRpcWithUtxos(customUtxos);
    const customRpc = createRpcClient({
      daemon: { host: '127.0.0.1', port: customMock.port, user: 'test', pass: 'test' },
    });
    const customConfig = {
      ...config,
      consolidation: {
        ...config.consolidation,
        reservePolicy: { minUtxosToKeep: 0, minTotalReserveSats: 0, maxUtxoSizeToKeepSats: 0 },
      },
    };

    const plan = await planConsolidation({ rpc: customRpc, config: customConfig, destinationAddress: POOL_ADDRESS });
    assert.strictEqual(plan.batches[0].selectedInputs[0].txid, 'b'.repeat(64));
    assert.strictEqual(plan.batches[0].selectedInputs[1].txid, 'c'.repeat(64));
    assert.strictEqual(plan.batches[0].selectedInputs[2].txid, 'a'.repeat(64));

    customMock.server.close();
  });
});
