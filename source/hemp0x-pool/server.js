const fs = require('fs');
const net = require('net');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { keccak_256 } = require("js-sha3");
const db = require('./database');
const { isRoutableAddress, base58Decode, addressToPubkeyHash, buildP2PKHScript } = require('./address');
const { MigrationRunner } = require('./migrations');
const { sanitizeError, clampLimit, redactSecrets } = require('./configRedaction');
const { loadConfig } = require('./config');
const { createRpcClient } = require('./rpcClient');
const { waitForRpcReady, isWarmupRpcError } = require('./rpcReady');
const { initAdminRoutes } = require('./adminApi');
const { installConsoleTimestamps } = require('./logger');
const { nextJobId, rememberJob } = require('./stratumJobs');

installConsoleTimestamps();

// ====================================================================
//  HEMP0X KAWPOW MINING POOL - Production v2.0
//  Correct KawPoW jobs, share validation, and block assembly
// ====================================================================

// Load Configuration via safe loader
let config;
try {
    config = loadConfig();
} catch (e) {
    console.error("Failed to load config:", sanitizeError(e));
    process.exit(1);
}

const STRATUM_PORT = config.pool.stratumPort;
const WEB_PORT = config.pool.webPort;
const POOL_WALLET = config.pool.wallet;
const POOL_FEE = config.pool.fee;
const SOLO_FEE = (config.pool.soloFee !== undefined) ? config.pool.soloFee : POOL_FEE;
const VARDIFF_CONFIG = config.vardiff;
const HISTORY_HOURS = (config.frontend && config.frontend.historyHours) ? Number(config.frontend.historyHours) : 1;

const HASHRATE_WINDOW_MS = 300000; // 5 min
const HASHRATE_UNIT = 1000000; // MH/s
const MIN_HASHRATE_SAMPLE_SECONDS = Math.max(1, Number(VARDIFF_CONFIG.targetTime) || 15);

function readInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
}

const TEMPLATE_REFRESH_INTERVAL_MS = readInteger(
    config.pool.templateRefreshIntervalMs || process.env.HEMP0X_POOL_TEMPLATE_REFRESH_INTERVAL_MS,
    1000,
    { min: 250, max: 60000 }
);
const SUBMIT_BLOCK_RPC_TIMEOUT_MS = readInteger(
    config.pool.submitBlockRpcTimeoutMs || process.env.HEMP0X_POOL_SUBMIT_BLOCK_RPC_TIMEOUT_MS,
    15000,
    { min: 1000, max: 60000 }
);
const SUBMIT_BLOCK_RETRIES = readInteger(
    config.pool.submitBlockRetries ?? process.env.HEMP0X_POOL_SUBMIT_BLOCK_RETRIES,
    2,
    { min: 0, max: 5 }
);
const SUBMIT_BLOCK_RETRY_DELAY_MS = readInteger(
    config.pool.submitBlockRetryDelayMs || process.env.HEMP0X_POOL_SUBMIT_BLOCK_RETRY_DELAY_MS,
    1000,
    { min: 0, max: 30000 }
);
const STRATUM_MAX_CONNECTIONS = readInteger(
    config.pool.maxStratumConnections ?? process.env.HEMP0X_POOL_MAX_STRATUM_CONNECTIONS,
    256,
    { min: 1, max: 10000 }
);
const STRATUM_MAX_LINE_BYTES = readInteger(
    config.pool.maxStratumLineBytes ?? process.env.HEMP0X_POOL_MAX_STRATUM_LINE_BYTES,
    65536,
    { min: 1024, max: 1048576 }
);
const MAX_PENDING_SHARE_VALIDATIONS = readInteger(
    config.pool.maxPendingShareValidations ?? process.env.HEMP0X_POOL_MAX_PENDING_SHARE_VALIDATIONS,
    8,
    { min: 1, max: 128 }
);
const MAX_CONCURRENT_SHARE_VALIDATIONS = readInteger(
    config.pool.maxConcurrentShareValidations ?? process.env.HEMP0X_POOL_MAX_CONCURRENT_SHARE_VALIDATIONS,
    256,
    { min: 1, max: 4096 }
);
const MAX_WORKERS = readInteger(
    config.pool.maxWorkers ?? process.env.HEMP0X_POOL_MAX_WORKERS,
    10000,
    { min: 100, max: 1000000 }
);
const WORKER_RETENTION_MS = readInteger(
    config.pool.workerRetentionMs ?? process.env.HEMP0X_POOL_WORKER_RETENTION_MS,
    1800000,
    { min: 60000, max: 604800000 }
);
const MAX_WORKER_ID_BYTES = 128;
const MAX_STRATUM_BUFFER_BYTES = STRATUM_MAX_LINE_BYTES * 2;

// Global State
let stats = { shares: 0, hashrate: 0, fees: POOL_FEE };
let workers = new Map();
let openSockets = [];
let currentTemplate = null;
let extraNonce1Generator = 0;
let currentNetworkDifficulty = 0;
let activeShareValidations = 0;
let workerCleanupTimer = null;

// ====================================================================
//  UTILITY FUNCTIONS
// ====================================================================

function sanitizeStratumLogValue(value) {
    return String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, MAX_WORKER_ID_BYTES);
}

function cleanupInactiveWorkers(now = Date.now()) {
    for (const [workerId, worker] of workers.entries()) {
        const connected = openSockets.some((socket) => (
            !socket.destroyed && socket.workerId === workerId
        ));
        if (!connected && now - worker.lastSeen >= WORKER_RETENTION_MS) {
            workers.delete(workerId);
        }
    }
}

function startWorkerCleanup() {
    if (workerCleanupTimer) return;
    const intervalMs = Math.min(Math.max(Math.floor(WORKER_RETENTION_MS / 2), 60000), 300000);
    workerCleanupTimer = setInterval(() => cleanupInactiveWorkers(), intervalMs);
    workerCleanupTimer.unref();
}

function writeStratumError(socket, id, code, message) {
    if (socket.destroyed) return;
    socket.write(JSON.stringify({ id, result: false, error: [code, message, null] }) + '\n');
}

