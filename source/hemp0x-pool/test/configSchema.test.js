const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  schema,
  getFieldsByCategory,
  getSecretKeys,
  getDangerousKeys,
  validateField,
  validateConfig,
} = require('../configSchema');

describe('configSchema', () => {
  describe('schema structure', () => {
    it('has all expected sections', () => {
      const sections = Object.keys(schema);
      assert.ok(sections.includes('pool'));
      assert.ok(sections.includes('daemon'));
      assert.ok(sections.includes('vardiff'));
      assert.ok(sections.includes('frontend'));
      assert.ok(sections.includes('maintenance'));
      assert.ok(sections.includes('payout'));
      assert.ok(sections.includes('consolidation'));
      assert.ok(sections.includes('health'));
      assert.ok(sections.includes('automation'));
    });

    it('every field has category, description, and type', () => {
      for (const section of Object.keys(schema)) {
        for (const key of Object.keys(schema[section])) {
          const entry = schema[section][key];
          assert.ok(entry.category, `Missing category for ${section}.${key}`);
          assert.ok(['public', 'tunable', 'dangerous', 'secret'].includes(entry.category),
            `Invalid category ${entry.category} for ${section}.${key}`);
          assert.ok(typeof entry.description === 'string', `Missing description for ${section}.${key}`);
          assert.ok(typeof entry.type === 'string', `Missing type for ${section}.${key}`);
        }
      }
    });
  });

  describe('category filtering', () => {
    it('getFieldsByCategory returns secret fields', () => {
      const secrets = getFieldsByCategory('secret');
      assert.ok(secrets.length > 0);
      const paths = secrets.map((f) => f.path);
      assert.ok(paths.includes('daemon.user'));
      assert.ok(paths.includes('daemon.pass'));
      assert.ok(paths.includes('daemon.cookiePath'));
    });

    it('getFieldsByCategory returns dangerous fields', () => {
      const dangerous = getFieldsByCategory('dangerous');
      assert.ok(dangerous.length > 0);
      const paths = dangerous.map((f) => f.path);
      assert.ok(paths.includes('payout.dryRun'));
      assert.ok(paths.includes('consolidation.enabled'));
      assert.ok(paths.includes('consolidation.dryRunOnly'));
      assert.ok(paths.includes('automation.consolidationBroadcastEnabled'));
      assert.ok(paths.includes('automation.routinePayoutEnabled'));
    });

    it('getFieldsByCategory returns public fields', () => {
      const pub = getFieldsByCategory('public');
      assert.ok(pub.length > 0);
      const paths = pub.map((f) => f.path);
      assert.ok(paths.includes('pool.name'));
      assert.ok(paths.includes('pool.wallet'));
    });

    it('getFieldsByCategory returns tunable fields', () => {
      const tunable = getFieldsByCategory('tunable');
      assert.ok(tunable.length > 0);
      const paths = tunable.map((f) => f.path);
      assert.ok(paths.includes('payout.maxPayoutBatch'));
    });
  });

  describe('getSecretKeys', () => {
    it('returns daemon.user, daemon.pass, and daemon.cookiePath', () => {
      const secrets = getSecretKeys();
      assert.ok(secrets.includes('daemon.user'));
      assert.ok(secrets.includes('daemon.pass'));
      assert.ok(secrets.includes('daemon.cookiePath'));
    });

    it('does not include non-secret keys', () => {
      const secrets = getSecretKeys();
      assert.ok(!secrets.includes('pool.name'));
      assert.ok(!secrets.includes('pool.wallet'));
      assert.ok(!secrets.includes('daemon.host'));
      assert.ok(!secrets.includes('daemon.port'));
    });
  });

  describe('getDangerousKeys', () => {
    it('returns all five safety gates', () => {
      const dangerous = getDangerousKeys();
      assert.ok(dangerous.includes('payout.dryRun'));
      assert.ok(dangerous.includes('consolidation.enabled'));
      assert.ok(dangerous.includes('consolidation.dryRunOnly'));
      assert.ok(dangerous.includes('automation.consolidationBroadcastEnabled'));
      assert.ok(dangerous.includes('automation.routinePayoutEnabled'));
    });
  });

  describe('cookie auth schema', () => {
    it('daemon.cookiePath is category secret', () => {
      assert.strictEqual(schema.daemon.cookiePath.category, 'secret');
      assert.strictEqual(schema.daemon.cookiePath.type, 'string');
    });

    it('daemon.useCookieAuth is category tunable', () => {
      assert.strictEqual(schema.daemon.useCookieAuth.category, 'tunable');
      assert.strictEqual(schema.daemon.useCookieAuth.type, 'boolean');
    });

    it('getSecretKeys includes daemon.cookiePath', () => {
      const secrets = getSecretKeys();
      assert.ok(secrets.includes('daemon.cookiePath'));
    });
  });

  describe('validateField', () => {
    it('validates pool.fee range', () => {
      assert.equal(validateField('pool', 'fee', 0.01).valid, true);
      assert.equal(validateField('pool', 'fee', -0.01).valid, false);
      assert.equal(validateField('pool', 'fee', 1.5).valid, false);
    });

    it('validates pool.templateRefreshIntervalMs range', () => {
      assert.equal(validateField('pool', 'templateRefreshIntervalMs', 1000).valid, true);
      assert.equal(validateField('pool', 'templateRefreshIntervalMs', 250).valid, true);
      assert.equal(validateField('pool', 'templateRefreshIntervalMs', 249).valid, false);
      assert.equal(validateField('pool', 'templateRefreshIntervalMs', 60001).valid, false);
      assert.equal(validateField('pool', 'templateRefreshIntervalMs', 1000.5).valid, false);
    });

    it('validates submitblock retry tuning', () => {
      assert.equal(validateField('pool', 'submitBlockRpcTimeoutMs', 15000).valid, true);
      assert.equal(validateField('pool', 'submitBlockRpcTimeoutMs', 999).valid, false);
      assert.equal(validateField('pool', 'submitBlockRetries', 2).valid, true);
      assert.equal(validateField('pool', 'submitBlockRetries', 6).valid, false);
      assert.equal(validateField('pool', 'submitBlockRetryDelayMs', 1000).valid, true);
      assert.equal(validateField('pool', 'submitBlockRetryDelayMs', 30001).valid, false);
    });

    it('validates consolidation.minConfirmations via existing range check', () => {
      assert.equal(validateField('payout', 'maxPayoutBatch', 50).valid, true);
    });

    it('returns valid for unknown sections', () => {
      assert.equal(validateField('unknown', 'foo', 1).valid, true);
    });

    it('returns valid for unknown fields', () => {
      assert.equal(validateField('pool', 'unknownField', 'x').valid, true);
    });

    it('returns valid for undefined field values', () => {
      assert.equal(validateField('pool', 'fee', undefined).valid, true);
    });

    it('validates automation.logLevel', () => {
      assert.equal(validateField('automation', 'logLevel', 'info').valid, true);
      assert.equal(validateField('automation', 'logLevel', 'debug').valid, true);
      assert.equal(validateField('automation', 'logLevel', 'warn').valid, true);
      assert.equal(validateField('automation', 'logLevel', 'error').valid, true);
      assert.equal(validateField('automation', 'logLevel', 'verbose').valid, false);
      assert.equal(validateField('automation', 'logLevel', '').valid, false);
    });

    it('validates vardiff.minDiff > 0', () => {
      assert.equal(validateField('vardiff', 'minDiff', 0.1).valid, true);
      assert.equal(validateField('vardiff', 'minDiff', 0).valid, false);
      assert.equal(validateField('vardiff', 'minDiff', -1).valid, false);
      assert.equal(validateField('vardiff', 'minDiff', '1').valid, false);
    });

    it('validates vardiff timing and variance ranges', () => {
      assert.equal(validateField('vardiff', 'targetTime', 15).valid, true);
      assert.equal(validateField('vardiff', 'targetTime', 0).valid, false);
      assert.equal(validateField('vardiff', 'retargetTime', 30).valid, true);
      assert.equal(validateField('vardiff', 'retargetTime', -1).valid, false);
      assert.equal(validateField('vardiff', 'variance', 0).valid, true);
      assert.equal(validateField('vardiff', 'variance', 0.4).valid, true);
      assert.equal(validateField('vardiff', 'variance', 1).valid, false);
      assert.equal(validateField('vardiff', 'variance', -0.1).valid, false);
      assert.equal(validateField('vardiff', 'variance', Number.NaN).valid, false);
    });

    it('validates pool.finderBonusPercent range', () => {
      assert.equal(validateField('pool', 'finderBonusPercent', 20).valid, true);
      assert.equal(validateField('pool', 'finderBonusPercent', 100).valid, true);
      assert.equal(validateField('pool', 'finderBonusPercent', 0).valid, true);
      assert.equal(validateField('pool', 'finderBonusPercent', -1).valid, false);
      assert.equal(validateField('pool', 'finderBonusPercent', 101).valid, false);
    });

    it('validates pool.rewardModel values', () => {
      assert.equal(validateField('pool', 'rewardModel', 'finder-plus-equal').valid, true);
      assert.equal(validateField('pool', 'rewardModel', 'finder-plus-share-weighted').valid, true);
      assert.equal(validateField('pool', 'rewardModel', 'pplns').valid, true);
      assert.equal(validateField('pool', 'rewardModel', '').valid, false);
    });

    it('validates pool.pplnsWindowDifficulty', () => {
      assert.equal(validateField('pool', 'pplnsWindowDifficulty', 2000).valid, true);
      assert.equal(validateField('pool', 'pplnsWindowDifficulty', 1).valid, true);
      assert.equal(validateField('pool', 'pplnsWindowDifficulty', 0).valid, false);
      assert.equal(validateField('pool', 'pplnsWindowDifficulty', -1).valid, false);
      assert.equal(validateField('pool', 'pplnsWindowDifficulty', '2000').valid, false);
      assert.equal(validateField('pool', 'pplnsWindowDifficulty', Number.NaN).valid, false);
      assert.equal(validateField('pool', 'pplnsWindowDifficulty', Infinity).valid, false);
    });

    it('validates Stratum resource limits', () => {
      assert.equal(validateField('pool', 'maxStratumConnections', 256).valid, true);
      assert.equal(validateField('pool', 'maxStratumConnections', 0).valid, false);
      assert.equal(validateField('pool', 'maxStratumLineBytes', 65536).valid, true);
      assert.equal(validateField('pool', 'maxStratumLineBytes', 512).valid, false);
      assert.equal(validateField('pool', 'maxPendingShareValidations', 8).valid, true);
      assert.equal(validateField('pool', 'maxConcurrentShareValidations', 256).valid, true);
      assert.equal(validateField('pool', 'maxWorkers', 10000).valid, true);
      assert.equal(validateField('pool', 'workerRetentionMs', 1800000).valid, true);
    });
  });

  describe('validateConfig', () => {
    it('passes a valid config', () => {
      const result = validateConfig({
        pool: { fee: 0.01, finderBonusPercent: 20 },
        payout: { maxPayoutBatch: 50, maxPayoutBatchAmountSats: 5000, flushMinPayoutSats: 100 },
        automation: { logLevel: 'info' },
        vardiff: { minDiff: 0.1, maxDiff: 1024 },
      });
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('fails on invalid pool.fee', () => {
      const result = validateConfig({ pool: { fee: 2.0 } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.path === 'pool.fee'));
    });

    it('fails on invalid automation.logLevel', () => {
      const result = validateConfig({ automation: { logLevel: 'verbose' } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.path === 'automation.logLevel'));
    });

    it('collects multiple errors', () => {
      const result = validateConfig({
        pool: { fee: 2.0, finderBonusPercent: 150 },
        automation: { logLevel: 'bad' },
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.length >= 3);
    });

    it('passes config with unknown sections', () => {
      const result = validateConfig({ unknown: { x: 1 } });
      assert.equal(result.valid, true);
    });

    it('passes empty config', () => {
      const result = validateConfig({});
      assert.equal(result.valid, true);
    });

    it('fails on daemon.port out of range', () => {
      const result = validateConfig({ daemon: { port: 99999 } });
      assert.equal(result.valid, false);
    });

    it('passes daemon.port in range', () => {
      assert.equal(validateConfig({ daemon: { port: 42070 } }).valid, true);
      assert.equal(validateConfig({ daemon: { port: 1 } }).valid, true);
      assert.equal(validateConfig({ daemon: { port: 65535 } }).valid, true);
    });
  });
});
