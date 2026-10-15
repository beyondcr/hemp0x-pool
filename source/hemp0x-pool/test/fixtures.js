const { SATS_PER_HEMP } = require('../constants');

const FIXTURE_SEED = 20260523;
const POOL_ADDRESS = 'R111111111111111111111111111111111';
const CHANGE_ADDRESSES = [
  'RChange111111111111111111111111111X1',
  'RChange222222222222222222222222222X2',
];

function mulberry32(seed) {
  let state = seed | 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function generateTxid(seed, index, vout) {
  const n = (index * 21436587 + vout * 87654321 + seed * 65537) >>> 0;
  return n.toString(16).padStart(64, '0').slice(0, 64);
}

function pickRandomIndices(rng, total, count, exclude) {
  const result = [];
  const seen = new Set(exclude);
  while (result.length < count) {
    const idx = randomInt(rng, 0, total - 1);
    if (!seen.has(idx)) {
      seen.add(idx);
      result.push(idx);
    }
  }
  return result;
}

const AMOUNT_10_HEMP_SATS = 1000000000;
const AMOUNT_50_HEMP_SATS = 5000000000;
const AMOUNT_100_HEMP_SATS = 10000000000;

const COUNT_10_HEMP = 6493;
const COUNT_50_HEMP = 577;
const COUNT_100_HEMP = 144;
const COUNT_DUST = 10;
const COUNT_IMMATURE = 50;
const DEFAULT_FIXTURE_UTXO_COUNT = COUNT_10_HEMP + COUNT_50_HEMP + COUNT_100_HEMP;

function resolveFixtureOptions(options) {
  if (typeof options === 'number') {
    return {
      seed: options,
      totalUtxos: DEFAULT_FIXTURE_UTXO_COUNT,
      dustCount: COUNT_DUST,
      immatureCount: COUNT_IMMATURE,
    };
  }
  const opts = options || {};
  return {
    seed: opts.seed || FIXTURE_SEED,
    totalUtxos: opts.totalUtxos || DEFAULT_FIXTURE_UTXO_COUNT,
    dustCount: opts.dustCount === undefined ? COUNT_DUST : opts.dustCount,
    immatureCount: opts.immatureCount === undefined ? COUNT_IMMATURE : opts.immatureCount,
  };
}

/**
 * Generate a deterministic UTXO fixture.
 * The default size models the 2026-05-22 pool-wallet observation, but callers
 * can pass totalUtxos to exercise smaller or larger wallet shapes.
 * Same seed always produces identical output.
 */
function generateTestUtxos(options = {}) {
  const { seed, totalUtxos, dustCount, immatureCount } = resolveFixtureOptions(options);
  const rng = mulberry32(seed);
  const utxos = [];
  const count100 = Math.max(0, Math.round(totalUtxos * 0.02));
  const count50 = Math.max(0, Math.round(totalUtxos * 0.08));
  const count10 = Math.max(0, totalUtxos - count50 - count100);

  for (let i = 0; i < count10; i++) {
    utxos.push({
      txid: generateTxid(seed, i, 0),
      vout: 0,
      amountSats: AMOUNT_10_HEMP_SATS,
      amount: AMOUNT_10_HEMP_SATS / SATS_PER_HEMP,
      confirmations: randomInt(rng, 101, 15000),
      address: rng() < 0.01 ? CHANGE_ADDRESSES[randomInt(rng, 0, 1)] : POOL_ADDRESS,
      spendable: true,
      solvable: true,
    });
  }

  const offset50 = count10;
  for (let i = 0; i < count50; i++) {
    utxos.push({
      txid: generateTxid(seed, offset50 + i, 0),
      vout: 0,
      amountSats: AMOUNT_50_HEMP_SATS,
      amount: AMOUNT_50_HEMP_SATS / SATS_PER_HEMP,
      confirmations: randomInt(rng, 101, 15000),
      address: rng() < 0.01 ? CHANGE_ADDRESSES[randomInt(rng, 0, 1)] : POOL_ADDRESS,
      spendable: true,
      solvable: true,
    });
  }

  const offset100 = offset50 + count50;
  for (let i = 0; i < count100; i++) {
    utxos.push({
      txid: generateTxid(seed, offset100 + i, 0),
      vout: 0,
      amountSats: AMOUNT_100_HEMP_SATS,
      amount: AMOUNT_100_HEMP_SATS / SATS_PER_HEMP,
      confirmations: randomInt(rng, 101, 15000),
      address: rng() < 0.01 ? CHANGE_ADDRESSES[randomInt(rng, 0, 1)] : POOL_ADDRESS,
      spendable: true,
      solvable: true,
    });
  }

  const immatureIndices = pickRandomIndices(rng, utxos.length, Math.min(immatureCount, utxos.length), []);
  for (const idx of immatureIndices) {
    utxos[idx].confirmations = randomInt(rng, 1, 99);
  }

  const dustIndices = pickRandomIndices(rng, utxos.length, Math.min(dustCount, Math.max(0, utxos.length - immatureIndices.length)), immatureIndices);
  for (const idx of dustIndices) {
    const dustSats = randomInt(rng, 1, 999);
    utxos[idx].amountSats = dustSats;
    utxos[idx].amount = dustSats / SATS_PER_HEMP;
  }

  return utxos;
}

module.exports = { generateTestUtxos, FIXTURE_SEED, DEFAULT_FIXTURE_UTXO_COUNT, POOL_ADDRESS, CHANGE_ADDRESSES };