function isStratumPayloadWithinLimit(existingBufferBytes, incomingBytes) {
    return incomingBytes <= MAX_STRATUM_BUFFER_BYTES &&
        existingBufferBytes + incomingBytes <= MAX_STRATUM_BUFFER_BYTES;
}

function canStartShareValidation(pendingCount, activeCount) {
    return pendingCount < MAX_PENDING_SHARE_VALIDATIONS &&
        activeCount < MAX_CONCURRENT_SHARE_VALIDATIONS;
}

function isAcceptedKawpowShare(kawpow) {
    if (!kawpow) return false;
    const resultPass = kawpow.result === true || kawpow.result === 'true';
    if (!resultPass) return false;
    const meetsTargetPass = kawpow.meets_target === true || kawpow.meets_target === 'true';
    return meetsTargetPass;
}

function reverseBuffer(buf) {
    const reversed = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) reversed[i] = buf[buf.length - i - 1];
    return reversed;
}

function serializeNumber(n) {
    if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]);
    const buf = Buffer.alloc(8);
    let len = 0, temp = n;
    while (temp > 0) {
        buf.writeUInt8(temp & 0xFF, len);
        temp = Math.floor(temp / 256);
        len++;
    }
    const numBytes = Buffer.alloc(len);
    buf.copy(numBytes, 0, 0, len);
    if (len === 1) return Buffer.concat([Buffer.from([0x01]), numBytes]);
    if (len === 2) return Buffer.concat([Buffer.from([0x02]), numBytes]);
    if (len === 3) return Buffer.concat([Buffer.from([0x03]), numBytes]);
    if (len === 4) return Buffer.concat([Buffer.from([0x04]), numBytes]);
    return Buffer.concat([Buffer.from([0x4c, len]), numBytes]);
}

function varIntBuffer(n) {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) {
        const b = Buffer.alloc(3);
        b[0] = 0xfd;
        b.writeUInt16LE(n, 1);
        return b;
    }
    if (n <= 0xffffffff) {
        const b = Buffer.alloc(5);
        b[0] = 0xfe;
        b.writeUInt32LE(n, 1);
        return b;
    }
    const b = Buffer.alloc(9);
    b[0] = 0xff;
    b.writeBigUInt64LE(BigInt(n), 1);
    return b;
}

function hexToBuffer(hex) { return Buffer.from(hex, 'hex'); }

function getSeedHash(height) {
    const epochLength = 7500;
    const epoch = Math.floor(Number(height) / epochLength);
    let seed = Buffer.alloc(32, 0);
    for (let i = 0; i < epoch; i++) {
        seed = Buffer.from(keccak_256(seed), 'hex');
    }
    return seed.toString('hex');
}

function sha256d(buffer) {
    return crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(buffer).digest()
    ).digest();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function difficultyToTarget(difficulty) {
    if (!difficulty || difficulty <= 0) difficulty = 1;
    const diff1Target = BigInt('0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const precision = 100000000n;
    const scaled = BigInt(Math.max(1, Math.floor(difficulty * Number(precision))));
    const target = (diff1Target * precision) / scaled;
    return target.toString(16).padStart(64, '0');
}

function bitsToTarget(bitsHex) {
    const bits = parseInt(bitsHex, 16);
    const exponent = bits >>> 24;
    const mantissa = bits & 0x007fffff;
    let target = BigInt(mantissa);
    if (exponent <= 3) {
        target = target >> (BigInt(8) * BigInt(3 - exponent));
    } else {
        target = target << (BigInt(8) * BigInt(exponent - 3));
    }
    return target.toString(16).padStart(64, '0');
}

function bitsToDifficulty(bitsHex) {
    const bits = parseInt(bitsHex, 16);
    if (!Number.isFinite(bits) || bits <= 0) return 0;
    const exponent = (bits >>> 24) & 0xff;
    const mantissa = bits & 0x00ffffff;
    if (mantissa <= 0) return 0;

    let difficulty = 0x0000ffff / mantissa;
    for (let shift = exponent; shift < 29; shift++) difficulty *= 256;
    for (let shift = exponent; shift > 29; shift--) difficulty /= 256;
    return Number.isFinite(difficulty) && difficulty > 0 ? difficulty : 0;
}

function normalizeHex(hex) {
    if (!hex) return '';
    let h = hex.toString().trim();
    if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2);
    return h.toLowerCase();
}

function normalizeNonce64(hex) {
    let h = normalizeHex(hex);
    if (h.length > 16) h = h.slice(-16);
    return h.padStart(16, '0');
}

function normalizeMixHash(hex) {
    const h = normalizeHex(hex);
    if (h.length !== 64) return null;
    return h;
}

function compareTarget(hashHex, targetHex) {
    const h = BigInt('0x' + hashHex);
    const t = BigInt('0x' + targetHex);
    return h <= t;
}

// Base58 Encoding Map (used locally for script building - now in address.js)


function buildMerkleRoot(coinbaseHashLE, txHashLEs) {
    let layer = [coinbaseHashLE, ...txHashLEs];
    while (layer.length > 1) {
        const next = [];
        for (let i = 0; i < layer.length; i += 2) {
            const left = layer[i];
            const right = (i + 1 < layer.length) ? layer[i + 1] : layer[i];
            next.push(sha256d(Buffer.concat([left, right])));
        }
        layer = next;
    }
    return layer[0];
}

