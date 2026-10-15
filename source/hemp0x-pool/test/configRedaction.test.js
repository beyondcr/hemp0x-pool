const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  REDACTED,
  isSecretLike,
  redactSecrets,
  sanitizeError,
  clampLimit,
} = require('../configRedaction');

describe('configRedaction', () => {
  describe('isSecretLike', () => {
    it('identifies daemon.user as secret-like', () => {
      assert.equal(isSecretLike('daemon.user'), true);
      assert.equal(isSecretLike('daemon.pass'), true);
    });

    it('identifies cookiePath as secret-like', () => {
      assert.equal(isSecretLike('daemon.cookiePath'), true);
      assert.equal(isSecretLike('cookiePath'), true);
    });

    it('identifies password-like keys', () => {
      assert.equal(isSecretLike('pass'), true);
      assert.equal(isSecretLike('password'), true);
      assert.equal(isSecretLike('daemon.pass'), true);
    });

    it('identifies token-like keys', () => {
      assert.equal(isSecretLike('token'), true);
      assert.equal(isSecretLike('apiToken'), true);
    });

    it('identifies secret-like keys', () => {
      assert.equal(isSecretLike('secret'), true);
      assert.equal(isSecretLike('apiSecret'), true);
    });

    it('identifies key-like keys', () => {
      assert.equal(isSecretLike('key'), true);
      assert.equal(isSecretLike('apiKey'), true);
    });

    it('identifies auth-like keys', () => {
      assert.equal(isSecretLike('auth'), true);
      assert.equal(isSecretLike('authorization'), false);
    });

    it('identifies credential-like keys', () => {
      assert.equal(isSecretLike('credentials'), true);
      assert.equal(isSecretLike('credential'), true);
    });

    it('does not flag safe keys', () => {
      assert.equal(isSecretLike('host'), false);
      assert.equal(isSecretLike('port'), false);
      assert.equal(isSecretLike('pool.fee'), false);
      assert.equal(isSecretLike('wallet'), false);
      assert.equal(isSecretLike('name'), false);
    });
  });

  describe('redactSecrets', () => {
    it('redacts daemon.user and daemon.pass from flat config', () => {
      const config = {
        daemon: {
          host: '127.0.0.1',
          port: 42070,
          user: 'admin',
          pass: 'secret123',
        },
        pool: { name: 'TestPool' },
      };
      const result = redactSecrets(config);
      assert.equal(result.daemon.host, '127.0.0.1');
      assert.equal(result.daemon.port, 42070);
      assert.equal(result.daemon.user, REDACTED);
      assert.equal(result.daemon.pass, REDACTED);
      assert.equal(result.pool.name, 'TestPool');
    });

    it('redacts daemon.cookiePath via full-path check', () => {
      const config = {
        daemon: {
          host: '127.0.0.1',
          port: 42070,
          cookiePath: '/var/lib/example/.hemp/.cookie',
        },
      };
      const result = redactSecrets(config);
      assert.equal(result.daemon.host, '127.0.0.1');
      assert.equal(result.daemon.port, 42070);
      assert.equal(result.daemon.cookiePath, REDACTED);
    });

    it('redacts cookiePath at any nesting level', () => {
      const config = {
        nested: {
          deep: {
            cookiePath: '/some/path/.cookie',
          },
        },
      };
      const result = redactSecrets(config);
      assert.equal(result.nested.deep.cookiePath, REDACTED);
    });

    it('redacts nested secret-like keys at top level', () => {
      const config = {
        token: 'abc123',
        apiSecret: 'xyz789',
        pool: { name: 'pool' },
      };
      const result = redactSecrets(config);
      assert.equal(result.token, REDACTED);
      assert.equal(result.apiSecret, REDACTED);
      assert.equal(result.pool.name, 'pool');
    });

    it('redacts nested secret-like keys within sections', () => {
      const config = {
        daemon: {
          apiToken: 'tok123',
          secret: 'sec456',
        },
      };
      const result = redactSecrets(config);
      assert.equal(result.daemon.apiToken, REDACTED);
      assert.equal(result.daemon.secret, REDACTED);
    });

    it('handles deeply frozen objects', () => {
      const frozen = Object.freeze({
        daemon: Object.freeze({
          user: 'u',
          pass: 'p',
          host: 'h',
        }),
      });
      const result = redactSecrets(frozen);
      assert.equal(result.daemon.user, REDACTED);
      assert.equal(result.daemon.pass, REDACTED);
      assert.equal(result.daemon.host, 'h');
    });

    it('does not modify the original object', () => {
      const original = { daemon: { user: 'u', pass: 'p' } };
      const result = redactSecrets(original);
      assert.equal(original.daemon.pass, 'p');
      assert.equal(result.daemon.pass, REDACTED);
    });

    it('redacts deeply nested secret objects', () => {
      const config = {
        daemon: {
          credentials: {
            apiToken: 'nested-token',
          },
        },
      };
      const result = redactSecrets(config);
      assert.equal(result.daemon.credentials.apiToken, REDACTED);
    });

    it('handles arrays of objects', () => {
      const config = {
        items: [
          { token: 't1', name: 'a' },
          { token: 't2', name: 'b' },
        ],
      };
      const result = redactSecrets(config);
      assert.equal(result.items[0].token, REDACTED);
      assert.equal(result.items[0].name, 'a');
      assert.equal(result.items[1].token, REDACTED);
      assert.equal(result.items[1].name, 'b');
    });

    it('preserves arrays of primitives', () => {
      const config = { ports: [8080, 3032], auth: 'secret' };
      const result = redactSecrets(config);
      assert.deepEqual(result.ports, [8080, 3032]);
      assert.equal(result.auth, REDACTED);
    });

    it('handles null and undefined', () => {
      assert.equal(redactSecrets(null), null);
      assert.equal(redactSecrets(undefined), undefined);
      assert.equal(redactSecrets(42), 42);
      assert.equal(redactSecrets('hello'), 'hello');
    });
  });

  describe('sanitizeError', () => {
    it('passes through simple messages', () => {
      const result = sanitizeError('Something went wrong');
      assert.equal(result, 'Something went wrong');
    });

    it('strips file paths from stack traces', () => {
      const msg = 'Error: failed at /var/lib/example/project/src/config.js:123';
      const result = sanitizeError(msg);
      assert.ok(!result.includes('/var/lib/example/project/src/config.js'));
      assert.ok(result.includes('[path]/config.js'));
    });

    it('sanitizes Authorization headers', () => {
      const msg = 'RPC getblockcount failed with Authorization: Basic dXNlcjpwYXNz';
      const result = sanitizeError(msg);
      assert.ok(!result.includes('dXNlcjpwYXNz'));
      assert.ok(result.includes('Authorization: Basic ***'));
    });

    it('sanitizes RPC credential references', () => {
      const msg = 'RPC_USER and RPC_PASS not set';
      const result = sanitizeError(msg);
      assert.ok(!result.includes('RPC_USER'));
      assert.ok(result.includes('[credential]'));
    });

    it('handles null and undefined', () => {
      assert.equal(sanitizeError(null), 'An internal error occurred');
      assert.equal(sanitizeError(undefined), 'An internal error occurred');
    });

    it('handles Error objects', () => {
      const err = new Error('test error');
      const result = sanitizeError(err);
      assert.equal(result, 'test error');
    });

    it('truncates long messages', () => {
      const long = 'x'.repeat(1000);
      const result = sanitizeError(long);
      assert.ok(result.length <= 530);
    });
  });

  describe('clampLimit', () => {
    it('returns default for undefined', () => {
      assert.equal(clampLimit(undefined, 20, 100), 20);
    });

    it('returns default for null', () => {
      assert.equal(clampLimit(null, 20, 100), 20);
    });

    it('returns default for empty string', () => {
      assert.equal(clampLimit('', 20, 100), 20);
    });

    it('returns parsed integer', () => {
      assert.equal(clampLimit('50', 20, 100), 50);
      assert.equal(clampLimit(50, 20, 100), 50);
    });

    it('clamps to max', () => {
      assert.equal(clampLimit('500', 20, 100), 100);
      assert.equal(clampLimit(500, 20, 100), 100);
    });

    it('clamps below 1 to default', () => {
      assert.equal(clampLimit('0', 20, 100), 20);
      assert.equal(clampLimit('-5', 20, 100), 20);
    });

    it('returns default for NaN input', () => {
      assert.equal(clampLimit('abc', 20, 100), 20);
    });

    it('respects custom defaults and max', () => {
      assert.equal(clampLimit(5, 10, 50), 5);
      assert.equal(clampLimit(60, 10, 50), 50);
      assert.equal(clampLimit(undefined, 10, 50), 10);
    });
  });
});
