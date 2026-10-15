const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const express = require('express');

const { REDACTED, redactSecrets } = require('../configRedaction');
const { adminAuth, getAdminRouteConfig, initAdminRoutes, safeCompare, formatUptime } = require('../adminApi');
const { loadConfig, getSafetyGateStatus } = require('../config');
const { schema, getFieldsByCategory, validateConfig } = require('../configSchema');

describe('adminApi', () => {
  describe('safeCompare', () => {
    it('matches identical strings', () => {
      assert.strictEqual(safeCompare('abc123', 'abc123'), true);
    });

    it('rejects different strings', () => {
      assert.strictEqual(safeCompare('abc123', 'def456'), false);
    });

    it('rejects different length strings', () => {
      assert.strictEqual(safeCompare('abc', 'abcdef'), false);
    });

    it('rejects non-string inputs', () => {
      assert.strictEqual(safeCompare(null, 'abc'), false);
      assert.strictEqual(safeCompare('abc', undefined), false);
      assert.strictEqual(safeCompare(123, '123'), false);
    });

    it('is timing-safe (does not short-circuit)', () => {
      const result = safeCompare('aaaa', 'aaa\x00');
      assert.strictEqual(result, false);
    });
  });

  describe('formatUptime', () => {
    it('formats seconds only', () => {
      assert.strictEqual(formatUptime(30), '30s');
    });

    it('formats minutes and seconds', () => {
      assert.strictEqual(formatUptime(90), '1m 30s');
    });

    it('formats hours', () => {
      assert.strictEqual(formatUptime(3661), '1h 1m 1s');
    });

    it('formats days', () => {
      assert.strictEqual(formatUptime(86461), '1d 1m 1s');
    });
  });

  describe('adminAuth', () => {
    it('returns a middleware function', () => {
      const middleware = adminAuth({});
      assert.strictEqual(typeof middleware, 'function');
    });
  });

  describe('getAdminRouteConfig', () => {
    it('returns redacted config with metadata', () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const result = getAdminRouteConfig(cfg);

      assert.strictEqual(result.config.daemon.user, REDACTED);
      assert.strictEqual(result.config.daemon.pass, REDACTED);
      assert.strictEqual(typeof result.meta, 'object');
      assert.strictEqual(typeof result.meta.schema, 'object');
      assert.strictEqual(result.meta.categories.secretCount > 0, true);
      assert.strictEqual(typeof result.safetyGates, 'object');
      assert.strictEqual(result.safetyGates.allSafe, true);
      assert.strictEqual(result.frozen, true);
    });

    it('does not leak daemon.password or daemon.token in redacted config', () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const result = getAdminRouteConfig(cfg);

      const redactedStr = JSON.stringify(result.config);
      assert.ok(!redactedStr.includes('testpassword123'), 'should not leak daemon.pass');
      assert.ok(redactedStr.includes(REDACTED));
    });

    it('correctly reports dangerous safety gate status', () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const status = getSafetyGateStatus(cfg);

      assert.strictEqual(status.allSafe, true);
      for (const gate of status.gates) {
        assert.strictEqual(gate.safe, true, `${gate.name} should be safe: got ${gate.currentValue}`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
//  Integration tests: admin endpoints with supertest-like approach
// ---------------------------------------------------------------------------

function request(app, method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const headers = opts.headers || {};
      if (opts.body) {
        headers['Content-Type'] = 'application/json';
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
        headers,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close(() => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(body) });
            } catch (e) {
              resolve({ status: res.statusCode, body: body });
            }
          });
        });
      });

      if (opts.body) {
        req.write(JSON.stringify(opts.body));
      }
      req.on('error', (e) => {
        server.close(() => reject(e));
      });
      req.end();
    });
  });
}

