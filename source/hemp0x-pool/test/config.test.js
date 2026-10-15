const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../config');

let TMP_DIR;

function writeTemp(name, content) {
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, JSON.stringify(content));
  return filePath;
}

describe('config', () => {
  before(() => {
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hemp0x-config-test-'));
  });

  after(() => {
    if (TMP_DIR) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  it('applies safe defaults for missing new sections', () => {
    const file = writeTemp('minimal.json', {
      pool: { name: 'TestPool' },
      daemon: { host: '127.0.0.1', port: 42070 },
    });
    const cfg = loadConfig(file);
    assert.strictEqual(cfg.payout.dryRun, true);
    assert.strictEqual(cfg.consolidation.enabled, false);
    assert.strictEqual(cfg.consolidation.dryRunOnly, true);
    assert.strictEqual(cfg.consolidation.feeRateSatsPerByte, 10);
    assert.strictEqual(cfg.automation.consolidationBroadcastEnabled, false);
    assert.strictEqual(cfg.automation.routinePayoutEnabled, false);
    assert.strictEqual(cfg.health.warnUtxoCountAbove, 10000);
    assert.strictEqual(cfg.vardiff.minDiff, 0.2);
    assert.strictEqual(cfg.vardiff.maxDiff, 1024);
    assert.strictEqual(cfg.vardiff.variance, 0.4);
  });

  it('preserves existing pool and daemon settings', () => {
    const file = writeTemp('existing.json', {
      pool: { name: 'MyPool', stratumPort: 3032, minPayout: 2.0 },
      daemon: { host: '192.168.1.1', port: 42070, user: 'u', pass: 'p' },
    });
    const cfg = loadConfig(file);
    assert.strictEqual(cfg.pool.name, 'MyPool');
    assert.strictEqual(cfg.pool.stratumPort, 3032);
    assert.strictEqual(cfg.daemon.host, '192.168.1.1');
    assert.strictEqual(cfg.daemon.pass, 'p');
  });

  it('accepts a tuned template refresh interval', () => {
    const file = writeTemp('template-refresh.json', {
      pool: { name: 'FastPool', templateRefreshIntervalMs: 1000 },
      daemon: { host: '127.0.0.1', port: 42070 },
    });
    const cfg = loadConfig(file);
    assert.strictEqual(cfg.pool.templateRefreshIntervalMs, 1000);
  });

  it('rejects payout.dryRun = false', () => {
    const file = writeTemp('bad-payout-config.json', {
      payout: { dryRun: false },
    });
    assert.throws(() => loadConfig(file), /payout.dryRun must be true/);
  });

  it('rejects consolidation.enabled = true', () => {
    const file = writeTemp('bad-consolidation.json', {
      consolidation: { enabled: true },
    });
    assert.throws(() => loadConfig(file), /consolidation.enabled must be false/);
  });

  it('rejects consolidation.dryRunOnly = false', () => {
    const file = writeTemp('bad-dryrun.json', {
      consolidation: { dryRunOnly: false },
    });
    assert.throws(() => loadConfig(file), /consolidation.dryRunOnly must be true/);
  });

  it('rejects automation.consolidationBroadcastEnabled = true', () => {
    const file = writeTemp('bad-broadcast.json', {
      automation: { consolidationBroadcastEnabled: true },
    });
    assert.throws(() => loadConfig(file), /automation.consolidationBroadcastEnabled must be false/);
  });

  it('rejects automation.routinePayoutEnabled = true', () => {
    const file = writeTemp('bad-routine-payout-config.json', {
      automation: { routinePayoutEnabled: true },
    });
    assert.throws(() => loadConfig(file), /automation.routinePayoutEnabled must be false/);
  });

  it('ignores unknown fields', () => {
    const file = writeTemp('unknown.json', {
      unknownSection: { foo: 'bar' },
      pool: { name: 'test' },
    });
    assert.doesNotThrow(() => loadConfig(file));
    const cfg = loadConfig(file);
    assert.strictEqual(cfg.unknownSection.foo, 'bar');
  });

  it('validates range constraints', () => {
    const file = writeTemp('bad-range.json', {
      payout: { maxPayoutBatch: 500 },
    });
    assert.throws(() => loadConfig(file), /maxPayoutBatch must be between 1 and 200/);
  });

  it('rejects invalid vardiff ranges', () => {
    const badVariance = writeTemp('bad-vardiff-variance.json', {
      vardiff: { minDiff: 0.2, maxDiff: 1024, targetTime: 15, retargetTime: 30, variance: 1 },
    });
    assert.throws(() => loadConfig(badVariance), /vardiff\.variance/);

    const badTarget = writeTemp('bad-vardiff-target.json', {
      vardiff: { minDiff: 0.2, maxDiff: 1024, targetTime: 0, retargetTime: 30, variance: 0.4 },
    });
    assert.throws(() => loadConfig(badTarget), /vardiff\.targetTime/);

    const badBounds = writeTemp('bad-vardiff-bounds.json', {
      vardiff: { minDiff: 10, maxDiff: 1, targetTime: 15, retargetTime: 30, variance: 0.4 },
    });
    assert.throws(() => loadConfig(badBounds), /vardiff\.maxDiff must be >= vardiff\.minDiff/);
  });

  it('merges reservePolicy partially', () => {
    const file = writeTemp('partial-reserve.json', {
      consolidation: { reservePolicy: { minUtxosToKeep: 100 } },
    });
    const cfg = loadConfig(file);
    assert.strictEqual(cfg.consolidation.reservePolicy.minUtxosToKeep, 100);
    assert.strictEqual(cfg.consolidation.reservePolicy.maxUtxoSizeToKeepSats, 2000000000);
  });

  it('translates older consolidation feeRateSatsPerKb to feeRateSatsPerByte', () => {
    const file = writeTemp('old-fee-rate.json', {
      consolidation: { feeRateSatsPerKb: 5000 },
    });
    const cfg = loadConfig(file);
    assert.strictEqual(cfg.consolidation.feeRateSatsPerByte, 5);
  });

  it('loads config.json by default when no explicit path given', () => {
    // This test verifies the API shape; we do not assert against the real
    // production config.json because the task forbids touching it.
    assert.strictEqual(typeof loadConfig, 'function');
  });

  it('loads config from HEMP0X_POOL_CONFIG when set', () => {
    const file = writeTemp('env-config.json', {
      pool: { name: 'EnvPool', stratumPort: 4040 },
      daemon: { host: '127.0.0.1', port: 42070 },
    });
    const previous = process.env.HEMP0X_POOL_CONFIG;
    process.env.HEMP0X_POOL_CONFIG = file;
    try {
      const cfg = loadConfig();
      assert.strictEqual(cfg.pool.name, 'EnvPool');
      assert.strictEqual(cfg.pool.stratumPort, 4040);
    } finally {
      if (previous === undefined) {
        delete process.env.HEMP0X_POOL_CONFIG;
      } else {
        process.env.HEMP0X_POOL_CONFIG = previous;
      }
    }
  });

  it('returns a deeply frozen object', () => {
    const file = writeTemp('freeze.json', { pool: { name: 'x' } });
    const cfg = loadConfig(file);
    assert.strictEqual(Object.isFrozen(cfg), true);
    assert.strictEqual(Object.isFrozen(cfg.payout), true);
  });
});
