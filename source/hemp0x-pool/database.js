const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'pool.db');
const DB_RETRY_ATTEMPTS = 8;
const DB_RETRY_BASE_MS = 250;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isBusyError(err) {
    return err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED');
}

async function retryBusy(operation, label) {
    let lastErr = null;
    for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt++) {
        try {
            return await operation();
        } catch (err) {
            lastErr = err;
            if (!isBusyError(err) || attempt === DB_RETRY_ATTEMPTS) {
                throw err;
            }
            const delay = DB_RETRY_BASE_MS * attempt;
            console.warn(`[DB] ${label} busy; retry ${attempt}/${DB_RETRY_ATTEMPTS} in ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastErr;
}

class DatabaseManager {
    constructor(databasePath = dbPath) {
        this.db = new sqlite3.Database(databasePath, (err) => {
            if (err) console.error('DB Connection Error:', err.message);
            else console.log('Connected to the SQLite database.');
        });
        this.db.configure('busyTimeout', 30000);
        this.db.exec("PRAGMA busy_timeout = 30000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;", (err) => {
            if (err) console.error("PRAGMA Error:", err.message);
        });
    }

    run(sql, params = [], label = 'run') {
        return retryBusy(() => new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve(this);
            });
        }), label);
    }

    all(sql, params = [], label = 'all') {
        return retryBusy(() => new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        }), label);
    }

    init() {
        const schemas = [
            `CREATE TABLE IF NOT EXISTS shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                miner TEXT NOT NULL,
                difficulty REAL NOT NULL,
                timestamp INTEGER NOT NULL,
                valid INTEGER DEFAULT 1,
                paid INTEGER DEFAULT 0
            )`,
            `CREATE TABLE IF NOT EXISTS pplns_windows (
                block_height INTEGER NOT NULL,
                miner TEXT NOT NULL,
                total_difficulty REAL NOT NULL,
                share_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (block_height, miner)
            )`,
            `CREATE TABLE IF NOT EXISTS payouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                miner TEXT NOT NULL,
                amount REAL NOT NULL,
                txid TEXT,
                category TEXT DEFAULT 'pool',
                timestamp INTEGER NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS reward_balances (
                miner TEXT PRIMARY KEY,
                pool_amount REAL DEFAULT 0,
                finder_amount REAL DEFAULT 0
            )`,
            `CREATE TABLE IF NOT EXISTS blocks (
                height INTEGER PRIMARY KEY,
                hash TEXT NOT NULL,
                finder TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                reward REAL NOT NULL,
                status TEXT DEFAULT 'pending',
                paid INTEGER DEFAULT 0,
                mode TEXT DEFAULT 'pool',
                payout_address TEXT
            )`,
            `CREATE INDEX IF NOT EXISTS idx_shares_miner ON shares(miner)`,
            `CREATE INDEX IF NOT EXISTS idx_shares_paid ON shares(paid)`,
            `CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)`,
            `CREATE INDEX IF NOT EXISTS idx_shares_miner_timestamp ON shares(miner, timestamp)`,
            `CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status)`,
            `CREATE INDEX IF NOT EXISTS idx_blocks_finder ON blocks(finder)`,
            `CREATE INDEX IF NOT EXISTS idx_blocks_paid ON blocks(paid)`,
            `CREATE INDEX IF NOT EXISTS idx_payouts_miner_timestamp ON payouts(miner, timestamp)`,
            `CREATE INDEX IF NOT EXISTS idx_pplns_windows_block_height ON pplns_windows(block_height)`
        ];

        this.db.serialize(() => {
            schemas.forEach(schema => {
                this.db.run(schema, (err) => {
                    if (err) console.error("Schema Error:", err);
                });
            });

            // MIGRATIONS
            this.db.run("ALTER TABLE blocks ADD COLUMN paid INTEGER DEFAULT 0", () => {});
            this.db.run("ALTER TABLE blocks ADD COLUMN finder TEXT", () => {});
            this.db.run("ALTER TABLE blocks ADD COLUMN mode TEXT DEFAULT 'pool'", () => {});
            this.db.run("ALTER TABLE blocks ADD COLUMN payout_address TEXT", () => {});
            this.db.run("ALTER TABLE payouts ADD COLUMN category TEXT DEFAULT 'pool'", () => {});
        });
    }

    recordShare(miner, difficulty) {
        return this.run(
            "INSERT INTO shares (miner, difficulty, timestamp, valid, paid) VALUES (?, ?, ?, 1, 0)",
            [miner, difficulty, Date.now()],
            'recordShare'
        );
    }

    /** Historical payout table writer retained for compatibility with old database rows. */
    recordPayout(miner, amount, txid, category = 'pool') {
        return this.run(
            "INSERT INTO payouts (miner, amount, txid, category, timestamp) VALUES (?, ?, ?, ?, ?)",
            [miner, amount, txid, category, Date.now()],
            'recordPayout'
        );
    }

    getMinerStats(miner) {
        return new Promise((resolve, reject) => {
            this.db.get(
                "SELECT COUNT(*) as shareCount, SUM(difficulty) as totalDiff FROM shares WHERE miner = ? AND timestamp > ?",
                [miner, Date.now() - 3600000],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    getUnpaidShares() {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT * FROM shares WHERE paid = 0", (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    getActiveMiners(windowMs, minActiveMs) {
        return new Promise((resolve, reject) => {
            const now = Date.now();
            const windowStart = now - windowMs;
            const minActiveCutoff = now - minActiveMs;
            this.db.all(
                `SELECT miner, MIN(timestamp) as firstSeen
                 FROM shares
                 WHERE timestamp > ?
                 GROUP BY miner
                 HAVING MIN(timestamp) <= ?`,
                [windowStart, minActiveCutoff],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.map(r => r.miner));
                }
            );
        });
    }

    async getActiveMinersForBlock(blockTimestamp, windowMs, minActiveMs) {
        const windowStart = blockTimestamp - windowMs;
        const minActiveCutoff = blockTimestamp - minActiveMs;
        const rows = await this.all(
            `SELECT miner, MIN(timestamp) as firstSeen
             FROM shares
             WHERE timestamp > ? AND timestamp <= ?
             GROUP BY miner
             HAVING MIN(timestamp) <= ?`,
            [windowStart, blockTimestamp, minActiveCutoff],
            'getActiveMinersForBlock'
        );
        return rows.map(r => r.miner);
    }

    async getMinersForBlockWindow(blockTimestamp, windowMs) {
        const windowStart = blockTimestamp - windowMs;
        const rows = await this.all(
            `SELECT DISTINCT miner
             FROM shares
             WHERE timestamp > ? AND timestamp <= ?
             ORDER BY miner`,
            [windowStart, blockTimestamp],
            'getMinersForBlockWindow'
        );
        return rows.map(r => r.miner);
    }

    async getMinerShareWeightsForBlock(blockTimestamp, windowMs) {
        const windowStart = blockTimestamp - windowMs;
        const rows = await this.all(
            `SELECT miner, SUM(difficulty) as totalDifficulty
             FROM shares
             WHERE timestamp > ? AND timestamp <= ?
             GROUP BY miner`,
            [windowStart, blockTimestamp],
            'getMinerShareWeightsForBlock'
        );
        return rows.map(r => ({ miner: r.miner, totalDifficulty: Number(r.totalDifficulty) }));
    }

    addRewardBalance(miner, poolAmount, finderAmount) {
        return retryBusy(async () => {
            await this.run(
                "INSERT OR IGNORE INTO reward_balances (miner, pool_amount, finder_amount) VALUES (?, 0, 0)",
                [miner],
                'addRewardBalance.insert'
            );
            await this.run(
                "UPDATE reward_balances SET pool_amount = pool_amount + ?, finder_amount = finder_amount + ? WHERE miner = ?",
                [poolAmount, finderAmount, miner],
                'addRewardBalance.update'
            );
        }, 'addRewardBalance');
    }

    getRewardBalances() {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT miner, pool_amount, finder_amount FROM reward_balances", (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    clearRewardBalance(miner) {
        return this.run(
            "UPDATE reward_balances SET pool_amount = 0, finder_amount = 0 WHERE miner = ?",
            [miner],
            'clearRewardBalance'
        );
    }

    markSharesPaid(shareIds) {
        if (!shareIds || shareIds.length === 0) return Promise.resolve();
        const placeholders = shareIds.map(() => '?').join(',');
        return this.run(`UPDATE shares SET paid = 1 WHERE id IN (${placeholders})`, shareIds, 'markSharesPaid');
    }

    markSharesPaidThrough(timestamp) {
        return this.run(
            "UPDATE shares SET paid = 1 WHERE paid = 0 AND timestamp <= ?",
            [timestamp],
            'markSharesPaidThrough'
        );
    }

    getMinerHistory(miner, windowMs = 3600000) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    (timestamp / 60000) * 60000 as timeBucket, 
                    SUM(difficulty) as totalDiff 
                FROM shares 
                WHERE miner = ? AND timestamp > ? 
                GROUP BY timeBucket 
                ORDER BY timeBucket ASC
            `;
            this.db.all(sql, [miner, Date.now() - windowMs], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    recordBlock(height, hash, finder, reward, mode = 'pool', payoutAddress = null) {
        return this.run(
            "INSERT OR IGNORE INTO blocks (height, hash, finder, reward, timestamp, status, paid, mode, payout_address) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
            [height, hash, finder, reward, Date.now(), mode, payoutAddress],
            'recordBlock'
        ).catch(err => {
            console.error('[DB] recordBlock insert failed after retries:', err);
            throw err;
        });
    }

    getBlocks(limit = 10, mode = null) {
        return new Promise((resolve, reject) => {
            const params = [];
            let sql = "SELECT * FROM blocks WHERE status = 'pending'";
            if (mode) {
                sql += " AND mode = ?";
                params.push(mode);
            }
            sql += " ORDER BY height DESC LIMIT ?";
            params.push(limit);
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    countPaidBlocks() {
        return new Promise((resolve, reject) => {
            this.db.get("SELECT COUNT(*) as count FROM blocks WHERE paid = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.count : 0);
            });
        });
    }

    countAllBlocks(mode = null) {
        return new Promise((resolve, reject) => {
            if (!mode) {
                this.db.get("SELECT COUNT(*) as count FROM blocks", (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.count : 0);
                });
                return;
            }
            this.db.get("SELECT COUNT(*) as count FROM blocks WHERE mode = ?", [mode], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.count : 0);
            });
        });
    }

    countBlocksByModeAndStatus(mode, status) {
        return new Promise((resolve, reject) => {
            this.db.get(
                "SELECT COUNT(*) as count FROM blocks WHERE mode = ? AND status = ?",
                [mode, status],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.count : 0);
                }
            );
        });
    }

    countBlocksByModeExcludingStatus(mode, status) {
        return new Promise((resolve, reject) => {
            this.db.get(
                "SELECT COUNT(*) as count FROM blocks WHERE mode = ? AND status != ?",
                [mode, status],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.count : 0);
                }
            );
        });
    }

    getUnpaidConfirmedBlocks() {
        return this.all(
            "SELECT * FROM blocks WHERE status = 'confirmed' AND paid = 0 AND mode = 'pool' ORDER BY height ASC",
            [],
            'getUnpaidConfirmedBlocks'
        );
    }

    getUnpaidConfirmedBlocksForAddress(address) {
        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT * FROM blocks WHERE status = 'confirmed' AND paid = 0 AND mode = 'pool' AND payout_address = ?",
                [address],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    markBlocksPaid(blockHeights) {
        return new Promise((resolve, reject) => {
            if (blockHeights.length === 0) return resolve();
            const placeholders = blockHeights.map(() => '?').join(',');
            this.db.run(`UPDATE blocks SET paid = 1, status = 'paid' WHERE height IN (${placeholders})`, blockHeights, function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    markBlocksCredited(blockHeights) {
        if (blockHeights.length === 0) return Promise.resolve(0);
        const placeholders = blockHeights.map(() => '?').join(',');
        return this.run(
            `UPDATE blocks SET paid = 1, status = 'credited' WHERE height IN (${placeholders})`,
            blockHeights,
            'markBlocksCredited'
        ).then(result => result.changes);
    }

    getPendingBlocks() {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT * FROM blocks WHERE status = 'pending'", (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    updateBlockStatus(height, status) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare("UPDATE blocks SET status = ? WHERE height = ?");
            stmt.run(status, height, (err) => {
                if (err) reject(err);
                else resolve();
            });
            stmt.finalize();
        });
    }

    getMinerBlocks(miner, limit = 100) {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT * FROM blocks WHERE finder = ? ORDER BY height DESC LIMIT ?", [miner, limit], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    /** Read from historical `payouts` rows; miner-facing payout activity uses the ledger pipeline. */
    getMinerPayouts(miner, limit = 100) {
        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT * FROM payouts WHERE miner = ? ORDER BY timestamp DESC LIMIT ?",
                [miner, limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    getMinerLedgerPayouts(miner, limit = 100) {
        return this.all(
            `SELECT
                pbo.address AS miner,
                pbo.amount_sats,
                pbo.category,
                pb.txid,
                pb.status AS batch_status,
                pb.batch_index,
                pr.id AS run_id,
                pr.status AS run_status,
                pr.created_at AS timestamp
             FROM payout_batch_outputs pbo
             JOIN payout_batches pb ON pb.id = pbo.batch_id
             JOIN payout_runs pr ON pr.id = pb.run_id
             WHERE pbo.address = ?
               AND pb.status IN ('broadcasted', 'confirmed')
             ORDER BY pr.created_at DESC, pb.batch_index DESC
             LIMIT ?`,
            [miner, limit],
            'getMinerLedgerPayouts'
        );
    }

    getMinerLedgerFinancials(miner) {
        return this.all(
            `SELECT
                COALESCE(SUM(pbo.amount_sats), 0) AS total_sats,
                COALESCE(SUM(CASE WHEN pbo.category = 'finder' THEN pbo.amount_sats ELSE 0 END), 0) AS finder_sats,
                COALESCE(SUM(CASE WHEN pbo.category != 'finder' THEN pbo.amount_sats ELSE 0 END), 0) AS pool_sats
             FROM payout_batch_outputs pbo
             JOIN payout_batches pb ON pb.id = pbo.batch_id
             WHERE pbo.address = ?
               AND pb.status IN ('broadcasted', 'confirmed')`,
            [miner],
            'getMinerLedgerFinancials'
        ).then(rows => {
            const row = rows && rows[0] ? rows[0] : {};
            return {
                totalPaid: Number(row.total_sats || 0) / 100000000,
                poolRewards: Number(row.pool_sats || 0) / 100000000,
                finderRewards: Number(row.finder_sats || 0) / 100000000
            };
        });
    }

    countMinerBlocks(miner) {
        return new Promise((resolve, reject) => {
            this.db.get("SELECT COUNT(*) as count FROM blocks WHERE finder = ?", [miner], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.count : 0);
            });
        });
    }

    async snapshotPplnsWindowForBlock(blockHeight, windowDifficulty) {
        const existing = await this.all(
            'SELECT COUNT(*) as cnt FROM pplns_windows WHERE block_height = ?',
            [blockHeight],
            'snapshotPplnsWindow.check'
        );
        if (existing[0].cnt > 0) return [];

        const rows = await this.all(
            `SELECT miner, difficulty FROM shares
             WHERE valid = 1
             ORDER BY timestamp DESC, id DESC
             LIMIT 50000`,
            [],
            'snapshotPplnsWindow.select'
        );
        if (rows.length === 0) return [];

        let cumulative = 0;
        const windowRows = [];
        for (const row of rows) {
            cumulative += Number(row.difficulty);
            windowRows.push(row);
            if (cumulative >= windowDifficulty) break;
        }
        if (windowRows.length === 0) return [];

        const minerMap = new Map();
        for (const row of windowRows) {
            const entry = minerMap.get(row.miner) || { totalDifficulty: 0, shareCount: 0 };
            entry.totalDifficulty += Number(row.difficulty);
            entry.shareCount += 1;
            minerMap.set(row.miner, entry);
        }

        const now = Date.now();
        const insertions = [];
        for (const [miner, agg] of minerMap) {
            insertions.push(
                this.run(
                    'INSERT OR IGNORE INTO pplns_windows (block_height, miner, total_difficulty, share_count, created_at) VALUES (?, ?, ?, ?, ?)',
                    [blockHeight, miner, agg.totalDifficulty, agg.shareCount, now],
                    'snapshotPplnsWindow.insert'
                )
            );
        }
        await Promise.all(insertions);
        return Array.from(minerMap.keys());
    }

    async getPplnsWeightsForBlock(blockHeight) {
        const rows = await this.all(
            `SELECT miner, total_difficulty as totalDifficulty
             FROM pplns_windows
             WHERE block_height = ?`,
            [blockHeight],
            'getPplnsWeightsForBlock'
        );
        return rows.map(r => ({ miner: r.miner, totalDifficulty: Number(r.totalDifficulty) }));
    }

    getConnection() {
        return this.db;
    }

    /** Reads historical `payouts` rows for base totals; ledger financials are layered on top. */
    getMinerFinancials(miner) {
        return new Promise((resolve, reject) => {
            const result = {
                totalPaid: 0,
                poolRewards: 0,
                finderRewards: 0,
                pendingShares: 0,
                pendingPool: 0,
                pendingFinder: 0
            };

            this.db.get("SELECT SUM(amount) as total FROM payouts WHERE miner = ?", [miner], (err, row) => {
                if (row && row.total) result.totalPaid = row.total;

                this.db.get("SELECT SUM(amount) as total FROM payouts WHERE miner = ? AND category = 'pool'", [miner], (err2, row2) => {
                    if (row2 && row2.total) result.poolRewards = row2.total;

                    this.db.get("SELECT SUM(amount) as total FROM payouts WHERE miner = ? AND category = 'finder'", [miner], (err3, row3) => {
                        if (row3 && row3.total) result.finderRewards = row3.total;

                        this.db.get("SELECT SUM(difficulty) as pending FROM shares WHERE miner = ? AND paid = 0", [miner], (err4, row4) => {
                            if (row4 && row4.pending) result.pendingShares = row4.pending;

                            this.db.get(
                                "SELECT pool_amount, finder_amount FROM reward_balances WHERE miner = ?",
                                [miner],
                                (err5, row5) => {
                                    if (row5) {
                                        result.pendingPool = row5.pool_amount || 0;
                                        result.pendingFinder = row5.finder_amount || 0;
                                    }
                                    resolve(result);
                                }
                            );
                        });
                    });
                });
            });
        });
    }
}

module.exports = new DatabaseManager();
module.exports.DatabaseManager = DatabaseManager;
