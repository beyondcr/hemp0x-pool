const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const http = require('http');
const { initAdminRoutes, formatUptime } = require('../adminApi');
const { loadConfig } = require('../config');
const { REDACTED } = require('../configRedaction');

const CUSTOM_POOL_DIR = path.resolve(__dirname, '..');
const EXAMPLE_CONFIG_PATH = path.join(CUSTOM_POOL_DIR, 'config.example.json');

function request(app, method, url, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const opts = {
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      };
      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          server.close(() => {
            try {
              resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
            } catch (e) {
              resolve({ status: res.statusCode, headers: res.headers, body });
            }
          });
        });
      });
      req.on('error', (e) => {
        server.close(() => reject(e));
      });
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  });
}

describe('operator readiness', () => {
  // ---------------------------------------------------------------------------
  // config.example.json
  // ---------------------------------------------------------------------------
  describe('config.example.json', () => {
    let example;

    it('exists and is valid JSON', () => {
      assert.ok(fs.existsSync(EXAMPLE_CONFIG_PATH), 'config.example.json must exist');
      const raw = fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
      example = JSON.parse(raw);
      assert.ok(typeof example === 'object');
    });

    it('has no real secrets or production credentials', () => {
      const raw = fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8').toLowerCase();
      const forbidden = [
        'privatekey',
        'mainnet-prod',
        'prod-pool',
        'production-pool',
      ];
      for (const term of forbidden) {
        assert.ok(!raw.includes(term), `Example config must not contain "${term}"`);
      }

      assert.equal(example.daemon.useCookieAuth, true, 'daemon.useCookieAuth should default to cookie auth');
      assert.equal(example.daemon.cookiePath, '/var/lib/hemp0x-pool/rpc.cookie', 'daemon.cookiePath must be the documented example path');
      assert.equal(example.daemon.user, undefined, 'daemon.user should not be present in the cookie-auth example');
      assert.equal(example.daemon.pass, undefined, 'daemon.pass should not be present in the cookie-auth example');
      assert.ok(
        example.pool.wallet.includes('YOUR_') || example.pool.wallet === 'R111111111111111111111111111111111',
        'pool.wallet must be placeholder or example address'
      );
    });

    it('has safe defaults for all safety gates', () => {
      assert.equal(example.payout.dryRun, true, 'payout.dryRun must be true');
      assert.equal(example.consolidation.enabled, false, 'consolidation.enabled must be false');
      assert.equal(example.consolidation.dryRunOnly, true, 'consolidation.dryRunOnly must be true');
      assert.equal(example.automation.routinePayoutEnabled, false, 'automation.routinePayoutEnabled must be false');
      assert.equal(example.automation.payoutBroadcastEnabled, false, 'automation.payoutBroadcastEnabled must be false');
      assert.equal(example.automation.consolidationBroadcastEnabled, false, 'automation.consolidationBroadcastEnabled must be false');
    });

    it('has payoutBroadcastEnabled field present in automation section', () => {
      assert.ok('payoutBroadcastEnabled' in example.automation, 'automation.payoutBroadcastEnabled must be present');
    });

    it('does not contain any secret values in non-secret fields', () => {
      const raw = fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);

      const secretPatterns = [
        /passw(or)?d/i,
        /token/i,
        /secret/i,
      ];

      const secretSectionKeys = ['user', 'pass'];

      function check(obj, prefix) {
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (typeof val === 'object' && val !== null) {
            check(val, `${prefix}.${key}`);
          } else if (typeof val === 'string') {
            const isSecretField = prefix === 'root.daemon' && secretSectionKeys.includes(key);
            if (isSecretField) continue;
            for (const pattern of secretPatterns) {
              assert.ok(
                !pattern.test(val),
                `${prefix}.${key} contains secret-like value: "${val}"`
              );
            }
          }
        }
      }

      check(parsed, 'root');
    });
  });

  describe('alternate config support', () => {
    it('confirmation.js uses the shared config loader for env-selected configs', () => {
      const src = fs.readFileSync(path.join(CUSTOM_POOL_DIR, 'confirmation.js'), 'utf8');
      assert.ok(src.includes("require('./config')"), 'confirmation.js must use shared config loader');
      assert.ok(src.includes('loadConfig()'), 'confirmation.js must call loadConfig()');
      assert.ok(!src.includes("require('./config.json')"), 'confirmation.js must not hardcode config.json');
    });

    it('server startup applies schema migrations before serving admin planning endpoints', () => {
      const src = fs.readFileSync(path.join(CUSTOM_POOL_DIR, 'server.js'), 'utf8');
      assert.ok(src.includes("require('./migrations')"), 'server.js must load the migration runner');
      assert.ok(src.includes('applyDatabaseMigrations'), 'server.js must expose an explicit migration step');
      assert.ok(src.includes('await applyDatabaseMigrations()'), 'server.js must await migrations during startup');
    });
  });

  describe('stratum address validation', () => {
    it('requires routable addresses during miner authorization', () => {
      const src = fs.readFileSync(path.join(CUSTOM_POOL_DIR, 'server.js'), 'utf8');
      assert.ok(src.includes('isRoutableAddress(socket.wallet)'), 'Stratum authorization must reject bad-checksum wallets');
    });

    it('retains recent non-clean jobs to reduce false stale rejections', () => {
      const src = fs.readFileSync(path.join(CUSTOM_POOL_DIR, 'server.js'), 'utf8');
      assert.ok(src.includes('socket.recentJobs'), 'server.js must track recent stratum jobs per socket');
      assert.ok(src.includes('socket.recentJobs?.get(jobIdStr)'), 'share validation must look up submitted job IDs');
      assert.ok(src.includes('if (!socket.recentJobs || clean)'), 'clean jobs must reset retained job history');
    });
  });

  // ---------------------------------------------------------------------------
  // Admin /status payout automation visibility
  // ---------------------------------------------------------------------------
  describe('admin status payout automation', () => {
    function createApp(cfg) {
      const app = express();
      app.use(express.json({ limit: '64kb' }));

      const sharedState = {
        workers: new Map(),
        stats: { shares: 42 },
        daemonHealth: { ok: true, height: 12345, lastChecked: Date.now(), error: null },
        currentTemplate: { height: 12345 },
        db: {
          all: async () => [],
        },
        rawDb: null,
        rpc: async () => null,
      };

      initAdminRoutes(app, cfg, sharedState);
      return app;
    }

    it('reports dry_run mode under default safe config', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = createApp(cfg);
      const res = await request(app, 'GET', '/admin/status', { headers: {} });

      assert.equal(res.status, 200);
      assert.ok(res.body.payoutAutomation);
      assert.equal(res.body.payoutAutomation.mode, 'dry_run');
      assert.equal(res.body.payoutAutomation.gates.dryRun, true);
      assert.equal(res.body.payoutAutomation.gates.routinePayoutEnabled, false);
      assert.equal(res.body.payoutAutomation.gates.payoutBroadcastEnabled, false);
      assert.equal(res.body.payoutAutomation.gates.liveCapable, false);
      assert.ok(res.body.payoutAutomation.message.includes('Dry-run'));
      assert.ok(res.body.payoutAutomation.message.includes('No transactions are broadcast'));
    });

    it('does not expose secrets in status response', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = createApp(cfg);
      const res = await request(app, 'GET', '/admin/status', { headers: {} });

      const bodyStr = JSON.stringify(res.body);
      assert.ok(!bodyStr.includes('RPC_USER'), 'Status must not expose daemon.user');
      assert.ok(!bodyStr.includes('/var/lib/hemp0x-pool/rpc.cookie'), 'Status must not expose daemon.cookiePath');

      // payoutAutomation section must exist and not contain secrets
      assert.ok(res.body.payoutAutomation);
      assert.equal(typeof res.body.payoutAutomation.mode, 'string');
      assert.equal(typeof res.body.payoutAutomation.message, 'string');
      const paStr = JSON.stringify(res.body.payoutAutomation);
      assert.ok(!paStr.includes(REDACTED), 'payoutAutomation must not contain REDACTED placeholder');
      assert.ok(!paStr.includes('/var/lib/hemp0x-pool/rpc.cookie'), 'payoutAutomation must not contain secrets');
    });

    it('includes individual gate statuses', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = createApp(cfg);
      const res = await request(app, 'GET', '/admin/status', { headers: {} });

      const gates = res.body.payoutAutomation.gates;
      assert.equal(typeof gates.dryRun, 'boolean');
      assert.equal(typeof gates.routinePayoutEnabled, 'boolean');
      assert.equal(typeof gates.payoutBroadcastEnabled, 'boolean');
      assert.equal(typeof gates.liveCapable, 'boolean');
    });

    it('reports disabled mode when dryRun is false but gates closed', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      // Deep freeze prevents mutation, so construct a special config manually
      const testCfg = { ...cfg, payout: { ...cfg.payout, dryRun: false } };
      const app = createApp(testCfg);
      const res = await request(app, 'GET', '/admin/status', { headers: {} });

      assert.equal(res.body.payoutAutomation.mode, 'disabled');
      assert.equal(res.body.payoutAutomation.gates.liveCapable, false);
      assert.equal(res.body.payoutAutomation.gates.dryRun, false);
    });

    it('responds with 200 and contains all expected top-level keys', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = createApp(cfg);
      const res = await request(app, 'GET', '/admin/status', { headers: {} });

      assert.equal(res.status, 200);
      assert.ok(res.body.uptimeSec !== undefined);
      assert.ok(res.body.daemonHealth);
      assert.ok(res.body.pool);
      assert.ok(res.body.payoutAutomation);
      assert.ok(res.body.config);
      assert.ok(res.body.ledgers);
      assert.ok(res.body.node);
    });
  });

  // ---------------------------------------------------------------------------
  // Existing payout worker behavior preserved
  // ---------------------------------------------------------------------------
  describe('payout worker integration', () => {
    it('PayoutWorker module can be required without side effects', () => {
      const cwd = CUSTOM_POOL_DIR;
      const result = spawnSync(
        process.execPath,
        ['-e', "const { PayoutWorker } = require('./payoutWorker'); if (typeof PayoutWorker !== 'function') process.exit(2);"],
        { cwd, encoding: 'utf8', timeout: 5000 }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });

    it('PayoutWorker source remains safe (no wallet unlock strings)', () => {
      const src = fs.readFileSync(path.join(CUSTOM_POOL_DIR, 'payoutWorker.js'), 'utf8');
      const forbidden = [
        'walletpassphrase',
        'wallet_unlock',
        'walletlock',
        'signrawtransaction',
        'createrawtransaction',
        'encryptwallet',
      ];
      for (const term of forbidden) {
        assert.ok(!src.includes(term), `payoutWorker.js must not contain ${term}`);
      }
    });

    it('DEFAULTS has payoutBroadcastEnabled set to false', () => {
      const { DEFAULTS } = require('../config');
      assert.equal(DEFAULTS.automation.payoutBroadcastEnabled, false);
    });

    it('getSafetyGateStatus includes payoutBroadcastEnabled', () => {
      const { getSafetyGateStatus } = require('../config');
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const gateStatus = getSafetyGateStatus(cfg);
      const payoutBroadcastGate = gateStatus.gates.find((g) => g.name === 'payoutBroadcastEnabled');
      assert.ok(payoutBroadcastGate, 'payoutBroadcastEnabled must be in safety gate status');
      assert.equal(payoutBroadcastGate.safe, true);
    });
  });
});
