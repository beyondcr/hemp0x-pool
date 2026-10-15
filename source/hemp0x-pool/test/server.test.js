const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  isStratumPayloadWithinLimit,
  canStartShareValidation,
  sanitizeStratumLogValue,
} = require('../server');

describe('server module', () => {
  it('can be required without starting web or stratum listeners', () => {
    const cwd = path.join(__dirname, '..');
    const result = spawnSync(
      process.execPath,
      ['-e', "const srv = require('./server'); if (typeof srv.createApp !== 'function') process.exit(2);"],
      { cwd, encoding: 'utf8', timeout: 2000 }
    );

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.strictEqual(result.signal, null);
    assert.ok(!result.stdout.includes('[POOL] Stratum'));
    assert.ok(!result.stdout.includes('[POOL] Web'));
  });

  it('rejects oversized Stratum payloads before they accumulate in memory', () => {
    assert.strictEqual(isStratumPayloadWithinLimit(0, 65536), true);
    assert.strictEqual(isStratumPayloadWithinLimit(131072, 1), false);
    assert.strictEqual(isStratumPayloadWithinLimit(0, 131073), false);
  });

  it('caps concurrent share validation work', () => {
    assert.strictEqual(canStartShareValidation(0, 0), true);
    assert.strictEqual(canStartShareValidation(8, 0), false);
    assert.strictEqual(canStartShareValidation(0, 256), false);
  });

  it('removes control characters from worker log values', () => {
    assert.strictEqual(sanitizeStratumLogValue('worker\nname\tvalue'), 'worker name value');
  });
});
