const db = require('./database');
const { loadConfig } = require('./config');
const { createRpcClient } = require('./rpcClient');
const { installConsoleTimestamps } = require('./logger');

installConsoleTimestamps();

const config = loadConfig();
const REQUIRED_CONFIRMATIONS = config.pool.blockConfirmations || 100;
const CONFIRMATION_INTERVAL_MS = Number(process.env.HEMP0X_POOL_CONFIRMATION_INTERVAL_MS || 60000);
const CONFIRMATION_MAX_RPC_CHECKS = Number(process.env.HEMP0X_POOL_CONFIRMATION_MAX_RPC_CHECKS || 25);
const CONFIRMATION_RPC_DELAY_MS = Number(process.env.HEMP0X_POOL_CONFIRMATION_RPC_DELAY_MS || 100);
const rpc = createRpcClient(config);

let checkInProgress = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRpcQueueDepthError(error) {
    return error && /Work queue depth exceeded/i.test(error.message || '');
}

function estimatedConfirmations(currentHeight, blockHeight) {
    if (!Number.isFinite(currentHeight) || !Number.isFinite(blockHeight)) return 0;
    return Math.max(0, currentHeight - blockHeight + 1);
}

async function checkConfirmations() {
    if (checkInProgress) {
        console.log('[CONFIRM] Previous confirmation check is still running; skipping this cycle.');
        return;
    }

    checkInProgress = true;
    try {
        const pendingBlocks = await db.getPendingBlocks();
        if (pendingBlocks.length === 0) return;

        const currentHeight = await rpc('getblockcount', []);
        let rpcChecks = 0;
        console.log(`[CONFIRM] Reviewing ${pendingBlocks.length} pending blocks at height ${currentHeight}...`);

        const sortedBlocks = pendingBlocks
            .filter(block => block && block.hash)
            .sort((a, b) => Number(a.height) - Number(b.height));

        for (const block of sortedBlocks) {
            if (!block.hash) continue;

            const estimated = estimatedConfirmations(currentHeight, Number(block.height));
            if (estimated < REQUIRED_CONFIRMATIONS) {
                if (estimated > 0 && estimated % 10 === 0) {
                    console.log(`[PENDING] Block ${block.height}: ~${estimated}/${REQUIRED_CONFIRMATIONS}`);
                }
                continue;
            }

            if (rpcChecks >= CONFIRMATION_MAX_RPC_CHECKS) {
                console.log(`[CONFIRM] RPC check limit reached (${CONFIRMATION_MAX_RPC_CHECKS}); remaining mature blocks will be checked next cycle.`);
                break;
            }

            if (rpcChecks > 0 && CONFIRMATION_RPC_DELAY_MS > 0) {
                await sleep(CONFIRMATION_RPC_DELAY_MS);
            }

            try {
                rpcChecks += 1;
                const blockInfo = await rpc('getblock', [block.hash]);

                if (blockInfo.confirmations >= REQUIRED_CONFIRMATIONS) {
                    console.log(`[CONFIRM] Block ${block.height} CONFIRMED! (${blockInfo.confirmations} confs)`);
                    await db.updateBlockStatus(block.height, 'confirmed');
                } else if (blockInfo.confirmations === -1) {
                    console.log(`[ORPHAN] Block ${block.height} ORPHANED!`);
                    await db.updateBlockStatus(block.height, 'orphaned');
                } else {
                    if (blockInfo.confirmations % 10 === 0) {
                        console.log(`[PENDING] Block ${block.height}: ${blockInfo.confirmations}/${REQUIRED_CONFIRMATIONS}`);
                    }
                }
            } catch (e) {
                console.error(`[ERROR] Failed to check block ${block.height}:`, e.message);
                if (isRpcQueueDepthError(e)) {
                    console.error('[CONFIRM] RPC queue is saturated; stopping this cycle to protect share validation.');
                    break;
                }
            }
        }
    } catch (e) {
        console.error("[CONFIRM ERROR]", e);
    } finally {
        checkInProgress = false;
    }
}

db.init();
console.log(`[CONFIRM] Monitor started. Target: ${REQUIRED_CONFIRMATIONS} confirmations.`);
console.log(`[CONFIRM] Interval: ${CONFIRMATION_INTERVAL_MS}ms, max RPC checks: ${CONFIRMATION_MAX_RPC_CHECKS}, RPC delay: ${CONFIRMATION_RPC_DELAY_MS}ms.`);
setInterval(checkConfirmations, CONFIRMATION_INTERVAL_MS);
checkConfirmations();
