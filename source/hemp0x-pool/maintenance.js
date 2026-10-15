const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Config
const DB_PATH = path.resolve(__dirname, 'pool.db');
let retentionDays = 14;
try {
    const config = require('./config.json');
    if (config.maintenance && Number.isFinite(config.maintenance.retentionDays)) {
        retentionDays = config.maintenance.retentionDays;
    }
} catch (e) {
    console.warn("Failed to load config.json for maintenance settings, using defaults.");
}
const RETENTION_MS = retentionDays * 24 * 60 * 60 * 1000;

console.log(`Starting Database Maintenance (Retention: ${retentionDays} Days)...`);

const database = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('DB Connection Error:', err.message);
        process.exit(1);
    }
});

const timestampThreshold = Date.now() - RETENTION_MS;

database.serialize(() => {
    database.get("SELECT COUNT(*) as count FROM shares", (err, row) => {
        if (!err) console.log(`Current Total Shares: ${row.count}`);
    });

    const sql = "DELETE FROM shares WHERE timestamp < ? AND paid = 1";

    database.run(sql, [timestampThreshold], function (err) {
        if (err) {
            console.error("Prune Error:", err.message);
        } else {
            console.log(`Deleted ${this.changes} old paid share records.`);
        }
    });

    database.run("VACUUM", (err) => {
        if (err) console.error("Vacuum Error:", err);
        else console.log("Database Vacuumed/Optimized.");
        database.close();
    });
});