function buildCoinbaseTx(opts) {
    const height = opts.height;
    const payoutAddress = opts.payoutAddress;
    const extraNonce1 = opts.extraNonce1 || Buffer.alloc(4, 0);
    const extraNonce2 = opts.extraNonce2 || Buffer.alloc(4, 0);
    const template = opts.template;
    const feeValueSats = opts.feeValueSats || 0n;

    const useSegwit = Boolean(template.default_witness_commitment);

    const scriptP1 = Buffer.concat([serializeNumber(height), Buffer.from('0648656d70307808', 'hex')]);
    const script = Buffer.concat([scriptP1, extraNonce1, extraNonce2]);
    const scriptLen = varIntBuffer(script.length);

    const input = Buffer.concat([
        Buffer.alloc(32, 0),
        Buffer.from('ffffffff', 'hex'),
        scriptLen, script,
        Buffer.from('ffffffff', 'hex')
    ]);

    const outputs = [];
    const coinbaseValue = BigInt(template.coinbasevalue || 0);
    let minerValue = coinbaseValue;

    if (feeValueSats > 0n && feeValueSats < coinbaseValue) {
        minerValue = coinbaseValue - feeValueSats;
        const feeScript = buildP2PKHScript(POOL_WALLET);
        const feeValue = Buffer.alloc(8);
        feeValue.writeBigUInt64LE(feeValueSats);
        outputs.push(Buffer.concat([feeValue, varIntBuffer(feeScript.length), feeScript]));
    }

    const minerScript = buildP2PKHScript(payoutAddress);
    const minerValueBuf = Buffer.alloc(8);
    minerValueBuf.writeBigUInt64LE(minerValue);
    outputs.unshift(Buffer.concat([minerValueBuf, varIntBuffer(minerScript.length), minerScript]));

    if (useSegwit) {
        const commitment = Buffer.from(template.default_witness_commitment, 'hex');
        const zeroValue = Buffer.alloc(8, 0);
        outputs.push(Buffer.concat([zeroValue, varIntBuffer(commitment.length), commitment]));
    }

    const outputCount = varIntBuffer(outputs.length);
    const version = Buffer.from('01000000', 'hex');
    const locktime = Buffer.alloc(4, 0);

    const baseTx = Buffer.concat([
        version,
        varIntBuffer(1),
        input,
        outputCount,
        ...outputs,
        locktime
    ]);

    let fullTx = baseTx;
    if (useSegwit) {
        const markerFlag = Buffer.from('0001', 'hex');
        const witness = Buffer.concat([
            Buffer.from([0x01]),
            Buffer.from([0x20]),
            Buffer.alloc(32, 0)
        ]);
        fullTx = Buffer.concat([
            version,
            markerFlag,
            varIntBuffer(1),
            input,
            outputCount,
            ...outputs,
            witness,
            locktime
        ]);
    }

    const txid = sha256d(baseTx);
    return {
        tx: fullTx,
        txid: txid,
        txidHex: reverseBuffer(txid).toString('hex')
    };
}

function buildHeaderHash(template, merkleRootLE, time) {
    const version = Buffer.alloc(4); version.writeUInt32LE(template.version >>> 0);
    const prevHash = reverseBuffer(hexToBuffer(template.previousblockhash));
    const nTime = Buffer.alloc(4); nTime.writeUInt32LE(time >>> 0);
    const bits = reverseBuffer(hexToBuffer(template.bits));
    const height = Buffer.alloc(4); height.writeUInt32LE(template.height >>> 0);

    const headerInput = Buffer.concat([version, prevHash, merkleRootLE, nTime, bits, height]);
    const hash = sha256d(headerInput);
    return reverseBuffer(hash).toString('hex');
}

function buildBlockHeader(opts) {
    const version = Buffer.alloc(4); version.writeUInt32LE(opts.version >>> 0);
    const prevHash = reverseBuffer(hexToBuffer(opts.prevHash));
    const nTime = Buffer.alloc(4); nTime.writeUInt32LE(opts.time >>> 0);
    const bits = reverseBuffer(hexToBuffer(opts.bits));
    const height = Buffer.alloc(4); height.writeUInt32LE(opts.height >>> 0);

    const nonce64 = BigInt('0x' + opts.nonce64Hex);
    const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(nonce64);

    const mixHashBuf = reverseBuffer(hexToBuffer(opts.mixHashHex));

    return Buffer.concat([version, prevHash, opts.merkleRootLE, nTime, bits, height, nonceBuf, mixHashBuf]);
}

function buildBlockHex(job, nonce64Hex, mixHashHex) {
    const header = buildBlockHeader({
        version: job.template.version,
        prevHash: job.template.previousblockhash,
        merkleRootLE: job.merkleRoot,
        time: job.time,
        bits: job.bits,
        height: job.height,
        nonce64Hex,
        mixHashHex
    });

    const txCount = 1 + job.template.transactions.length;
    const txs = [job.coinbaseTx, ...job.template.transactions.map(tx => Buffer.from(tx.data, 'hex'))];
    const blockBuf = Buffer.concat([header, varIntBuffer(txCount), ...txs]);
    return blockBuf.toString('hex');
}

const rpc = createRpcClient(config);

let daemonHealth = {
    ok: false,
    height: 0,
    lastChecked: 0,
    error: null
};

async function refreshDaemonHealth() {
    try {
        const height = await rpc('getblockcount');
        daemonHealth = {
            ok: true,
            height: Number(height) || 0,
            lastChecked: Date.now(),
            error: null
        };
    } catch (e) {
        daemonHealth = {
            ok: false,
            height: daemonHealth.height || 0,
            lastChecked: Date.now(),
            error: e.message || String(e)
        };
    }
}

// ====================================================================
//  JOB GENERATION & BROADCASTING
// ====================================================================

function shouldBroadcastTemplateChange(currentTemplate, nextTemplate) {
    if (!currentTemplate) return true;

    if (nextTemplate.previousblockhash !== currentTemplate.previousblockhash) return true;
    if (nextTemplate.bits !== currentTemplate.bits) return true;
    if (nextTemplate.target !== currentTemplate.target) return true;

    const nextTxs = nextTemplate.transactions || [];
    const currTxs = currentTemplate.transactions || [];
    if (nextTxs.length !== currTxs.length) return true;

    for (let i = 0; i < nextTxs.length; i++) {
        const nextId = (nextTxs[i] && (nextTxs[i].txid || nextTxs[i].hash)) || '';
        const currId = (currTxs[i] && (currTxs[i].txid || currTxs[i].hash)) || '';
        if (nextId !== currId) return true;
    }

    return false;
}

function computeJobDifficulty(socketDiff, networkDiff, safetyFactor = 0.95) {
    if (!networkDiff || networkDiff <= 0 || !Number.isFinite(networkDiff)) return socketDiff;
    return Math.min(socketDiff, networkDiff * safetyFactor);
}

function getEffectiveSocketDifficulty(socket) {
    return computeJobDifficulty(socket.difficulty, currentNetworkDifficulty);
}

