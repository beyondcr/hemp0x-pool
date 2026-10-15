const { hempToSatsNumber, SATS_PER_HEMP } = require('./constants');
const { isRoutableAddress: isValidAddress } = require('./address');

function addMinerCredit(map, miner, blockHeight, category, amountSats) {
  let entry = map.get(miner);
  if (!entry) {
    entry = { totalSats: 0, details: [] };
    map.set(miner, entry);
  }
  entry.totalSats += amountSats;
  entry.details.push({ blockHeight, category, amountSats });
}

function distributeSatsEvenly(totalSats, recipients) {
  if (recipients.length === 0 || totalSats <= 0) return [];
  const base = Math.floor(totalSats / recipients.length);
  const extra = totalSats - base * recipients.length;
  return recipients.map((recipient, i) => ({
    recipient,
    amountSats: base + (i < extra ? 1 : 0),
  }));
}

function distributeSatsByWeight(totalSats, weights) {
  if (!Array.isArray(weights) || weights.length === 0 || totalSats <= 0) return [];

  const normalized = weights
    .map(({ recipient, weight }) => ({ recipient, weight: Number(weight) }))
    .filter(({ recipient, weight }) => recipient && Number.isFinite(weight) && weight > 0)
    .sort((a, b) => String(a.recipient).localeCompare(String(b.recipient)));

  if (normalized.length === 0) return [];

  const totalWeight = normalized.reduce((sum, w) => sum + w.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return [];

  let allocatedTotal = 0;
  const rows = normalized.map(({ recipient, weight }) => {
    const exact = (totalSats * weight) / totalWeight;
    const amountSats = Math.floor(exact);
    allocatedTotal += amountSats;
    return { recipient, amountSats, remainder: exact - amountSats };
  });

  rows.sort((a, b) => {
    const remainderDiff = b.remainder - a.remainder;
    if (remainderDiff !== 0) return remainderDiff;
    return String(a.recipient).localeCompare(String(b.recipient));
  });

  let remaining = totalSats - allocatedTotal;
  for (let i = 0; remaining > 0 && rows.length > 0; i = (i + 1) % rows.length) {
    rows[i].amountSats += 1;
    remaining -= 1;
  }

  return rows
    .sort((a, b) => String(a.recipient).localeCompare(String(b.recipient)))
    .map(({ recipient, amountSats }) => ({ recipient, amountSats }));
}

/**
 * Plan a dry-run payout without mutating live reward balances, blocks, or shares.
 *
 * Dependency injection: accepts a db-like object or plain data/functions for
 * blocks and miner lookups so tests can supply fixtures directly.
 *
 * @param {object} options
 * @param {object}   [options.db]                        - sqlite3 Database with getUnpaidConfirmedBlocks, getActiveMinersForBlock, getMinersForBlockWindow, getMinerShareWeightsForBlock, getPplnsWeightsForBlock
 * @param {object[]} [options.blocks]                    - static block array (overrides db.getUnpaidConfirmedBlocks)
 * @param {function} [options.getActiveMinersForBlock]   - (blockTimestamp, windowMs, minActiveMs) => Promise<string[]>
 * @param {function} [options.getMinersForBlockWindow]   - (blockTimestamp, windowMs) => Promise<string[]>
 * @param {function} [options.getMinerShareWeightsForBlock] - (blockTimestamp, windowMs) => Promise<Array<{miner: string, totalDifficulty: number}>>
 * @param {function} [options.getPplnsWeightsForBlock]   - (blockHeight) => Promise<Array<{miner: string, totalDifficulty: number}>>
 * @param {object}   options.config                      - merged config (must contain pool and payout sections)
 * @param {object}   options.payoutLedger                - PayoutLedger instance
 * @param {number}   [options.minPayoutSats]             - minimum sats a miner must accumulate (defaults to config.payout.flushMinPayoutSats)
 * @returns {Promise<object>} plan object
 */
async function planPayout({
  db,
  blocks: injectedBlocks,
  getActiveMinersForBlock,
  getMinersForBlockWindow,
  getMinerShareWeightsForBlock,
  getPplnsWeightsForBlock,
  config,
  payoutLedger,
  minPayoutSats,
}) {
  const poolCfg = config.pool || {};
  const payoutCfg = config.payout || {};

  const poolFee = poolCfg.fee !== undefined && poolCfg.fee !== null ? Number(poolCfg.fee) : 0.01;
  const finderBonusPercent = poolCfg.finderBonusPercent !== undefined ? Number(poolCfg.finderBonusPercent) : 0;
  const rewardModel = poolCfg.rewardModel || 'finder-plus-equal';
  const activeWindowMinutes = poolCfg.activeWindowMinutes ?? 30;
  const activeWindowMs = activeWindowMinutes * 60000;
  const minActiveMinutes = poolCfg.minActiveMinutes ?? 2;
  let minActiveMs = minActiveMinutes * 60000;
  const windowTuningWarnings = [];

  if (activeWindowMs > 0 && minActiveMs >= activeWindowMs) {
    minActiveMs = 0;
    windowTuningWarnings.push(
      `pool.minActiveMinutes (${minActiveMinutes}) must be less than pool.activeWindowMinutes (${activeWindowMinutes}); treating min-active as disabled for this plan`
    );
  }

  const maxOutputCount = payoutCfg.maxPayoutBatch || 50;
  const maxBatchAmountSats = payoutCfg.maxPayoutBatchAmountSats || 50000000000;
  const maxPerAddressSats = payoutCfg.maxPayoutPerAddressSats || 50000000000;
  const flushMinPayoutSats = payoutCfg.flushMinPayoutSats || 10000000;

  const effectiveMinPayoutSats = minPayoutSats !== undefined ? minPayoutSats : flushMinPayoutSats;

  const finderBonusRate = Math.max(0, Math.min(finderBonusPercent, 100)) / 100;

  let blockList;
  if (injectedBlocks) {
    blockList = injectedBlocks;
  } else if (db && typeof db.getUnpaidConfirmedBlocks === 'function') {
    blockList = await db.getUnpaidConfirmedBlocks();
  } else {
    throw new Error('Either blocks or db with getUnpaidConfirmedBlocks must be provided');
  }

  const lookupActive = getActiveMinersForBlock ||
    (db && typeof db.getActiveMinersForBlock === 'function'
      ? db.getActiveMinersForBlock.bind(db)
      : null);
  const lookupWindow = getMinersForBlockWindow ||
    (db && typeof db.getMinersForBlockWindow === 'function'
      ? db.getMinersForBlockWindow.bind(db)
      : null);

  if (!lookupActive || !lookupWindow) {
    throw new Error('Active miner lookup functions must be provided via db or direct injection');
  }

  const lookupWeights = getMinerShareWeightsForBlock ||
    (db && typeof db.getMinerShareWeightsForBlock === 'function'
      ? db.getMinerShareWeightsForBlock.bind(db)
      : null);

  const lookupPplns = getPplnsWeightsForBlock ||
    (db && typeof db.getPplnsWeightsForBlock === 'function'
      ? db.getPplnsWeightsForBlock.bind(db)
      : null);

  const warnings = [...windowTuningWarnings];
  const skipped = [];
  const blocksConsidered = [];
  const blockCredits = [];
  const minerCreditsMap = new Map();

  const run = await payoutLedger.createRun({});
  const runId = run.id;
  await payoutLedger.createEvent({ runId, eventType: 'run_created', detail: 'Dry-run payout plan started' });

  let totalGrossSats = 0;
  let totalFeeSats = 0;
  let totalFinderBonusSats = 0;
  let totalRemainderSats = 0;

  for (const block of blockList) {
    const reward = Number(block.reward || 0);
    if (reward <= 0) {
      warnings.push(`Block ${block.height}: zero or negative reward (${reward}), skipping`);
      skipped.push({ block: block.height, reason: 'zero or negative reward' });
      continue;
    }

    const grossRewardSats = hempToSatsNumber(reward);
    const feeDeductedSats = Math.floor(grossRewardSats * poolFee);
    const netRewardSats = grossRewardSats - feeDeductedSats;
    const finderBonusSats = Math.floor(netRewardSats * finderBonusRate);
    const remainderSats = netRewardSats - finderBonusSats;

    const finderAddress =
      block.mode === 'solo' && block.payout_address && isValidAddress(block.payout_address)
        ? block.payout_address
        : block.finder;

    if (!isValidAddress(finderAddress)) {
      skipped.push({ block: block.height, address: finderAddress, reason: 'invalid finder address' });
      warnings.push(`Block ${block.height}: invalid finder address, skipping block`);
      continue;
    }

    totalGrossSats += grossRewardSats;
    totalFeeSats += feeDeductedSats;
    totalFinderBonusSats += finderBonusSats;

    const blockTimestamp = Number(block.timestamp) || 0;
    let activeMiners = await lookupActive(blockTimestamp, activeWindowMs, minActiveMs);

    let fallbackUsed = false;
    if (activeMiners.length === 0) {
      activeMiners = await lookupWindow(blockTimestamp, activeWindowMs);
      if (activeMiners.length > 0) {
        fallbackUsed = true;
        warnings.push(
          `Block ${block.height}: no miners met min-active window; using ${activeMiners.length} miners in block window`
        );
      }
    }

    const validMiners = activeMiners.filter((m) => isValidAddress(m));
    const invalidMiners = activeMiners.filter((m) => !isValidAddress(m));
    for (const addr of invalidMiners) {
      skipped.push({ block: block.height, address: addr, reason: 'invalid miner address' });
      warnings.push(`Block ${block.height}: skipping invalid miner address ${addr}`);
    }

    totalRemainderSats += remainderSats;

    const blockCredit = await payoutLedger.createBlockCredit({
      runId,
      height: block.height,
      hash: block.hash,
      finder: finderAddress,
      mode: block.mode || 'pool',
      rewardSats: grossRewardSats,
      feeDeductedSats,
      finderBonusSats,
      remainderSats,
      minerCount: validMiners.length,
    });

    blocksConsidered.push({
      height: block.height,
      hash: block.hash,
      finder: finderAddress,
      rewardSats: grossRewardSats,
      timestamp: blockTimestamp,
    });

    blockCredits.push({
      height: block.height,
      rewardSats: grossRewardSats,
      feeDeductedSats,
      finderBonusSats,
      remainderSats,
      minerCount: validMiners.length,
      fallbackUsed,
    });

    if (finderBonusSats > 0) {
      await payoutLedger.createMinerCredit({
        blockCreditId: blockCredit.id,
        miner: finderAddress,
        category: 'finder',
        amountSats: finderBonusSats,
      });
      addMinerCredit(minerCreditsMap, finderAddress, block.height, 'finder', finderBonusSats);
    }

    if (remainderSats > 0) {
      let pplnsHandled = false;

      if (rewardModel === 'pplns' && lookupPplns) {
        const pplnsWeights = await lookupPplns(block.height);
        if (pplnsWeights.length > 0) {
          const pplnsWeightMap = new Map();
          for (const pw of pplnsWeights) {
            pplnsWeightMap.set(pw.miner, pw.totalDifficulty);
          }
          const validPplnsMiners = [];
          const invalidPplnsMiners = [];
          for (const [miner, weight] of pplnsWeightMap) {
            if (isValidAddress(miner) && weight > 0) {
              validPplnsMiners.push(miner);
            } else if (!isValidAddress(miner)) {
              invalidPplnsMiners.push(miner);
              skipped.push({ block: block.height, address: miner, reason: 'invalid PPLNS snapshot miner address' });
              warnings.push(`Block ${block.height}: skipping invalid PPLNS snapshot miner address ${miner}`);
            }
          }
          if (validPplnsMiners.length > 0) {
            const weights = validPplnsMiners.map((m) => ({
              recipient: m,
              weight: pplnsWeightMap.get(m),
            }));
            const distributions = distributeSatsByWeight(remainderSats, weights);
            for (const { recipient, amountSats } of distributions) {
              if (amountSats <= 0) continue;
              await payoutLedger.createMinerCredit({
                blockCreditId: blockCredit.id,
                miner: recipient,
                category: 'pool',
                amountSats,
              });
              addMinerCredit(minerCreditsMap, recipient, block.height, 'pool', amountSats);
            }
            pplnsHandled = true;
          } else {
            warnings.push(
              `Block ${block.height}: PPLNS mode but no valid miners have PPLNS window weights; falling back to equal split`
            );
          }
        } else {
          warnings.push(
            `Block ${block.height}: PPLNS mode but no PPLNS weights found for this block; falling back to equal split`
          );
        }
      } else if (rewardModel === 'pplns') {
        warnings.push(
          `Block ${block.height}: PPLNS mode requested but no PPLNS weight lookup available; falling back to equal split`
        );
      }

      if (!pplnsHandled && validMiners.length > 0) {
        let distributions;
        if (rewardModel === 'finder-plus-share-weighted' && lookupWeights) {
          const shareWeights = await lookupWeights(blockTimestamp, activeWindowMs);
          if (shareWeights.length > 0) {
            const minerWeightMap = new Map();
            for (const sw of shareWeights) {
              minerWeightMap.set(sw.miner, sw.totalDifficulty);
            }
            const weightedMiners = validMiners
              .filter((m) => minerWeightMap.has(m) && minerWeightMap.get(m) > 0);
            if (weightedMiners.length > 0 && validMiners.length > weightedMiners.length) {
              warnings.push(
                `Block ${block.height}: ${validMiners.length - weightedMiners.length} valid miners have no share weight; excluding from distribution`
              );
            }
            if (weightedMiners.length > 0) {
              const weights = weightedMiners.map((m) => ({
                recipient: m,
                weight: minerWeightMap.get(m),
              }));
              distributions = distributeSatsByWeight(remainderSats, weights);
            } else {
              warnings.push(
                `Block ${block.height}: no miners have share weights; falling back to equal split`
              );
              distributions = distributeSatsEvenly(remainderSats, validMiners);
            }
          } else {
            warnings.push(
              `Block ${block.height}: no share weights available; falling back to equal split`
            );
            distributions = distributeSatsEvenly(remainderSats, validMiners);
          }
        } else if (rewardModel === 'finder-plus-share-weighted') {
          warnings.push(
            `Block ${block.height}: share-weighted mode requested but no share weight lookup available; falling back to equal split`
          );
          distributions = distributeSatsEvenly(remainderSats, validMiners);
        } else {
          distributions = distributeSatsEvenly(remainderSats, validMiners);
        }
        for (const { recipient, amountSats } of distributions) {
          if (amountSats <= 0) continue;
          await payoutLedger.createMinerCredit({
            blockCreditId: blockCredit.id,
            miner: recipient,
            category: 'pool',
            amountSats,
          });
          addMinerCredit(minerCreditsMap, recipient, block.height, 'pool', amountSats);
        }
      } else if (!pplnsHandled && validMiners.length === 0 && remainderSats > 0) {
        await payoutLedger.createMinerCredit({
          blockCreditId: blockCredit.id,
          miner: finderAddress,
          category: 'finder_fallback',
          amountSats: remainderSats,
        });
        addMinerCredit(minerCreditsMap, finderAddress, block.height, 'finder_fallback', remainderSats);
        warnings.push(
          `Block ${block.height}: no active miners; remainder of ${remainderSats} sats credited to finder as fallback`
        );
      }
    }
  }

  const minerCredits = [];
  for (const [miner, entry] of minerCreditsMap.entries()) {
    minerCredits.push({
      miner,
      totalSats: entry.totalSats,
      blocks: entry.details,
    });
  }

  const payableMiners = minerCredits.filter((m) => m.totalSats >= effectiveMinPayoutSats);
  const belowThreshold = minerCredits.filter((m) => m.totalSats < effectiveMinPayoutSats);
  for (const m of belowThreshold) {
    warnings.push(
      `Miner ${m.miner}: total ${m.totalSats} sats below min payout threshold ${effectiveMinPayoutSats}, skipped`
    );
    skipped.push({ address: m.miner, reason: `below min payout threshold (${m.totalSats} < ${effectiveMinPayoutSats})` });
  }

  const addressesToSkip = new Set();
  for (const m of payableMiners) {
    if (!isValidAddress(m.miner)) {
      skipped.push({ address: m.miner, reason: 'invalid payout address' });
      warnings.push(`Skipping payout with invalid address: ${m.miner}`);
      addressesToSkip.add(m.miner);
    }
  }

  const filteredMiners = payableMiners.filter((m) => !addressesToSkip.has(m.miner));

  const entries = [];
  for (const m of filteredMiners) {
    let remaining = m.totalSats;
    while (remaining > 0) {
      const amount = remaining > maxPerAddressSats ? maxPerAddressSats : remaining;
      entries.push({ address: m.miner, amountSats: amount });
      remaining -= amount;
    }
  }

  const batches = [];
  let currentBatchOutputs = [];
  let currentTotal = 0;
  let currentAddresses = new Set();

  for (const entry of entries) {
    const wouldExceedCount = currentBatchOutputs.length >= maxOutputCount;
    const wouldExceedAmount = currentTotal + entry.amountSats > maxBatchAmountSats;
    const duplicate = currentAddresses.has(entry.address);

    if (
      currentBatchOutputs.length > 0 &&
      (wouldExceedCount || wouldExceedAmount || duplicate)
    ) {
      batches.push({ outputs: currentBatchOutputs, totalSats: currentTotal });
      currentBatchOutputs = [];
      currentTotal = 0;
      currentAddresses = new Set();
    }

    currentBatchOutputs.push(entry);
    currentTotal += entry.amountSats;
    currentAddresses.add(entry.address);
  }
  if (currentBatchOutputs.length > 0) {
    batches.push({ outputs: currentBatchOutputs, totalSats: currentTotal });
  }

  const persistedBatches = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const ledgerBatch = await payoutLedger.createBatch({
      runId,
      batchIndex: i,
      totalAmountSats: batch.totalSats,
      outputCount: batch.outputs.length,
    });

    const batchOutputs = [];
    for (const output of batch.outputs) {
      const bo = await payoutLedger.createBatchOutput({
        batchId: ledgerBatch.id,
        address: output.address,
        amountSats: output.amountSats,
        category: 'pool',
      });
      batchOutputs.push({
        address: output.address,
        amountSats: output.amountSats,
      });
    }

    persistedBatches.push({
      batchIndex: i,
      outputCount: batch.outputs.length,
      totalSats: batch.totalSats,
      outputs: batchOutputs,
    });
  }

  const totals = {
    grossRewardSats: totalGrossSats,
    feeDeductedSats: totalFeeSats,
    finderBonusTotalSats: totalFinderBonusSats,
    remainderTotalSats: totalRemainderSats,
    batchCount: batches.length,
    totalBatchedSats: batches.reduce((s, b) => s + b.totalSats, 0),
    uniqueMiners: minerCredits.length,
    payableMiners: filteredMiners.length,
  };

  await payoutLedger.updateRunAggregates(runId, {
    blockHeightStart: blocksConsidered.length > 0 ? Math.min(...blocksConsidered.map((b) => b.height)) : null,
    blockHeightEnd: blocksConsidered.length > 0 ? Math.max(...blocksConsidered.map((b) => b.height)) : null,
    totalBlocks: blocksConsidered.length,
    totalMiners: minerCredits.length,
    totalAmountSats: totalGrossSats,
    feeAmountSats: totalFeeSats,
    netAmountSats: totalGrossSats - totalFeeSats,
  });

  await payoutLedger.createEvent({
    runId,
    eventType: 'credited',
    detail: `Plan complete: ${blocksConsidered.length} blocks, ${minerCredits.length} miners, ${batches.length} batches`,
  });

  return {
    runId,
    generatedAt: new Date().toISOString(),
    blocksConsidered,
    blockCredits,
    minerCredits,
    batches: persistedBatches,
    skipped,
    warnings,
    totals,
  };
}

module.exports = { planPayout, isValidAddress, distributeSatsEvenly, distributeSatsByWeight };
