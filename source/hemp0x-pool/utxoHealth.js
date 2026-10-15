const { SATS_PER_HEMP } = require('./constants');
const { DUST_THRESHOLD_SATS, estimateTxSizeBytes } = require('./txConstants');

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

function buildAmountBuckets(utxos) {
  const bucketLabels = [
    { label: '0 - <1 HEMP', minSats: 0, maxSats: SATS_PER_HEMP - 1 },
    { label: '1 - <5 HEMP', minSats: SATS_PER_HEMP, maxSats: 5 * SATS_PER_HEMP - 1 },
    { label: '5 - <10 HEMP', minSats: 5 * SATS_PER_HEMP, maxSats: 10 * SATS_PER_HEMP - 1 },
    { label: '10 - <50 HEMP', minSats: 10 * SATS_PER_HEMP, maxSats: 50 * SATS_PER_HEMP - 1 },
    { label: '50 - <100 HEMP', minSats: 50 * SATS_PER_HEMP, maxSats: 100 * SATS_PER_HEMP - 1 },
    { label: '100+ HEMP', minSats: 100 * SATS_PER_HEMP, maxSats: Number.MAX_SAFE_INTEGER },
  ];

  return bucketLabels.map((b) => {
    const matches = utxos.filter((u) => u.amountSats >= b.minSats && u.amountSats <= b.maxSats);
    return { label: b.label, count: matches.length, total: matches.reduce((s, u) => s + u.amountSats, 0) };
  });
}

function buildConfirmationBuckets(utxos) {
  const bands = [
    { label: '<100', min: 0, max: 99 },
    { label: '100-500', min: 100, max: 500 },
    { label: '500-2000', min: 501, max: 2000 },
    { label: '2000-5000', min: 2001, max: 5000 },
    { label: '5000+', min: 5001, max: Number.MAX_SAFE_INTEGER },
  ];

  return bands.map((b) => ({
    label: b.label,
    count: utxos.filter((u) => u.confirmations >= b.min && u.confirmations <= b.max).length,
  }));
}

