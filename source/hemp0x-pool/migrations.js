const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MigrationRunner {
    /**
     * @param {object} db - sqlite3 Database instance
     * @param {string} migrationsDir - path to migrations directory
     */
    constructor(db, migrationsDir) {
        this.db = db;
        this.migrationsDir = migrationsDir;
    }

    ensureMigrationsTable() {
        return new Promise((resolve, reject) => {
            this.db.run(
                `CREATE TABLE IF NOT EXISTS schema_migrations (
                    version     INTEGER PRIMARY KEY,
                    name        TEXT NOT NULL,
                    applied_at  INTEGER NOT NULL,
                    checksum    TEXT
                )`,
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    getMigrationFiles() {
        if (!fs.existsSync(this.migrationsDir)) return [];
        return fs.readdirSync(this.migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();
    }

    checksumFile(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    parseVersion(filename) {
        const match = filename.match(/^(\d+)_(.+)\.sql$/);
        if (!match) return null;
        return { version: parseInt(match[1], 10), name: match[2] };
    }

    getAppliedVersions() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC',
                [],
                (err, rows) => { if (err) reject(err); else resolve(rows || []); }
            );
        });
    }

    execSQL(sql) {
        return new Promise((resolve, reject) => {
            this.db.exec(sql, (err) => { if (err) reject(err); else resolve(); });
        });
    }

    /**
     * Apply all pending migrations. Idempotent: skips already-applied versions.
     */
    async applyMigrations() {
        await this.execSQL('PRAGMA foreign_keys = ON;');
        await this.ensureMigrationsTable();
        const files = this.getMigrationFiles();
        const applied = await this.getAppliedVersions();
        const appliedVersions = new Set(applied.map(r => r.version));

        for (const file of files) {
            const parsed = this.parseVersion(file);
            if (!parsed) {
                console.warn(`[migrations] Skipping unrecognized file: ${file}`);
                continue;
            }
            if (appliedVersions.has(parsed.version)) {
                continue;
            }
            const filePath = path.join(this.migrationsDir, file);
            const sql = fs.readFileSync(filePath, 'utf-8');
            const checksum = this.checksumFile(filePath);

            await this.execSQL(sql);
            await new Promise((resolve, reject) => {
                this.db.run(
                    'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
                    [parsed.version, parsed.name, Date.now(), checksum],
                    function(err) { if (err) reject(err); else resolve(this); }
                );
            });
        }
    }
}

module.exports = { MigrationRunner };