async function submitBlockWithRetry(rpcCall, blockHex, options = {}) {
    const timeoutMs = readInteger(options.timeoutMs, SUBMIT_BLOCK_RPC_TIMEOUT_MS, { min: 1000, max: 60000 });
    const retries = readInteger(options.retries, SUBMIT_BLOCK_RETRIES, { min: 0, max: 5 });
    const retryDelayMs = readInteger(options.retryDelayMs, SUBMIT_BLOCK_RETRY_DELAY_MS, { min: 0, max: 30000 });
    const logger = options.logger || console;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const result = await rpcCall('submitblock', [blockHex], { timeoutMs });
            return { ok: true, result, attempts: attempt + 1 };
        } catch (e) {
            lastError = e;
            if (attempt < retries) {
                logger.warn(`[SUBMITBLOCK] Attempt ${attempt + 1}/${retries + 1} failed; retrying in ${retryDelayMs}ms:`, sanitizeError(e));
                if (retryDelayMs > 0) await sleep(retryDelayMs);
            }
        }
    }

    return { ok: false, error: lastError, attempts: retries + 1 };
}

async function updateBlockTemplate() {
    try {
        const template = await rpc('getblocktemplate', [{}]);
        if (!template.target) template.target = bitsToTarget(template.bits);
        template.txHashBuffers = (template.transactions || []).map(tx => Buffer.from((tx.txid || tx.hash), 'hex').reverse());
        const templateDifficulty = bitsToDifficulty(template.bits);
        if (templateDifficulty > 0) {
            currentNetworkDifficulty = templateDifficulty;
        }

        if (shouldBroadcastTemplateChange(currentTemplate, template)) {
            const newPrev = !currentTemplate || template.previousblockhash !== currentTemplate.previousblockhash;
            currentTemplate = template;
            broadcastJob(newPrev);
        }
    } catch (e) {
        if (!isWarmupRpcError(e)) {
            console.error("[ERROR] Failed to update block template:", sanitizeError(e));
        }
    }
}

function buildJobForSocket(socket, clean, seedHash) {
    if (!currentTemplate) return;

    const template = currentTemplate;
    const height = template.height;
    const time = template.curtime;

    socket.extraNonce2 = crypto.randomBytes(4);

    const payoutAddress = (socket.mode === 'solo') ? socket.wallet : POOL_WALLET;
    let feeValue = 0n;
    if (socket.mode === 'solo' && SOLO_FEE > 0) {
        feeValue = BigInt(Math.floor(Number(template.coinbasevalue || 0) * SOLO_FEE));
    }

    const coinbase = buildCoinbaseTx({
        height,
        payoutAddress,
        extraNonce1: socket.extraNonce1,
        extraNonce2: socket.extraNonce2,
        template,
        feeValueSats: feeValue
    });

    const merkleRoot = buildMerkleRoot(coinbase.txid, template.txHashBuffers || []);
    const headerHash = buildHeaderHash(template, merkleRoot, time);
    const jobDifficulty = getEffectiveSocketDifficulty(socket);
    const target = difficultyToTarget(jobDifficulty);
    const jobId = nextJobId();

    const msg = JSON.stringify({
        method: "mining.notify",
        params: [
            jobId,
            headerHash,
            seedHash,
            target,
            clean,
            height,
            template.bits
        ]
    }) + '\n';
    const worker = workers.get(socket.workerId);
    if (worker && !worker.loggedJob) {
        worker.loggedJob = true;
        console.log("[JOB] " + socket.workerId + " params=" + JSON.stringify([jobId, headerHash, seedHash, target, clean, height, template.bits]));
    }

    socket.write(msg);
    const job = {
        jobId,
        headerHash,
        merkleRoot,
        coinbaseTx: coinbase.tx,
        time,
        height,
        bits: template.bits,
        target,
        difficulty: jobDifficulty,
        mode: socket.mode,
        payoutAddress,
        template: {
            version: template.version,
            previousblockhash: template.previousblockhash,
            transactions: template.transactions || [],
            target: template.target || bitsToTarget(template.bits),
            coinbasevalue: template.coinbasevalue || 0
        }
    };
    rememberJob(socket, job, clean);
}

function broadcastJob(clean = false) {
    if (!currentTemplate) return;
    const seedHash = getSeedHash(currentTemplate.height);

    openSockets.forEach(socket => {
        try {
            if (socket.destroyed || !socket.workerId) return;
            buildJobForSocket(socket, clean, seedHash);
        } catch (e) {
            console.error("[ERROR] Broadcast failed:", sanitizeError(e));
        }
    });
}

// ====================================================================
//  STRATUM SERVER
// ====================================================================

const server = net.createServer((socket) => {
    if (openSockets.length >= STRATUM_MAX_CONNECTIONS) {
        socket.end();
        return;
    }

    openSockets.push(socket);
    try {
        socket.extraNonce1 = Buffer.from((extraNonce1Generator++).toString(16).padStart(8, '0'), 'hex');
    } catch (e) {
        console.error("Socket ExtraNonce Init Failed:", sanitizeError(e));
        socket.extraNonce1 = Buffer.alloc(4, 0);
    }

    socket.workerId = null;
    socket.wallet = null;
    socket.mode = 'pool';
    socket.difficulty = VARDIFF_CONFIG.minDiff;
    socket.lastVardiffAdjust = Date.now();

    let buffer = '';

    socket.on('data', (data) => {
        if (socket.destroyed) return;
        if (!isStratumPayloadWithinLimit(Buffer.byteLength(buffer, 'utf8'), data.length)) {
            socket.destroy();
            return;
        }

        buffer += data.toString('utf8');
        if (buffer.includes('\n')) {
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (Buffer.byteLength(line, 'utf8') > STRATUM_MAX_LINE_BYTES) {
                    socket.destroy();
                    break;
                }
                if (!line.trim()) continue;
                if (!line.trim().startsWith('{')) continue;
                try {
                    const req = JSON.parse(line);
                    handleStratumRequest(socket, req);
                } catch (e) {
                    console.error("[ERROR] Invalid JSON in stratum:", e.message);
                }
            }
        }

        if (Buffer.byteLength(buffer, 'utf8') > STRATUM_MAX_LINE_BYTES) {
            socket.destroy();
        }
    });

    socket.on('error', () => {
        removeSocket(socket);
    });

    socket.on('close', () => {
        removeSocket(socket);
    });
});

