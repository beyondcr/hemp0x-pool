const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseManager } = require('../database');

function uniqueTestPath() {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return path.join(os.tmpdir(), `pool_test_retry_${id}.db`);
}

describe('recordShare and recordBlock use retry-backed path', () => {
    let dbm;
    let testDbPath;

    async function waitForSchema() {
        for (let attempt = 1; attempt <= 50; attempt++) {
            try {
                const rows = await dbm.all(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='shares'",
                    [], 'waitForSchema'
                );
                if (rows && rows.length > 0) return;
            } catch (e) {
                // retry
            }
            await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('schema did not initialize in time');
    }

    beforeEach(async () => {
        testDbPath = uniqueTestPath();
        dbm = new DatabaseManager(testDbPath);
        dbm.init();
        await waitForSchema();
    });

    afterEach(() => {
        if (dbm && dbm.db) {
            dbm.db.close();
        }
        try { fs.unlinkSync(testDbPath); } catch (e) { /* ok */ }
        try { fs.unlinkSync(testDbPath + '-wal'); } catch (e) { /* ok */ }
        try { fs.unlinkSync(testDbPath + '-shm'); } catch (e) { /* ok */ }
    });

    describe('recordShare', () => {
        it('inserts a row and can be queried back', async () => {
            const miner = 'RTestMiner11111111111111111111111111';
            await dbm.recordShare(miner, 0.5);

            const rows = await dbm.all(
                "SELECT * FROM shares WHERE miner = ?",
                [miner],
                'recordShare test select'
            );

            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].miner, miner);
            assert.strictEqual(rows[0].difficulty, 0.5);
            assert.strictEqual(rows[0].valid, 1);
            assert.strictEqual(rows[0].paid, 0);
        });

        it('inserts multiple shares for the same miner', async () => {
            const miner = 'RTestMiner21111111111111111111111111';
            await dbm.recordShare(miner, 1.0);
            await dbm.recordShare(miner, 2.0);

            const rows = await dbm.all(
                "SELECT * FROM shares WHERE miner = ? ORDER BY difficulty",
                [miner],
                'recordShare multi test'
            );

            assert.strictEqual(rows.length, 2);
            assert.strictEqual(rows[0].difficulty, 1.0);
            assert.strictEqual(rows[1].difficulty, 2.0);
        });

        it('returns a Promise', async () => {
            const result = dbm.recordShare('RTestMiner31111111111111111111111111', 0.3);
            assert.ok(result instanceof Promise);
            try { await result; } catch (e) { /* ignore */ }
        });
    });

    describe('recordBlock', () => {
        it('inserts a block row and can be queried back', async () => {
            await dbm.recordBlock(500001, 'abc123hash', 'RBlockFinder11111111111111111111111', 50.0, 'pool', 'RPayAddr111111111111111111111111111');

            const rows = await dbm.all(
                "SELECT * FROM blocks WHERE height = ?",
                [500001],
                'recordBlock test select'
            );

            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].height, 500001);
            assert.strictEqual(rows[0].hash, 'abc123hash');
            assert.strictEqual(rows[0].finder, 'RBlockFinder11111111111111111111111');
            assert.strictEqual(rows[0].reward, 50.0);
            assert.strictEqual(rows[0].status, 'pending');
            assert.strictEqual(rows[0].paid, 0);
            assert.strictEqual(rows[0].mode, 'pool');
            assert.strictEqual(rows[0].payout_address, 'RPayAddr111111111111111111111111111');
        });

        it('INSERT OR IGNORE prevents duplicate height rows', async () => {
            await dbm.recordBlock(500002, 'hash1', 'RFinder1111111111111111111111111111', 50.0, 'pool', null);
            await dbm.recordBlock(500002, 'hash2', 'RFinder2222222222222222222222222222', 60.0, 'pool', null);

            const rows = await dbm.all(
                "SELECT * FROM blocks WHERE height = ?",
                [500002],
                'recordBlock ignore test'
            );

            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].hash, 'hash1');
            assert.strictEqual(rows[0].finder, 'RFinder1111111111111111111111111111');
        });

        it('returns a Promise', async () => {
            const result = dbm.recordBlock(500003, 'hash3', 'RFinder3111111111111111111111111111', 50.0, 'pool', null);
            assert.ok(result instanceof Promise);
            try { await result; } catch (e) { /* ignore */ }
        });
    });
});
