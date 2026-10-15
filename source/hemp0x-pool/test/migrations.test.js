const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MigrationRunner } = require('../migrations');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function createDb() {
    return new sqlite3.Database(':memory:');
}

describe('MigrationRunner', () => {
    /** @type {sqlite3.Database} */
    let db;
    let runner;

    before(async () => {
        db = createDb();
        runner = new MigrationRunner(db, migrationsDir);
    });

    after(() => {
        db.close();
    });

    it('applies all migrations and tracks versions', async () => {
        await runner.applyMigrations();

        const rows = await new Promise((resolve, reject) => {
            db.all('SELECT version, name FROM schema_migrations ORDER BY version ASC', (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        assert.ok(rows.length >= 4);
        assert.equal(rows[0].version, 1);
        assert.equal(rows[0].name, 'payout_ledger');
        assert.equal(rows[1].version, 2);
        assert.equal(rows[1].name, 'consolidation_ledger');
        assert.equal(rows[2].version, 3);
        assert.equal(rows[2].name, 'process_locks');
        assert.equal(rows[3].version, 4);
        assert.equal(rows[3].name, 'pplns_windows');
    });

    it('is idempotent on re-apply', async () => {
        await runner.applyMigrations();
        await runner.applyMigrations();

        const rows = await new Promise((resolve, reject) => {
            db.all('SELECT COUNT(*) as cnt FROM schema_migrations', (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        assert.equal(rows[0].cnt, 4);
    });

    it('creates payout ledger tables and indexes', async () => {
        const tables = ['payout_runs', 'payout_block_credits', 'payout_miner_credits', 'payout_batches', 'payout_batch_outputs', 'payout_events'];
        for (const table of tables) {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [table], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });
            assert.ok(row, `Table ${table} should exist`);
        }

        const indexes = ['idx_payout_runs_status', 'idx_payout_block_credits_run', 'idx_payout_batches_run', 'idx_payout_batch_outputs_batch'];
        for (const idx of indexes) {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT name FROM sqlite_master WHERE type='index' AND name = ?", [idx], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });
            assert.ok(row, `Index ${idx} should exist`);
        }
    });

    it('creates consolidation ledger tables and indexes', async () => {
        const tables = ['consolidation_plans', 'consolidation_batches', 'consolidation_batch_inputs', 'consolidation_events'];
        for (const table of tables) {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [table], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });
            assert.ok(row, `Table ${table} should exist`);
        }

        const indexes = ['idx_consolidation_batches_plan_id', 'idx_consolidation_batches_status', 'idx_consolidation_batch_inputs_batch_id'];
        for (const idx of indexes) {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT name FROM sqlite_master WHERE type='index' AND name = ?", [idx], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });
            assert.ok(row, `Index ${idx} should exist`);
        }
    });

    it('creates process_locks table', async () => {
        const row = await new Promise((resolve, reject) => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = 'process_locks'", (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        assert.ok(row);

        const row2 = await new Promise((resolve, reject) => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = 'schema_migrations'", (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        assert.ok(row2);
    });

    it('skips unrecognized files safely', async () => {
        const result = await runner.applyMigrations();
    });

    it('does not mutate historical compatibility tables', async () => {
        const compatibilityTables = ['blocks', 'payouts', 'reward_balances'];
        for (const table of compatibilityTables) {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [table], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });
            assert.equal(row, undefined, `Compatibility table ${table} should not exist in new DB`);
        }
    });

    it('creates pplns_windows table and index via migration 004', async () => {
        const tblRow = await new Promise((resolve, reject) => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = 'pplns_windows'", (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        assert.ok(tblRow, 'pplns_windows table should exist');

        const idxRow = await new Promise((resolve, reject) => {
            db.get("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_pplns_windows_block_height'", (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        assert.ok(idxRow, 'idx_pplns_windows_block_height index should exist');
    });
});