function removeSocket(socket) {
    const idx = openSockets.indexOf(socket);
    if (idx !== -1) openSockets.splice(idx, 1);
}

function parseMode(password) {
    const p = (password || '').toString().toLowerCase().trim();
    if (!p) return 'pool';
    if (p === 's' || p === 'solo') return 'solo';
    if (p === 'x' || p === 'pool') return 'pool';
    const tokens = p.split(/[\s,;:|]+/).filter(Boolean);
    if (tokens.includes('s') || tokens.includes('solo')) return 'solo';
    if (tokens.includes('x') || tokens.includes('pool')) return 'pool';
    if (p.startsWith('s')) return 'solo';
    return 'pool';
}

function parseModeFromWorkerId(workerId) {
    const id = (workerId || '').toString().toLowerCase();
    if (id.match(/(^|[.\-_/+:])solo(\b|$)/)) return 'solo';
    return 'pool';
}

// ====================================================================
//  STRATUM REQUEST HANDLER
// ====================================================================

function handleStratumRequest(socket, req) {
    const { id, method, params } = req;

    if (method === 'mining.subscribe') {
        const en1 = socket.extraNonce1.toString('hex');
        socket.write(JSON.stringify({
            id, result: [["mining.notify", "session"], en1, 4], error: null
        }) + '\n');
        socket.write(JSON.stringify({
            method: "mining.set_difficulty", params: [getEffectiveSocketDifficulty(socket)]
        }) + '\n');
        console.log(`[SUBSCRIBE] EN1: ${en1}, Diff: ${socket.difficulty}`);

    } else if (method === 'mining.authorize') {
        const workerId = (params && typeof params[0] === 'string') ? params[0] : '';
        const password = (params && params[1] !== undefined) ? params[1] : 'x';

        if (!workerId || Buffer.byteLength(workerId, 'utf8') > MAX_WORKER_ID_BYTES) {
            writeStratumError(socket, id, 20, 'Invalid worker name');
            socket.destroy();
            return;
        }

        socket.workerId = workerId;
        socket.wallet = workerId.split('.')[0] || POOL_WALLET;


        if (!isRoutableAddress(socket.wallet)) {
            console.log(`[AUTHORIZE] Invalid wallet: ${sanitizeStratumLogValue(socket.wallet)} worker=${sanitizeStratumLogValue(workerId)}`);
            writeStratumError(socket, id, 20, 'Invalid wallet');
            socket.destroy();
            return;
        }

        socket.mode = parseMode(password);
        if (socket.mode !== 'solo') {
            socket.mode = parseModeFromWorkerId(workerId);
        }

        if (!workers.has(workerId)) {
            cleanupInactiveWorkers();
            if (workers.size >= MAX_WORKERS) {
                writeStratumError(socket, id, 20, 'Worker capacity reached');
                socket.destroy();
                return;
            }

            workers.set(workerId, {
                connectedAt: Date.now(),
                lastShare: Date.now(),
                lastSeen: Date.now(),
                shares: 0,
                validShares: 0,
                invalidShares: 0,
                duplicateShares: 0,
                hashrate: 0,
                difficulty: socket.difficulty,
                shareHistory: [],
                wallet: socket.wallet,
                mode: socket.mode
            });
            console.log(`[AUTHORIZE] New worker: ${sanitizeStratumLogValue(workerId)} (${socket.mode})`);
        } else {
            const worker = workers.get(workerId);
            worker.lastSeen = Date.now();
            worker.mode = socket.mode;
            console.log(`[AUTHORIZE] Worker reconnected: ${sanitizeStratumLogValue(workerId)} (${socket.mode})`);
        }

        socket.write(JSON.stringify({ id, result: true, error: null }) + '\n');
        setTimeout(() => buildJobForSocket(socket, true, getSeedHash(currentTemplate ? currentTemplate.height : 0)), 250);

    } else if (method === 'mining.submit') {
        handleShareSubmission(socket, params, id);

    } else if (method === 'mining.configure' || method === 'mining.extranonce.subscribe') {
        socket.write(JSON.stringify({ id, result: true, error: null }) + '\n');
    }
}

// ====================================================================
//  SHARE VALIDATION & BLOCK SUBMISSION
// ====================================================================

