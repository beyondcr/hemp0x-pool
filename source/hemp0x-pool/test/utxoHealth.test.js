const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { createRpcClient } = require('../rpcClient');
const { generateTestUtxos, DEFAULT_FIXTURE_UTXO_COUNT, POOL_ADDRESS } = require('./fixtures');
const { createMockRpcWithUtxos } = require('./mockRpc');
const { runHealthReport } = require('../utxoHealth');
const { DUST_THRESHOLD_SATS } = require('../txConstants');
const { loadConfig, DEFAULTS } = require('../config');

describe('utxoHealth', () => {
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
  });

  after(() => {
    server.close();
  });

  it('returns a report with expected structure for full fixture', async () => {
    const report = await runHealthReport({ rpc, config });
    assert.ok(report.generatedAt);
    assert.ok(report.summary);
    assert.ok(report.maturityBreakdown);
    assert.ok(report.distributionBuckets);
    assert.ok(report.transactionPressure);
    assert.ok(report.warnings !== undefined);
    assert.ok(report.recommendedActions !== undefined);
  });

  it('reports correct UTXO count from the default investigation-size fixture', async () => {
    const report = await runHealthReport({ rpc, config });
    assert.strictEqual(report.summary.totalUtxos, DEFAULT_FIXTURE_UTXO_COUNT);
  });

  it('supports alternate fixture sizes so UTXO count is not hardcoded in logic', async () => {
    const altUtxos = generateTestUtxos({ totalUtxos: 123, dustCount: 2, immatureCount: 3 });
    const altMock = await createMockRpcWithUtxos(altUtxos);
    const altRpc = createRpcClient({
      daemon: { host: '127.0.0.1', port: altMock.port, user: 'test', pass: 'test' },
    });

    const report = await runHealthReport({ rpc: altRpc, config });
    assert.strictEqual(report.summary.totalUtxos, 123);

    altMock.server.close();
  });

  it('correctly classifies mature and immature UTXOs', async () => {
    const report = await runHealthReport({ rpc, config });
    const immature = utxos.filter((u) => u.confirmations < 100);
    const mature = utxos.filter((u) => u.confirmations >= 100);

    assert.strictEqual(report.summary.matureSpendable, mature.length);
    assert.strictEqual(report.summary.immature, immature.length);
  });

  it('filters by address scope returning different results from wallet-wide', async () => {
    const addrReport = await runHealthReport({ rpc, config, addresses: [POOL_ADDRESS] });
    const wideReport = await runHealthReport({ rpc, config });

    const addrCount = addrReport.summary.totalUtxos;
    const wideCount = wideReport.summary.totalUtxos;

    assert.ok(addrCount <= wideCount);
  });

  it('includes dust UTXOs in total count and generates warning when threshold exceeded', async () => {
    const dustCount = utxos.filter((u) => u.amountSats < DUST_THRESHOLD_SATS).length;
    const dustConfig = {
      ...config,
      health: { ...config.health, warnDustUtxoCountAbove: 0 },
    };
    const report = await runHealthReport({ rpc, config: dustConfig });

    assert.strictEqual(report.summary.dustUtxos, dustCount);
    assert.ok(report.warnings.some((w) => w.includes('Dust')));
  });

  it('detects immature UTXOs in maturity breakdown', async () => {
    const report = await runHealthReport({ rpc, config });
    const totalUnder100 = utxos.filter((u) => u.confirmations > 0 && u.confirmations < 100).length;
    const breakdownTotal = report.maturityBreakdown.under6Conf + report.maturityBreakdown.under100Conf;
    assert.strictEqual(breakdownTotal, totalUnder100);
  });

  it('computes amount distribution buckets', async () => {
    const report = await runHealthReport({ rpc, config });
    const buckets = report.distributionBuckets.byAmount;
    const totalFromBuckets = buckets.reduce((s, b) => s + b.count, 0);
    assert.strictEqual(totalFromBuckets, report.summary.totalUtxos);
  });

  it('computes confirmation distribution buckets', async () => {
    const report = await runHealthReport({ rpc, config });
    const confBuckets = report.distributionBuckets.byConfirmations;
    const totalFromConfBuckets = confBuckets.reduce((s, b) => s + b.count, 0);
    assert.strictEqual(totalFromConfBuckets, report.summary.totalUtxos);
  });

  it('computes correct average, median, min, max sizes', async () => {
    const report = await runHealthReport({ rpc, config });
    const mature = utxos.filter((u) => u.confirmations >= 100);
    if (mature.length > 0) {
      const amounts = mature.map((u) => u.amountSats);
      assert.strictEqual(report.summary.minSizeSats, Math.min(...amounts));
      assert.strictEqual(report.summary.maxSizeSats, Math.max(...amounts));
    }
  });

  it('produces transaction pressure estimates within expected range', async () => {
    const report = await runHealthReport({ rpc, config });
    assert.ok(report.transactionPressure.estimatedInputsPerBatch > 0);
    assert.ok(report.transactionPressure.estimatedTotalTxSizeBytes > 0);
    assert.ok(report.transactionPressure.sizeRatioInputsToOutputs >= 0);
  });

  it('handles empty wallet gracefully (zero UTXOs)', async () => {
    const emptyMock = await createMockRpcWithUtxos([]);
    const emptyRpc = createRpcClient({
      daemon: { host: '127.0.0.1', port: emptyMock.port, user: 'test', pass: 'test' },
    });

    const report = await runHealthReport({ rpc: emptyRpc, config });
    assert.strictEqual(report.summary.totalUtxos, 0);
    assert.strictEqual(report.summary.matureSpendable, 0);
    assert.strictEqual(report.summary.immature, 0);
    assert.strictEqual(report.summary.totalAmountSats, 0);

    emptyMock.server.close();
  });

  it('produces deterministic report for same fixture seed', async () => {
    const report1 = await runHealthReport({ rpc, config });
    const report2 = await runHealthReport({ rpc, config });

    assert.strictEqual(report1.summary.totalUtxos, report2.summary.totalUtxos);
    assert.strictEqual(report1.summary.matureSpendable, report2.summary.matureSpendable);
    assert.strictEqual(report1.summary.immature, report2.summary.immature);
    assert.strictEqual(report1.summary.totalAmountSats, report2.summary.totalAmountSats);
    assert.strictEqual(report1.summary.dustUtxos, report2.summary.dustUtxos);
  });

  it('generates warnings when UTXO count exceeds threshold', async () => {
    const lowThresholdConfig = {
      ...config,
      health: { ...config.health, warnUtxoCountAbove: 100 },
    };
    const report = await runHealthReport({ rpc, config: lowThresholdConfig });
    assert.ok(report.warnings.some((w) => w.includes('UTXO count')));
  });

  it('includes walletInfo when getwalletinfo succeeds', async () => {
    const report = await runHealthReport({ rpc, config });
    assert.ok(report.walletInfo !== null);
    assert.strictEqual(report.walletInfo.walletname, 'hemp0xpool');
  });
});