function rpcAmountToSats(amount) {
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid RPC amount: ${amount}`);
  }
  return Math.round(amount * SATS_PER_HEMP);
}

function computeTransactionPressure(utxos, config) {
  const payoutBatch = config.payout?.maxPayoutBatch || 50;
  const estimatedInputsPerBatch = Math.min(15, utxos.length);
  const outputCount = payoutBatch + 1;
  const inputTxSize = estimateTxSizeBytes(estimatedInputsPerBatch, 0);
  const totalSize = estimateTxSizeBytes(estimatedInputsPerBatch, outputCount);
  const sizeRatio = inputTxSize / totalSize;

  return {
    estimatedPayoutCountPerBatch: payoutBatch,
    estimatedTxSizePerBatchBytes: estimateTxSizeBytes(0, outputCount),
    estimatedInputsPerBatch,
    estimatedInputTxSizeBytes: inputTxSize,
    estimatedTotalTxSizeBytes: totalSize,
    sizeRatioInputsToOutputs: parseFloat(sizeRatio.toFixed(2)),
    recommendedBatchCount: Math.ceil(utxos.length / estimatedInputsPerBatch),
    utxosRequiredForOneBatch: estimatedInputsPerBatch,
  };
}

function buildMaturityBreakdown(utxos, maturityConfirmations) {
  const coinbaseUnspendable = utxos.filter((u) => u.confirmations < 1).length;
  const under6 = utxos.filter((u) => u.confirmations >= 1 && u.confirmations < 6).length;
  const underMaturity = utxos.filter((u) => u.confirmations >= 6 && u.confirmations < maturityConfirmations).length;
  const mature = utxos.filter((u) => u.confirmations >= maturityConfirmations).length;

  return {
    coinbaseUnspendable,
    under6Conf: under6,
    under100Conf: underMaturity,
    mature,
  };
}

function generateWarnings(utxos, matureUtxos, dustUtxos, config) {
  const warnings = [];
  const health = config.health || {};
  const warnAbove = health.warnUtxoCountAbove ?? 10000;
  const warnBelow = health.warnUtxoCountBelow ?? 100;
  const warnDust = health.warnDustUtxoCountAbove ?? 500;
  const warnBalance = health.warnBalanceBelowSats ?? 100000000000;

  const totalSats = matureUtxos.reduce((s, u) => s + u.amountSats, 0);

  if (utxos.length > warnAbove) {
    warnings.push(`UTXO count (${utxos.length}) exceeds warning threshold (${warnAbove}). Consider consolidation.`);
  }
  if (utxos.length < warnBelow) {
    warnings.push(`UTXO count (${utxos.length}) below minimum threshold (${warnBelow}).`);
  }
  if (dustUtxos.length > warnDust) {
    warnings.push(`Dust UTXO count (${dustUtxos.length}) exceeds warning threshold (${warnDust}).`);
  }
  if (totalSats < warnBalance) {
    warnings.push(`Mature balance (${totalSats} sats) below warning threshold (${warnBalance} sats).`);
  }

  return warnings;
}

/**
 * Run a read-only UTXO health report.
 * @param {object} options
 * @param {function} options.rpc - RPC client function (rpc(method, params) => Promise<any>)
 * @param {object} options.config - Merged config object
 * @param {string[]} [options.addresses] - Optional address filter for listunspent
 * @param {string} [options.walletLabel] - Wallet label for context (not used in RPC directly)
 * @returns {Promise<object>} Health report object
 */
async function runHealthReport({ rpc, config, addresses, walletLabel }) {
  const maturityConfirmations = config.health?.maturityConfirmations || 100;

  const listParams = [0, 9999999];
  if (addresses && addresses.length > 0) {
    listParams.push(addresses);
  }

  const rpcUtxos = await rpc('listunspent', listParams);

  const utxos = rpcUtxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    amountSats: rpcAmountToSats(u.amount),
    amount: u.amount,
    confirmations: u.confirmations,
    address: u.address || '',
    spendable: u.spendable !== false,
    solvable: u.solvable !== false,
  }));

  const matureUtxos = utxos.filter((u) => u.confirmations >= maturityConfirmations);
  const immatureUtxos = utxos.filter((u) => u.confirmations < maturityConfirmations);
  const dustUtxos = utxos.filter((u) => u.amountSats < DUST_THRESHOLD_SATS);

  const amounts = matureUtxos.map((u) => u.amountSats);
  const confs = matureUtxos.map((u) => u.confirmations);

  let walletInfo = null;
  try {
    walletInfo = await rpc('getwalletinfo');
  } catch (_e) {
    // getwalletinfo is optional; report still valid without it
  }

  const summary = {
    totalUtxos: utxos.length,
    matureSpendable: matureUtxos.length,
    immature: immatureUtxos.length,
    totalAmountSats: matureUtxos.reduce((s, u) => s + u.amountSats, 0),
    averageSizeSats: amounts.length > 0 ? Math.round(amounts.reduce((s, v) => s + v, 0) / amounts.length) : 0,
    medianSizeSats: median(amounts),
    minSizeSats: amounts.length > 0 ? Math.min(...amounts) : 0,
    maxSizeSats: amounts.length > 0 ? Math.max(...amounts) : 0,
    oldestConfirmations: confs.length > 0 ? Math.max(...confs) : 0,
    newestConfirmations: confs.length > 0 ? Math.min(...confs) : 0,
    dustUtxos: dustUtxos.length,
    dustTotalSats: dustUtxos.reduce((s, u) => s + u.amountSats, 0),
  };

  const maturityBreakdown = buildMaturityBreakdown(utxos, maturityConfirmations);
  const amountBuckets = buildAmountBuckets(utxos);
  const confirmationBuckets = buildConfirmationBuckets(utxos);
  const transactionPressure = computeTransactionPressure(utxos, config);
  const warnings = generateWarnings(utxos, matureUtxos, dustUtxos, config);

  const recommendedActions = [];
  if (utxos.length > (config.health?.warnUtxoCountAbove || 10000)) {
    recommendedActions.push('Consider consolidating small UTXOs into larger outputs.');
  }
  if (dustUtxos.length > 0) {
    recommendedActions.push(`${dustUtxos.length} dust UTXOs detected. Review and consolidate if economical.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    queryParams: {
      minConf: 0,
      maturityConfirmations,
      addresses: addresses || null,
      walletLabel: walletLabel || null,
    },
    summary,
    maturityBreakdown,
    distributionBuckets: {
      byAmount: amountBuckets,
      byConfirmations: confirmationBuckets,
    },
    transactionPressure,
    walletInfo: walletInfo || null,
    warnings,
    recommendedActions,
  };
}

module.exports = { runHealthReport, DUST_THRESHOLD_SATS, estimateTxSizeBytes, rpcAmountToSats };