async function handleShareSubmission(socket, params, id) {
    const worker = workers.get(socket.workerId);
    if (!worker) {
        writeStratumError(socket, id, 21, 'Unauthorized worker');
        return;
    }

    let pendingShareKey = null;
    let validationAcquired = false;
    try {
        if (!params || params.length < 4) {
            worker.invalidShares++;
            writeStratumError(socket, id, 20, 'Invalid share');
            return;
        }

        const workerName = params[0];
        const jobIdStr = params[1];
        const nonceHexRaw = params[2];
        let mixHashRaw = params[3];

        const submittedJob = socket.recentJobs?.get(jobIdStr) || socket.currentJob;
        if (params.length >= 5 && submittedJob) {
            const p3 = normalizeHex(params[3]);
            const p4 = normalizeHex(params[4]);
            if (p3 === submittedJob.headerHash) {
                mixHashRaw = params[4];
            } else if (p4 === submittedJob.headerHash) {
                mixHashRaw = params[3];
            }
        }
        if (!worker.loggedSubmit) {
            worker.loggedSubmit = true;
            console.log("[SUBMIT] " + sanitizeStratumLogValue(workerName) + " job=" + JSON.stringify({ jobId: jobIdStr, headerHash: socket.currentJob ? socket.currentJob.headerHash : null, height: socket.currentJob ? socket.currentJob.height : null, target: socket.currentJob ? socket.currentJob.target : null }));
        }
        if (!submittedJob || submittedJob.jobId.toString() !== jobIdStr) {
            worker.invalidShares++;
            writeStratumError(socket, id, 21, 'Stale share');
            return;
        }

        const nonceHex = normalizeNonce64(nonceHexRaw);
        const mixHash = normalizeMixHash(mixHashRaw);
        if (!mixHash) {
            worker.invalidShares++;
            writeStratumError(socket, id, 20, 'Invalid mixhash');
            return;
        }

        const shareKey = `${jobIdStr}:${nonceHex}:${mixHash}`;
        if (!socket.seenShares) socket.seenShares = new Set();
        if (!socket.pendingShares) socket.pendingShares = new Set();
        if (socket.seenShares.has(shareKey)) {
            if (typeof worker.duplicateShares !== 'number') worker.duplicateShares = 0;
            worker.duplicateShares++;
            writeStratumError(socket, id, 22, 'Duplicate share');
            return;
        }
        if (socket.pendingShares.has(shareKey)) {
            if (typeof worker.duplicateShares !== 'number') worker.duplicateShares = 0;
            worker.duplicateShares++;
            writeStratumError(socket, id, 22, 'Duplicate share');
            return;
        }

        if (!canStartShareValidation(socket.pendingShares.size, activeShareValidations)) {
            writeStratumError(socket, id, 20, 'Share validation busy');
            return;
        }

        socket.pendingShares.add(shareKey);
        pendingShareKey = shareKey;
        activeShareValidations++;
        validationAcquired = true;

        const rpcNonce = '0x' + nonceHex;
        const job = submittedJob;

        const kawpow = await rpc('getkawpowhash', [job.headerHash, mixHash, rpcNonce, job.height, job.target]);

        const resultPass = kawpow && (kawpow.result === true || kawpow.result === 'true');
        if (!resultPass) {
            socket.pendingShares.delete(shareKey);
            pendingShareKey = null;
            worker.invalidShares++;
            writeStratumError(socket, id, 20, 'Invalid share');
            return;
        }

        if (!isAcceptedKawpowShare(kawpow)) {
            socket.pendingShares.delete(shareKey);
            pendingShareKey = null;
            worker.invalidShares++;
            writeStratumError(socket, id, 20, 'Low difficulty share');
            return;
        }

        socket.pendingShares.delete(shareKey);
        pendingShareKey = null;
        socket.seenShares.add(shareKey);
        if (socket.seenShares.size > 1000) {
            let dropped = 0;
            for (const k of socket.seenShares) {
                if (dropped >= 300) break;
                socket.seenShares.delete(k);
                dropped++;
            }
        }

        worker.shares++;
        worker.validShares++;
        worker.lastShare = Date.now();
        worker.lastSeen = Date.now();

        const shareDifficulty = job.difficulty || socket.difficulty;
        worker.shareHistory.push({ diff: shareDifficulty, time: Date.now() });
        const cutoff = Date.now() - HASHRATE_WINDOW_MS;
        while (worker.shareHistory.length > 0 && worker.shareHistory[0].time < cutoff) {
            worker.shareHistory.shift();
        }

        updateHashrate(worker);
        stats.shares++;

        if (job.mode === 'pool') {
            db.recordShare(worker.wallet, shareDifficulty).catch(err => {
                console.error('[DB] recordShare failed after retries:', sanitizeError(err));
            });
        }

        socket.write(JSON.stringify({ id, result: true, error: null }) + '\n');

        const digest = kawpow.digest || '';
        const networkTarget = job.template.target || bitsToTarget(job.bits);
        if (digest && compareTarget(digest, networkTarget)) {
            const blockHex = buildBlockHex(job, nonceHex, mixHash);
            const submission = await submitBlockWithRetry(rpc, blockHex);

            if (!submission.ok) {
                console.error(`[SUBMITBLOCK] Failed after ${submission.attempts} attempts for height ${job.height}:`, sanitizeError(submission.error));
                adjustDifficulty(socket, worker);
                return;
            }

            const submitResult = submission.result;
            if (submitResult === null) {
                console.log(`[BLOCK FOUND] Height ${job.height} | Finder: ${worker.wallet} | Mode: ${job.mode}`);
                const reward = Number(job.template.coinbasevalue || 0) / 100000000;
                db.recordBlock(job.height, digest, worker.wallet, reward, job.mode, job.payoutAddress).catch(err => {
                    console.error('[DB] recordBlock failed after retries:', sanitizeError(err));
                });

                if (job.mode === 'pool' && config.pool.rewardModel === 'pplns') {
                    const windowDifficulty = config.pool.pplnsWindowDifficulty;
                    if (windowDifficulty && typeof windowDifficulty === 'number' && Number.isFinite(windowDifficulty) && windowDifficulty > 0) {
                        try {
                            const miners = await db.snapshotPplnsWindowForBlock(job.height, windowDifficulty);
                            console.log(`[PPLNS] Snapshot ${miners.length} miners for block ${job.height} window (difficulty ${windowDifficulty})`);
                        } catch (err) {
                            console.error(`[PPLNS] Failed to snapshot window for block ${job.height}:`, sanitizeError(err));
                        }
                    } else {
                        console.warn(`[PPLNS] rewardModel is pplns but pplnsWindowDifficulty is not valid (${windowDifficulty}); window not snapshotted for block ${job.height}`);
                    }
                }
            } else if (submitResult !== 'inconclusive') {
                console.log(`[DAEMON] Reject: ${submitResult}`);
            }
        }

        adjustDifficulty(socket, worker);

    } catch (e) {
        if (pendingShareKey && socket.pendingShares) {
            socket.pendingShares.delete(pendingShareKey);
        }
        console.error("[ERROR] Share validation failed:", sanitizeError(e));
        worker.invalidShares++;
        writeStratumError(socket, id, 20, 'Invalid share');
    } finally {
        if (validationAcquired) {
            activeShareValidations = Math.max(0, activeShareValidations - 1);
        }
    }
}

function updateHashrate(worker) {
    if (worker.shareHistory.length > 0) {
        const sumDiff = worker.shareHistory.reduce((sum, h) => sum + h.diff, 0);
        const firstShareTime = worker.shareHistory[0].time;
        const timeSinceFirst = (Date.now() - firstShareTime) / 1000;

        const maxWindowSeconds = HASHRATE_WINDOW_MS / 1000;
        const elapsedSeconds = Math.min(timeSinceFirst, maxWindowSeconds);
        const timeDivisor = Math.max(elapsedSeconds, MIN_HASHRATE_SAMPLE_SECONDS);

        const hashesPerSecond = (sumDiff * Math.pow(2, 32)) / timeDivisor;
        worker.hashrate = hashesPerSecond / HASHRATE_UNIT;

    } else {
        worker.hashrate = 0;
    }
}

