const { SATS_PER_HEMP } = require('./constants');
const { rpcAmountToSats } = require('./utxoHealth');
const { isP2PKHAddress } = require('./address');
const {
  DUST_THRESHOLD_SATS,
  estimateTxSizeBytes,
  estimateInputTxSizeBytes,
  estimateOutputTxSizeBytes,
} = require('./txConstants');

/**
 * Plan a dry-run consolidation. No signing, no broadcast, no raw tx creation.
 * @param {object} options
 * @param {function} options.rpc - RPC client function (rpc(method, params) => Promise<any>)
 * @param {object} options.config - Merged config object
 * @param {string} options.destinationAddress - Where consolidated funds are sent
 * @param {string} [options.walletLabel] - For logging/reference only
 * @returns {Promise<object>} Dry-run plan object
 */
async function planConsolidation({ rpc, config, destinationAddress, walletLabel, skipGateChecks }) {
  const cc = config.consolidation;
  if (!cc) {
    throw new Error('consolidation config section is missing');
  }
  if (!skipGateChecks) {
    if (cc.enabled !== false) {
      throw new Error('Consolidation is not enabled by the current safety gates');
    }
    if (cc.dryRunOnly !== true) {
      throw new Error('Consolidation must remain dry-run under the current safety gates');
    }
  }

  const effectiveDest = destinationAddress || cc.destinationAddress;
  if (!effectiveDest) {
    throw new Error('destinationAddress is required');
  }
  if (!isP2PKHAddress(effectiveDest)) {
    throw new Error(`Invalid destination address: ${effectiveDest}`);
  }

  const minConfirmations = cc.minConfirmations ?? 100;
  const maxInputsPerBatch = cc.maxInputsPerBatch ?? 200;
  const maxTxSizeBytes = cc.maxTxSizeBytes ?? 80000;
  const reservePolicy = cc.reservePolicy || {};

  const rpcUtxos = await rpc('listunspent', [0, 9999999]);

  const rawUtxos = rpcUtxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    amountSats: rpcAmountToSats(u.amount),
    amount: u.amount,
    confirmations: u.confirmations,
    address: u.address || '',
    spendable: u.spendable !== false,
    solvable: u.solvable !== false,
  }));

  const candidates = rawUtxos.filter(
    (u) =>
      u.confirmations >= minConfirmations &&
      u.amountSats >= DUST_THRESHOLD_SATS &&
      u.spendable &&
      u.solvable
  );

  if (candidates.length === 0) {
    return {
      planId: null,
      generatedAt: new Date().toISOString(),
      totalCandidates: 0,
      reserved: 0,
      batches: [],
      warnings: ['No spendable UTXOs meet maturity and dust criteria.'],
      operatorChecklist: [],
    };
  }

  const sorted = [...candidates].sort((a, b) => b.confirmations - a.confirmations || a.amountSats - b.amountSats);

  const minUtxosToKeep = reservePolicy.minUtxosToKeep ?? 500;
  const minTotalReserveSats = reservePolicy.minTotalReserveSats ?? 200000000000;
  const maxUtxoSizeToKeepSats = reservePolicy.maxUtxoSizeToKeepSats ?? 2000000000;

  const reserveSet = new Set();
  let reservedCount = 0;
  let reservedSats = 0;

  const bySmallest = [...sorted].sort((a, b) => a.amountSats - b.amountSats);
  for (const u of bySmallest) {
    if (reservedCount >= minUtxosToKeep && reservedSats >= minTotalReserveSats) break;
    const key = `${u.txid}:${u.vout}`;
    if (!reserveSet.has(key)) {
      reserveSet.add(key);
      reservedCount++;
      reservedSats += u.amountSats;
    }
  }

  const toConsolidate = sorted.filter((u) => !reserveSet.has(`${u.txid}:${u.vout}`));
  const warnings = [];

  if (toConsolidate.length === 0) {
    warnings.push('No UTXOs available for consolidation after reserve exclusion.');
    return {
      planId: null,
      generatedAt: new Date().toISOString(),
      totalCandidates: candidates.length,
      reserved: reservedCount,
      reservedSats,
      batches: [],
      warnings,
      operatorChecklist: buildOperatorChecklist(),
    };
  }

  const batches = [];
  let currentBatchInputs = [];
  let batchIndex = 0;

  for (const input of toConsolidate) {
    const potentialCount = currentBatchInputs.length + 1;
    const potentialSize = estimateTxSizeBytes(potentialCount, 1);

    if (
      potentialCount > maxInputsPerBatch ||
      potentialSize >= maxTxSizeBytes
    ) {
      if (currentBatchInputs.length > 0) {
        batches.push({ inputs: currentBatchInputs, batchIndex });
        batchIndex++;
        currentBatchInputs = [];
      }
    }

    currentBatchInputs.push(input);
  }

  if (currentBatchInputs.length > 0) {
    batches.push({ inputs: currentBatchInputs, batchIndex });
  }

  let feeRateSatsPerByte = cc.feeRateSatsPerByte || Math.ceil((cc.feeRateSatsPerKb || 10000) / 1000);
  if (cc.useSmartFeeEstimate) {
    try {
      const feeEst = await rpc('estimatesmartfee', [cc.smartFeeConfirmTarget || 6]);
      if (feeEst && feeEst.feerate && feeEst.feerate > 0) {
        feeRateSatsPerByte = Math.ceil((feeEst.feerate * SATS_PER_HEMP) / 1000);
      }
    } catch (_e) {
      warnings.push(`Smart fee estimate failed, using fallback rate: ${feeRateSatsPerByte} sats/byte`);
    }
  }

  const planBatches = batches.map((b) => {
    const inputCount = b.inputs.length;
    const txSize = estimateTxSizeBytes(inputCount, 1);
    const totalInputSats = b.inputs.reduce((sum, i) => sum + i.amountSats, 0);
    const estimatedFeeSats = Math.max(1, Math.ceil(txSize * feeRateSatsPerByte));
    const outputSats = totalInputSats - estimatedFeeSats;

    if (outputSats <= DUST_THRESHOLD_SATS) {
      warnings.push(`Batch ${b.batchIndex}: estimated fee (${estimatedFeeSats} sats) exceeds or nearly equals input value (${totalInputSats} sats).`);
    }

    return {
      batchIndex: b.batchIndex,
      selectedInputs: b.inputs.map((i) => ({
        txid: i.txid,
        vout: i.vout,
        amountSats: i.amountSats,
        confirmations: i.confirmations,
        address: i.address,
      })),
      destinationAddress: effectiveDest,
      totalInputSats,
      estimatedFeeSats,
      estimatedTxSizeBytes: txSize,
      expectedOutputCount: 1,
      expectedChangeAmountSats: 0,
      expectedPostConsolidationShape: {
        totalUtxos: rawUtxos.length - inputCount + 1,
        matureSpendable: rawUtxos.filter((u) => u.confirmations >= minConfirmations).length - inputCount + 1,
        totalAmountSats: rawUtxos.reduce((s, u) => s + u.amountSats, 0) - estimatedFeeSats,
      },
    };
  });

  const totalInputs = toConsolidate.length;
  const totalInputSats = toConsolidate.reduce((s, i) => s + i.amountSats, 0);
  const totalFeeSats = planBatches.reduce((s, b) => s + b.estimatedFeeSats, 0);

  return {
    planId: null,
    generatedAt: new Date().toISOString(),
    walletLabel: walletLabel || null,
    configSnapshot: {
      minConfirmations,
      maxInputsPerBatch,
      maxTxSizeBytes,
      feeRateSatsPerByte,
      reservePolicy,
    },
    totalCandidates: candidates.length,
    reserved: reservedCount,
    reservedSats,
    batches: planBatches,
    totalInputs,
    totalInputSats,
    totalFeeSats,
    warnings,
    operatorChecklist: buildOperatorChecklist(),
  };
}

function buildOperatorChecklist() {
  return [
    { id: 'dest', description: 'Reviewed destination address and confirmed it is controlled by the pool.' },
    { id: 'fee', description: 'Verified fee rate against current mempool conditions.' },
    { id: 'reserve', description: 'Confirmed reserve policy leaves enough liquidity for next N payouts.' },
    { id: 'utxos', description: 'Confirmed no UTXOs in this plan are needed for a pending payout batch.' },
    { id: 'sign', description: 'Wallet is unlocked or has private keys available for signing.' },
    { id: 'sync', description: 'Node is fully synced (getblockchaininfo verification).' },
    { id: 'irreversible', description: 'Understand that broadcasts are irreversible.' },
  ];
}

module.exports = {
  planConsolidation,
  isP2PKHAddress,
  estimateInputSizeBytes: estimateInputTxSizeBytes,
  estimateOutputSizeBytes: estimateOutputTxSizeBytes,
};
