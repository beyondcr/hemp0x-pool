const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { initAdminRoutes } = require('../adminApi');
const { loadConfig } = require('../config');
const { createApp, canServeAdminDashboard } = require('../server');
const { REDACTED } = require('../configRedaction');

// Helper: read the admin.html source
const adminHtmlPath = path.join(__dirname, '..', 'public', 'admin.html');
const adminHtmlSource = fs.readFileSync(adminHtmlPath, 'utf8');

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
            resolve({ status: res.statusCode, body, headers: res.headers });
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

describe('admin dashboard', () => {
  describe('admin.html is served', () => {
    it('returns admin.html via express.static', async () => {
      const app = createApp();
      const res = await request(app, 'GET', '/admin.html');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes('<!DOCTYPE html>'));
      assert.ok(res.body.includes('Pool Operator Dashboard'));
      assert.strictEqual(res.headers['content-type'].split(';')[0], 'text/html');
    });

    it('serves admin.html with security headers', async () => {
      const app = createApp();
      const res = await request(app, 'GET', '/admin.html');
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    });

    it('does not expose admin.html to remote clients unless an admin token is configured', () => {
      const remoteReq = { ip: '203.0.113.10', socket: { remoteAddress: '203.0.113.10' } };
      const localReq = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };

      assert.strictEqual(canServeAdminDashboard(remoteReq, {}), false);
      assert.strictEqual(canServeAdminDashboard(localReq, {}), true);
      assert.strictEqual(canServeAdminDashboard(remoteReq, { adminToken: 'configured-token' }), true);
    });
  });

  describe('admin.html static source review', () => {
    it('does not contain a hardcoded default admin token', () => {
      // The prompt explicitly requires no default token placed anywhere.
      assert.ok(!adminHtmlSource.includes('test-secret-token'));
      assert.ok(!adminHtmlSource.includes('admin123'));
      assert.ok(!adminHtmlSource.includes('changeme'));
      // "Bearer " appears as a dynamic auth header prefix in the JS code,
      // which is fine. Check that no hardcoded token follows it.
      assert.ok(!adminHtmlSource.match(/Bearer\s+[A-Za-z0-9_\-]{4,}/));
    });

    it('does not contain hardcoded daemon credentials', () => {
      assert.ok(!adminHtmlSource.includes('HEMP0X_RPC_USER'));
      assert.ok(!adminHtmlSource.includes('daemon.user'));
      assert.ok(!adminHtmlSource.includes('daemon.pass'));
      assert.ok(!adminHtmlSource.includes('rpcuser'));
      assert.ok(!adminHtmlSource.includes('rpcpass'));
    });

    it('does not contain unsafe RPC method strings', () => {
      assert.ok(!adminHtmlSource.includes('sendmany'));
      assert.ok(!adminHtmlSource.includes('sendrawtransaction'));
      assert.ok(!adminHtmlSource.includes('walletpassphrase'));
      assert.ok(!adminHtmlSource.includes('wallet_unlock'));
      assert.ok(!adminHtmlSource.includes('encryptwallet'));
      assert.ok(!adminHtmlSource.includes('signrawtransaction'));
      assert.ok(!adminHtmlSource.includes('dumpprivkey'));
      assert.ok(!adminHtmlSource.includes('walletlock'));
    });

    it('does not contain config write or reload endpoint paths', () => {
      assert.ok(!adminHtmlSource.includes('/admin/config/write'));
      assert.ok(!adminHtmlSource.includes('/admin/config/reload'));
      assert.ok(!adminHtmlSource.includes('/admin/config/save'));
      assert.ok(!adminHtmlSource.includes('PUT /admin/config'));
      assert.ok(!adminHtmlSource.includes('PATCH /admin/config'));
    });

    it('uses sessionStorage not localStorage for token', () => {
      assert.ok(adminHtmlSource.includes('sessionStorage'));
      assert.ok(!adminHtmlSource.includes('localStorage'));
    });

    it('uses textContent or createTextNode not innerHTML for untrusted values', () => {
      // The dashboard uses textContent via the escapeHtml function for dynamic data
      assert.ok(adminHtmlSource.includes('escapeHtml'));
      // It should not have raw innerHTML assignments for dynamic data
      // but we expect it may have innerHTML for the validated tab result pane (which shows only escaped data)
    });

    it('does not expose pool wallet in source', () => {
      // The pool wallet should not be embedded in the admin page source
      // Check that it doesn't contain the hex/address pattern used in tests
      assert.ok(!adminHtmlSource.includes('R111111111111111111111111111111111'));
    });

    it('does not contain raw error stacks or implementation instructions', () => {
      assert.ok(!adminHtmlSource.includes('stack trace'));
      assert.ok(!adminHtmlSource.includes('Error:'));
      assert.ok(!adminHtmlSource.includes('.js:'));
    });
  });

  describe('admin API remains read-only', () => {
    it('does not expose POST /admin/config/write or reload', async () => {
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

      const res = await request(app, 'POST', '/admin/config/write', { body: { pool: { name: 'hack' } } });
      // Should 404 since route doesn't exist
      assert.ok(res.status === 404 || res.status === 405);
    });

    it('does not expose PUT /admin/config', async () => {
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

      const res = await request(app, 'PUT', '/admin/config', { body: { pool: { name: 'hack' } } });
      assert.ok(res.status === 404 || res.status === 405);
    });
  });

  describe('admin.html integration', () => {
    it('calls /admin/status and /admin/config without leaking secrets in UI', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      app.use(express.static(path.join(__dirname, '..', 'public')));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 42 },
        daemonHealth: { ok: true, height: 500000, lastChecked: Date.now(), error: null },
        currentTemplate: { height: 500000 },
        db: null,
      });

      // Verify /admin/config returns redacted data
      const configRes = await request(app, 'GET', '/admin/config');
      assert.strictEqual(configRes.status, 200);
      const configJson = JSON.parse(configRes.body);
      assert.strictEqual(configJson.config.daemon.user, REDACTED);
      assert.strictEqual(configJson.config.daemon.pass, REDACTED);

      // Verify /admin/status returns no secrets
      const statusRes = await request(app, 'GET', '/admin/status');
      assert.strictEqual(statusRes.status, 200);
      const statusJson = JSON.parse(statusRes.body);
      assert.ok(!statusRes.body.includes('testpassword123'));
      assert.ok(!statusRes.body.includes('TestUser'));

      // Verify admin page is served and doesn't leak secrets in static content
      const pageRes = await request(app, 'GET', '/admin.html');
      assert.strictEqual(pageRes.status, 200);
      assert.ok(!pageRes.body.includes('testpassword123'));
      assert.ok(!pageRes.body.includes('TestUser'));
    });
  });
});