function computeVardiffAdjustment(currentDiff, shareHistory, vardiffConfig, retargetDeadline) {
    if (shareHistory.length < 5) return { changed: false, newDiff: currentDiff };
    if (Date.now() < retargetDeadline) return { changed: false, newDiff: currentDiff };

    const recentShares = shareHistory.slice(-10);
    const times = [];
    for (let i = 1; i < recentShares.length; i++) {
        times.push((recentShares[i].time - recentShares[i - 1].time) / 1000);
    }
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    let newDiff = currentDiff;

    if (avgTime < vardiffConfig.targetTime * (1 - vardiffConfig.variance)) newDiff *= 1.5;
    if (avgTime > vardiffConfig.targetTime * (1 + vardiffConfig.variance)) newDiff /= 1.5;

    newDiff = Math.max(vardiffConfig.minDiff, Math.min(newDiff, vardiffConfig.maxDiff));

    return { changed: newDiff !== currentDiff, newDiff };
}

function isLocalRequest(req) {
    const addr = req.ip || req.socket?.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function canServeAdminDashboard(req, cfg) {
    const adminToken = cfg.adminToken || process.env.HEMP0X_POOL_ADMIN_TOKEN;
    return Boolean(adminToken) || isLocalRequest(req);
}

function adjustDifficulty(socket, worker) {
    const result = computeVardiffAdjustment(
        socket.difficulty,
        worker.shareHistory,
        VARDIFF_CONFIG,
        socket.lastVardiffAdjust + VARDIFF_CONFIG.retargetTime * 1000
    );

    if (result.changed) {
        socket.difficulty = result.newDiff;
        worker.difficulty = result.newDiff;
        socket.write(JSON.stringify({ method: "mining.set_difficulty", params: [getEffectiveSocketDifficulty(socket)] }) + '\n');
        socket.lastVardiffAdjust = Date.now();
        console.log(`[VARDIFF] Adjust ${socket.workerId}: ${result.newDiff.toFixed(2)}`);
        buildJobForSocket(socket, false, getSeedHash(currentTemplate ? currentTemplate.height : 0));
    }
}

// ====================================================================
//  EXPRESS APP (refactored for testability)
// ====================================================================

/**
 * Creates and configures the Express app without binding to a port.
 * Accepts an optional config object for testing.
 */
function createApp(cfg) {
    const appConfig = cfg || config;
    const app = express();

    // Security headers middleware
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '0');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
        next();
    });

    app.get('/admin.html', (req, res, next) => {
        if (!canServeAdminDashboard(req, appConfig)) {
            return res.status(404).send('Not found');
        }
        next();
    });

    app.use(express.static('public'));

    // Body parsing for admin validation endpoint (strict size limit)
    app.use(express.json({ limit: '64kb' }));

    // ====================================================================
    //  PUBLIC ENDPOINTS
    // ====================================================================

    app.get('/stats', async (req, res) => {
        try {
            const now = Date.now();
            let activeMiners = 0;
            let poolHashrate = 0;

            workers.forEach(w => {
                if (now - w.lastSeen < 120000) {
                    activeMiners++;
                    poolHashrate += w.hashrate;
                }
            });

            const paidBlocks = await db.countPaidBlocks();
            const poolBlocksFound = await db.countBlocksByModeExcludingStatus('pool', 'orphaned');
            const poolOrphanedBlocks = await db.countBlocksByModeAndStatus('pool', 'orphaned');
            const soloBlocksFound = await db.countAllBlocks('solo');

            res.json({
                shares: stats.shares,
                hashrate: poolHashrate.toFixed(2),
                miners: activeMiners,
                fees: `${(POOL_FEE * 100).toFixed(1)}%`,
                paidBlocks,
                totalBlocks: poolBlocksFound,
                soloBlocksFound,
                poolOrphanedBlocks,
                currentHeight: currentTemplate ? currentTemplate.height : 0,
                blockConfirmations: appConfig.pool.blockConfirmations || 0,
                historyHours: HISTORY_HOURS
            });
        } catch (e) {
            res.status(500).json({ error: sanitizeError(e) });
        }
    });

    app.get('/miners', (req, res) => {
        try {
            const list = [];
            const now = Date.now();
            const limit = clampLimit(req.query.limit, 200, 500);
            let count = 0;
            workers.forEach(w => {
                if (now - w.lastSeen < 120000 && count < limit) {
                    list.push({
                        wallet: w.wallet,
                        hashrate: w.hashrate,
                        validShares: w.validShares,
                        invalidShares: w.invalidShares,
                        duplicateShares: w.duplicateShares || 0,
                        workers: 1,
                        lastShare: w.lastShare,
                        mode: w.mode
                    });
                    count++;
                }
            });
            res.json(list);
        } catch (e) {
            res.status(500).json({ error: sanitizeError(e) });
        }
    });

    app.get('/connect-info', (req, res) => {
        try {
            const hostHeader = req.headers.host || req.hostname || '127.0.0.1';
            const host = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
            const donationAddress = (appConfig.frontend && appConfig.frontend.donationAddress)
                ? appConfig.frontend.donationAddress
                : POOL_WALLET;
            const rewardModel = (appConfig.pool && appConfig.pool.rewardModel) ? appConfig.pool.rewardModel : 'finder-plus-equal';
            const finderBonusPercent = (appConfig.pool && appConfig.pool.finderBonusPercent !== undefined)
                ? Number(appConfig.pool.finderBonusPercent)
                : 0;
            const activeWindowMinutes = (appConfig.pool && appConfig.pool.activeWindowMinutes !== undefined)
                ? Number(appConfig.pool.activeWindowMinutes)
                : 30;
            const minActiveMinutes = (appConfig.pool && appConfig.pool.minActiveMinutes !== undefined)
                ? Number(appConfig.pool.minActiveMinutes)
                : 2;
            const pplnsWindowDifficulty = (appConfig.pool && appConfig.pool.pplnsWindowDifficulty !== undefined)
                ? Number(appConfig.pool.pplnsWindowDifficulty)
                : undefined;
            res.json({
                stratum: `stratum+tcp://${host}:${STRATUM_PORT}`,
                poolPass: 'x',
                soloPass: 's',
                donationAddress,
                rewardModel,
                finderBonusPercent,
                activeWindowMinutes,
                minActiveMinutes,
                poolFeePercent: Number((POOL_FEE * 100).toFixed(2)),
                pplnsWindowDifficulty,
                health: {
                    daemonOk: daemonHealth.ok,
                    blockHeight: daemonHealth.height,
                    lastChecked: daemonHealth.lastChecked,
                    error: daemonHealth.error ? sanitizeError(daemonHealth.error) : null,
                    webUptimeSec: Math.floor(process.uptime())
                }
            });
        } catch (e) {
            res.status(500).json({ error: sanitizeError(e) });
        }
    });

    app.get('/blocks', async (req, res) => {
        try {
            const limit = clampLimit(req.query.limit, 20, 200);
            const blocks = await db.getBlocks(limit, 'pool');
            res.json(blocks);
        } catch (e) {
            res.status(500).json({ error: sanitizeError(e) });
        }
    });

    app.get('/miner/:address/stats', async (req, res) => {
        try {
            const addr = req.params.address;
            if (!isRoutableAddress(addr)) {
                return res.status(400).json({ error: 'Invalid Hemp0x address format' });
            }
            const historyLimit = clampLimit(req.query.history, 1000, 5000);
            const history = await db.getMinerHistory(addr, HISTORY_HOURS * 3600000);
            const blocksFound = await db.getMinerBlocks(addr, 100);
            // Historical payout rows are kept for API compatibility. Miner-facing UI renders ledgerPayouts.
            const payouts = await db.getMinerPayouts(addr, 100);
            const ledgerPayouts = typeof db.getMinerLedgerPayouts === 'function'
                ? await db.getMinerLedgerPayouts(addr, 100)
                : [];
            const blocksFoundCount = await db.countMinerBlocks(addr);
            const financials = await db.getMinerFinancials(addr);
            if (typeof db.getMinerLedgerFinancials === 'function') {
                const ledgerFinancials = await db.getMinerLedgerFinancials(addr);
                financials.totalPaid += ledgerFinancials.totalPaid;
                financials.poolRewards += ledgerFinancials.poolRewards;
                financials.finderRewards += ledgerFinancials.finderRewards;
            }

            let currentHashrate = 0;
            let workerCount = 0;

            workers.forEach(w => {
                if (w.wallet === addr && (Date.now() - w.lastSeen < 120000)) {
                    currentHashrate += w.hashrate;
                    workerCount++;
                }
            });

            res.json({
                history: history.slice(0, historyLimit),
                currentHashrate: currentHashrate.toFixed(2),
                workerCount,
                blocksFound,
                payouts,
                ledgerPayouts,
                blocksFoundCount,
                financials,
                blockConfirmations: appConfig.pool.blockConfirmations || 0,
                historyHours: HISTORY_HOURS
            });
        } catch (e) { res.status(500).json({ error: sanitizeError(e) }); }
    });

    app.get('/miner/:address/workers', (req, res) => {
        try {
            const addr = req.params.address;
            if (!isRoutableAddress(addr)) {
                return res.status(400).json({ error: 'Invalid Hemp0x address format' });
            }
            const result = [];
            workers.forEach((w, id) => {
                if (w.wallet === addr && (Date.now() - w.lastSeen < 120000)) {
                    result.push({
                        id,
                        hashrate: w.hashrate.toFixed(2),
                        difficulty: w.difficulty,
                        validShares: w.validShares,
                        invalidShares: w.invalidShares,
                        shares: w.shares,
                        lastShare: w.lastShare,
                        mode: w.mode
                    });
                }
            });
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: sanitizeError(e) });
        }
    });

    // ====================================================================
    //  ADMIN ENDPOINTS (read-only)
    // ====================================================================

    initAdminRoutes(app, appConfig, {
        workers,
        stats,
        get daemonHealth() { return daemonHealth; },
        get currentTemplate() { return currentTemplate; },
        db,
        rawDb: db ? db.getConnection() : null,
        rpc,
    });

    return app;
}