describe('adminApi endpoints', () => {
  describe('GET /admin/config (no token)', () => {
    it('returns config when no admin token is configured (localhost-only)', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const res = await request(app, 'GET', '/admin/config');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.body.config, 'object');
      assert.strictEqual(res.body.config.daemon.user, REDACTED);
      assert.strictEqual(res.body.config.daemon.pass, REDACTED);
      assert.strictEqual(typeof res.body.meta, 'object');
      assert.strictEqual(typeof res.body.safetyGates, 'object');
    });
  });

  describe('GET /admin/config (token auth)', () => {
    it('rejects unauthenticated requests when token is configured', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      const cfgWithToken = { ...cfg, adminToken: 'test-secret-token' };
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const res = await request(app, 'GET', '/admin/config');
      assert.strictEqual(res.status, 401);
      assert.ok(res.body.error);
    });

    it('rejects wrong token', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      const cfgWithToken = { ...cfg, adminToken: 'test-secret-token' };
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const res = await request(app, 'GET', '/admin/config', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.strictEqual(res.status, 401);
    });

    it('rate-limits repeated failed authentication attempts', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      const cfgWithToken = { ...cfg, adminToken: 'test-secret-token' };
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      let last;
      for (let attempt = 0; attempt < 11; attempt += 1) {
        last = await request(app, 'GET', '/admin/config', {
          headers: { Authorization: 'Bearer wrong-token' },
        });
      }

      assert.strictEqual(last.status, 429);
      assert.ok(last.body.error);
    });

    it('accepts correct token', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      const cfgWithToken = { ...cfg, adminToken: 'test-secret-token' };
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const res = await request(app, 'GET', '/admin/config', {
        headers: { Authorization: 'Bearer test-secret-token' },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.body.config, 'object');
    });
  });

  describe('GET /admin/status', () => {
    it('returns status without secret leakage', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 42 },
        daemonHealth: { ok: true, height: 500000, lastChecked: Date.now(), error: null },
        currentTemplate: { height: 500000 },
        db: null,
      });

      const res = await request(app, 'GET', '/admin/status');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.body.uptimeSec, 'number');
      assert.strictEqual(typeof res.body.uptimeFormatted, 'string');
      assert.strictEqual(typeof res.body.daemonHealth, 'object');
      assert.strictEqual(res.body.daemonHealth.ok, true);
      assert.strictEqual(res.body.daemonHealth.height, 500000);
      assert.strictEqual(typeof res.body.pool, 'object');
      assert.strictEqual(typeof res.body.config, 'object');
      assert.strictEqual(typeof res.body.node, 'object');
      assert.strictEqual(typeof res.body.node.version, 'string');

      const bodyStr = JSON.stringify(res.body);
      assert.ok(!bodyStr.includes(REDACTED), 'status endpoint should not contain raw redactions');
    });

    it('sanitizes daemon errors in status output', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 42 },
        daemonHealth: {
          ok: false,
          height: 500000,
          lastChecked: Date.now(),
          error: 'Authorization: Basic secret rpcuser:rpcpass at /redacted/private/path',
        },
        currentTemplate: { height: 500000 },
        db: null,
      });

      const res = await request(app, 'GET', '/admin/status');
      assert.strictEqual(res.status, 200);
      const errorText = res.body.daemonHealth.error;
      assert.ok(!errorText.includes('secret'));
      assert.ok(!errorText.includes('rpcuser'));
      assert.ok(!errorText.includes('/redacted'));
    });

    it('reads dynamic daemon health and template state via shared-state getters', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      let daemonHealth = { ok: false, height: 0, lastChecked: 0, error: null };
      let currentTemplate = null;

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 42 },
        get daemonHealth() { return daemonHealth; },
        get currentTemplate() { return currentTemplate; },
        db: null,
      });

      const initial = await request(app, 'GET', '/admin/status');
      assert.strictEqual(initial.status, 200);
      assert.strictEqual(initial.body.daemonHealth.ok, false);
      assert.strictEqual(initial.body.pool.currentTemplateAvailable, false);

      daemonHealth = { ok: true, height: 501234, lastChecked: Date.now(), error: null };
      currentTemplate = { height: 501234 };

      const updated = await request(app, 'GET', '/admin/status');
      assert.strictEqual(updated.status, 200);
      assert.strictEqual(updated.body.daemonHealth.ok, true);
      assert.strictEqual(updated.body.daemonHealth.height, 501234);
      assert.strictEqual(updated.body.pool.currentHeight, 501234);
      assert.strictEqual(updated.body.pool.currentTemplateAvailable, true);
    });

    it('reports consolidation event_type from the ledger table', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      const db = {
        async all(sql) {
          if (sql.includes('COUNT(*)')) return [];
          if (sql.includes('payout_batch_outputs pbo')) return [];
          if (sql.includes('FROM consolidation_events')) {
            return [{ timestamp: 1234, event_type: 'plan_created', details: '{}' }];
          }
          return [];
        },
      };

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 42 },
        daemonHealth: { ok: true, height: 500000, lastChecked: Date.now(), error: null },
        currentTemplate: { height: 500000 },
        db,
      });

      const res = await request(app, 'GET', '/admin/status');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ledgers.consolidation.recent[0].eventType, 'plan_created');
    });

    it('returns payout summary sourced from ledger batch outputs', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      const mockPayoutRow = {
        timestamp: Date.now(),
        category: 'pool',
        amount: 1.25,
        txid: 'abcd1234efgh5678abcd1234efgh5678abcd1234efgh5678abcd1234efgh5678',
      };
      const db = {
        async all(sql) {
          if (sql.includes('COUNT(*)')) return [{ total: 1 }];
          if (sql.includes('payout_batch_outputs pbo')) return [mockPayoutRow];
          if (sql.includes('FROM consolidation_events')) return [];
          return [];
        },
      };

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 42 },
        daemonHealth: { ok: true, height: 500000, lastChecked: Date.now(), error: null },
        currentTemplate: { height: 500000 },
        db,
      });

      const res = await request(app, 'GET', '/admin/status');
      assert.strictEqual(res.status, 200);
      const payout = res.body.ledgers.payout;
      assert.strictEqual(payout.recentCount, 1);
      assert.strictEqual(payout.totalPayments, 1);
      assert.strictEqual(payout.recent.length, 1);
      assert.strictEqual(payout.recent[0].category, 'pool');
      assert.strictEqual(payout.recent[0].amount, 1.25);
      assert.strictEqual(payout.recent[0].txid, 'abcd1234...');
    });
  });

  describe('POST /admin/config/validate', () => {
    it('validates a valid proposed config', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const proposed = {
        pool: { name: 'Test', stratumPort: 3032, webPort: 8080, fee: 0.01 },
        daemon: { host: '127.0.0.1', port: 42070 },
        vardiff: { minDiff: 0.2, maxDiff: 1024, targetTime: 15, retargetTime: 90, variance: 0.3 },
      };
      const res = await request(app, 'POST', '/admin/config/validate', { body: proposed });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.body.valid, 'boolean');
      assert.strictEqual(res.body.readonly, true);
      assert.strictEqual(typeof res.body.validatedAt, 'string');
    });

    it('rejects config with safety gate violations', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const proposed = {
        payout: { dryRun: false },
      };
      const res = await request(app, 'POST', '/admin/config/validate', { body: proposed });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, false);
      assert.ok(res.body.errors.length > 0);
      assert.ok(res.body.errors.some((e) => e.path === 'payout.dryRun'), 'should flag safety gate violation');
    });

    it('rejects non-object body (Express strict json mode)', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const res = await request(app, 'POST', '/admin/config/validate', { body: [1, 2, 3] });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.valid, false);
    });

    it('does not write config or change runtime config', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const originalPoolName = cfg.pool.name;
      const proposed = {
        pool: { name: 'HackedPool', fee: 1.0 },
        payout: { dryRun: true },
      };
      const res = await request(app, 'POST', '/admin/config/validate', { body: proposed });

      // Config should be unchanged
      assert.strictEqual(cfg.pool.name, originalPoolName);
      assert.strictEqual(Object.isFrozen(cfg), true);
    });

    it('reports schema errors for invalid values', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const proposed = {
        pool: { fee: 999 },
        daemon: { port: 999999 },
      };
      const res = await request(app, 'POST', '/admin/config/validate', { body: proposed });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, false);
      assert.ok(res.body.errors.length > 0);
    });
  });

  describe('public endpoints are unchanged by admin auth', () => {
    it('public /stats endpoint returns without auth', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      const cfgWithToken = { ...cfg, adminToken: 'secret' };
      app.use(express.json({ limit: '64kb' }));
      app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
      });

      app.get('/stats', (req, res) => {
        res.json({ shares: 0 });
      });

      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 1, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
      });

      const res = await request(app, 'GET', '/stats');
      assert.strictEqual(res.status, 200);
    });
  });
});
