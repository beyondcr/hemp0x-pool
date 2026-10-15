const P2PKH_INPUT_BYTES = 148;
const P2PKH_OUTPUT_BYTES = 34;
const TX_OVERHEAD_BYTES = 10;
const STANDARD_MAX_TX_BYTES = 100000;
const DEFAULT_TARGET_TX_BYTES = 90000;
const DUST_THRESHOLD_SATS = 546;

function estimateInputTxSizeBytes() {
  return P2PKH_INPUT_BYTES;
}

function estimateOutputTxSizeBytes() {
  return P2PKH_OUTPUT_BYTES;
}

function estimateTxSizeBytes(inputCount, outputCount) {
  return TX_OVERHEAD_BYTES + inputCount * P2PKH_INPUT_BYTES + outputCount * P2PKH_OUTPUT_BYTES;
}

module.exports = {
  P2PKH_INPUT_BYTES,
  P2PKH_OUTPUT_BYTES,
  TX_OVERHEAD_BYTES,
  STANDARD_MAX_TX_BYTES,
  DEFAULT_TARGET_TX_BYTES,
  DUST_THRESHOLD_SATS,
  estimateInputTxSizeBytes,
  estimateOutputTxSizeBytes,
  estimateTxSizeBytes,
};