// ====================================================================
//  START
// ====================================================================

async function applyDatabaseMigrations() {
    const runner = new MigrationRunner(db.getConnection(), path.resolve(__dirname, 'migrations'));
    await runner.applyMigrations();
}

async function start() {
    try { db.init(); } catch (e) { console.error("DB Init Failed", sanitizeError(e)); }
    try { await applyDatabaseMigrations(); } catch (e) { console.error("DB Migration Failed", sanitizeError(e)); throw e; }

    const rpcReadyTimeoutMs = Number(process.env.HEMP0X_RPC_READY_TIMEOUT_MS || 300000);
    const rpcReadyIntervalMs = Number(process.env.HEMP0X_RPC_READY_INTERVAL_MS || 5000);
    try {
        const ready = await waitForRpcReady({
            rpc,
            timeoutMs: rpcReadyTimeoutMs,
            intervalMs: rpcReadyIntervalMs,
            requireWallet: false,
            log: (message) => console.log(message),
        });
        console.log(`[POOL] RPC ready at height ${ready.height}`);
    } catch (e) {
        console.error("[POOL] RPC readiness check failed:", sanitizeError(e));
        throw e;
    }

    refreshDaemonHealth();
    setInterval(refreshDaemonHealth, 30000);
    updateBlockTemplate();
    setInterval(updateBlockTemplate, TEMPLATE_REFRESH_INTERVAL_MS);
    startWorkerCleanup();

    const app = createApp(config);

    server.listen(STRATUM_PORT, () => { console.log(`[POOL] Stratum on port ${STRATUM_PORT}`); });
    app.listen(WEB_PORT, () => { console.log(`[POOL] Web on http://localhost:${WEB_PORT}`); });
}

if (require.main === module) {
    start().catch((e) => {
        console.error("[POOL] Startup failed:", sanitizeError(e));
        process.exit(1);
    });
}

// Export for testing
module.exports = { createApp, start, computeVardiffAdjustment, computeJobDifficulty, updateHashrate, applyDatabaseMigrations, canServeAdminDashboard, shouldBroadcastTemplateChange, isAcceptedKawpowShare, difficultyToTarget, bitsToTarget, bitsToDifficulty, submitBlockWithRetry, isStratumPayloadWithinLimit, canStartShareValidation, sanitizeStratumLogValue };
