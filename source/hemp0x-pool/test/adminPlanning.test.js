const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const http = require('http');

const { initAdminRoutes } = require('../adminApi');
const { loadConfig } = require('../config');
const { createMockRpcServer } = require('./setup');
const { generateTestUtxos, POOL_ADDRESS } = require('./fixtures');
const { MigrationRunner } = require('../migrations');
const { REDACTED } = require('../configRedaction');
const { PayoutLedger } = require('../payoutLedger');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function request(app, method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const headers = opts.headers || {};
      if (opts.body !== undefined || opts.rawBody !== undefined) {
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

      if (opts.body !== undefined) {
        req.write(JSON.stringify(opts.body));
      }
      if (opts.rawBody !== undefined) {
        req.write(opts.rawBody);
      }
      req.on('error', (e) => {
        server.close(() => reject(e));
      });
      req.end();
    });
  });
}

function createDb() {
  return new sqlite3.Database(':memory:');
}

async function setupDb(db) {
  const runner = new MigrationRunner(db, migrationsDir);
  await runner.applyMigrations();
  return new Promise((resolve) => {
    db.get('PRAGMA foreign_keys = ON', () => resolve());
  });
}

describe('admin planning endpoints', () => {
  describe('auth is required', () => {
    it('POST /admin/payout/plan rejects unauthenticated requests when token is configured', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithToken = { ...cfg, adminToken: 'secret-token-123' };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: {} });
      assert.strictEqual(res.status, 401);
    });

    it('POST /admin/consolidation/plan rejects unauthenticated requests when token is configured', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithToken = { ...cfg, adminToken: 'secret-token-123' };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: {} });
      assert.strictEqual(res.status, 401);
    });

    it('POST /admin/payout/plan accepts requests with correct token', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithToken = { ...cfg, adminToken: 'secret-token-123' };
      const db = createDb();
      await setupDb(db);

      const app = express();
      app.use(express.json({ limit: '64kb' }));

      const mockDbMethods = {
        getUnpaidConfirmedBlocks: async () => [],
        getActiveMinersForBlock: async () => [],
        getMinersForBlockWindow: async () => [],
      };

      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: mockDbMethods,
        rawDb: db,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', {
        headers: { Authorization: 'Bearer secret-token-123' },
        body: { maxBlocks: 10 },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.runId);
      assert.strictEqual(res.body.blocksConsidered, 0);

      db.close();
    });

    it('POST /admin/payout/plan rejects wrong token', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithToken = { ...cfg, adminToken: 'secret-token-123' };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', {
        headers: { Authorization: 'Bearer wrong-token' },
        body: {},
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('POST /admin/payout/plan', () => {
    let db;

    before(async () => {
      db = createDb();
      await setupDb(db);
    });

    after(() => {
      db.close();
    });

    it('returns 503 when db is not available', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: {} });
      assert.strictEqual(res.status, 503);
    });

    it('returns 400 for non-object body', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const mockDbMethods = {
        getUnpaidConfirmedBlocks: async () => [],
        getActiveMinersForBlock: async () => [],
        getMinersForBlockWindow: async () => [],
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: mockDbMethods,
        rawDb: db,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: [1, 2, 3] });
      assert.strictEqual(res.status, 400);
    });

    it('produces a payout plan with empty blocks', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const mockDbMethods = {
        getUnpaidConfirmedBlocks: async () => [],
        getActiveMinersForBlock: async () => [],
        getMinersForBlockWindow: async () => [],
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: mockDbMethods,
        rawDb: db,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: { maxBlocks: 10 } });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.runId);
      assert.strictEqual(res.body.blocksConsidered, 0);
      assert.strictEqual(res.body.minerCount, 0);
      assert.strictEqual(res.body.batchCount, 0);
    });

    it('sets a maxBlock limit', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: {
          getUnpaidConfirmedBlocks: async () => [],
          getActiveMinersForBlock: async () => [],
          getMinersForBlockWindow: async () => [],
        },
        rawDb: db,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: { maxBlocks: 5 } });
      assert.strictEqual(res.status, 200);
    });

    it('accepts optional note in body', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: {
          getUnpaidConfirmedBlocks: async () => [],
          getActiveMinersForBlock: async () => [],
          getMinersForBlockWindow: async () => [],
        },
        rawDb: db,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: { note: 'Test plan for Q1' } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.note, 'Test plan for Q1');
    });

    it('truncates long notes at 500 chars', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const mockDbMethods = {
        getUnpaidConfirmedBlocks: async () => [],
        getActiveMinersForBlock: async () => [],
        getMinersForBlockWindow: async () => [],
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: mockDbMethods,
        rawDb: db,
        rpc: null,
      });

      const longNote = 'x'.repeat(1000);
      const res = await request(app, 'POST', '/admin/payout/plan', { body: { note: longNote } });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.note.length <= 500);
    });

    it('rejects when payout.dryRun is false', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const badCfg = { ...cfg, payout: { ...cfg.payout, dryRun: false } };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, badCfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: {
          getUnpaidConfirmedBlocks: async () => [],
          getActiveMinersForBlock: async () => [],
          getMinersForBlockWindow: async () => [],
        },
        rawDb: db,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: {} });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('dryRun'));
    });

    it('response does not contain raw credentials', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const mockDbMethods = {
        getUnpaidConfirmedBlocks: async () => [],
        getActiveMinersForBlock: async () => [],
        getMinersForBlockWindow: async () => [],
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: mockDbMethods,
        rawDb: db,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/payout/plan', { body: { maxBlocks: 10 } });
      assert.strictEqual(res.status, 200);
      const bodyStr = JSON.stringify(res.body);
      assert.ok(!bodyStr.includes('testpassword123'));
      assert.ok(!bodyStr.includes('TestUser'));
    });
  });

  describe('POST /admin/consolidation/plan', () => {
    let mockServer;
    let rpcPort;

    before(async () => {
      const mock = await createMockRpcServer((data, res) => {
        const write = (body) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        switch (data.method) {
          case 'listunspent': {
            const utxos = generateTestUtxos({ totalUtxos: 50 });
            const rpcUtxos = utxos.map((u) => ({
              txid: u.txid,
              vout: u.vout,
              address: u.address,
              amount: u.amount,
              confirmations: u.confirmations,
              spendable: u.spendable,
              solvable: u.solvable,
            }));
            write({ result: rpcUtxos, error: null, id: 'mock' });
            return;
          }
          case 'estimatesmartfee': {
            write({ result: { feerate: 0.00001000, blocks: 6 }, error: null, id: 'mock' });
            return;
          }
          case 'getwalletinfo': {
            write({ result: { walletname: 'hemp0xpool', balance: 100, txcount: 10 }, error: null, id: 'mock' });
            return;
          }
          default: {
            write({ result: null, error: { code: -32601, message: 'Method not found' }, id: 'mock' });
          }
        }
      });
      mockServer = mock.server;
      rpcPort = mock.port;
    });

    after(() => {
      mockServer.close();
    });

    it('returns 503 when rpc client is not available', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: null,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: {} });
      assert.strictEqual(res.status, 503);
    });

    it('returns 400 for non-object body', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: () => Promise.resolve(),
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: 'string' });
      assert.strictEqual(res.status, 400);
    });

    it('returns a clean 400 for malformed JSON', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: () => Promise.resolve(),
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { rawBody: '{"bad":' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'Malformed JSON request body');
    });

    it('produces a consolidation plan via mock RPC', async () => {
      const { createRpcClient } = require('../rpcClient');
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: rpcPort, user: 'test', pass: 'test' },
      });

      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithDest = {
        ...cfg,
        consolidation: {
          ...cfg.consolidation,
          destinationAddress: POOL_ADDRESS,
          minConfirmations: 100,
        },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithDest, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: {} });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.generatedAt);
      assert.ok(res.body.totalCandidates >= 0);
      assert.ok(res.body.batchCount !== undefined);
      assert.ok(res.body.operatorChecklist);
      assert.ok(Array.isArray(res.body.operatorChecklist));
    });

    it('accepts destinationAddress override in body', async () => {
      const { createRpcClient } = require('../rpcClient');
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: rpcPort, user: 'test', pass: 'test' },
      });

      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithDest = {
        ...cfg,
        consolidation: {
          ...cfg.consolidation,
          destinationAddress: POOL_ADDRESS,
        },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithDest, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', {
        body: { destinationAddress: POOL_ADDRESS },
      });
      assert.strictEqual(res.status, 200);
    });

    it('rejects invalid destinationAddress override before planning', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithDest = {
        ...cfg,
        consolidation: {
          ...cfg.consolidation,
          destinationAddress: POOL_ADDRESS,
        },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithDest, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: async () => {
          throw new Error('RPC should not be called for invalid destinationAddress');
        },
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', {
        body: { destinationAddress: 'not-a-hemp0x-address' },
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('destinationAddress'));
    });

    it('rejects invalid minConfirmations before planning', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithDest = {
        ...cfg,
        consolidation: {
          ...cfg.consolidation,
          destinationAddress: POOL_ADDRESS,
        },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithDest, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: async () => {
          throw new Error('RPC should not be called for invalid minConfirmations');
        },
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', {
        body: { minConfirmations: 'abc' },
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('minConfirmations'));
    });

    it('accepts maxBatchesPreview to limit batch previews', async () => {
      const { createRpcClient } = require('../rpcClient');
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: rpcPort, user: 'test', pass: 'test' },
      });

      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithDest = {
        ...cfg,
        consolidation: {
          ...cfg.consolidation,
          destinationAddress: POOL_ADDRESS,
        },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithDest, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: { maxBatchesPreview: 5 } });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.batches.length <= 5);
    });

    it('rejects when consolidation.enabled is true', async () => {
      const { createRpcClient } = require('../rpcClient');
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: rpcPort, user: 'test', pass: 'test' },
      });

      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const badCfg = {
        ...cfg,
        consolidation: { ...cfg.consolidation, enabled: true, destinationAddress: POOL_ADDRESS },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, badCfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: {} });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('consolidation.enabled'));
    });

    it('rejects when consolidation.dryRunOnly is false', async () => {
      const { createRpcClient } = require('../rpcClient');
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: rpcPort, user: 'test', pass: 'test' },
      });

      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const badCfg = {
        ...cfg,
        consolidation: { ...cfg.consolidation, dryRunOnly: false, destinationAddress: POOL_ADDRESS },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, badCfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: {} });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('dryRunOnly'));
    });

    it('rejects when automation.consolidationBroadcastEnabled is true', async () => {
      const { createRpcClient } = require('../rpcClient');
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: rpcPort, user: 'test', pass: 'test' },
      });

      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const badCfg = {
        ...cfg,
        consolidation: { ...cfg.consolidation, destinationAddress: POOL_ADDRESS },
        automation: { ...cfg.automation, consolidationBroadcastEnabled: true },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, badCfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: {} });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('consolidationBroadcastEnabled'));
    });

    it('sanitizes errors in response', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const badRpc = () => Promise.reject(new Error('Authorization: Basic secret rpcuser:rpcpass at /redacted/file.js:100'));
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfg, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: badRpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', {
        body: { destinationAddress: POOL_ADDRESS },
      });
      assert.strictEqual(res.status, 500);
      const errorStr = JSON.stringify(res.body.error);
      assert.ok(!errorStr.includes('secret'));
      assert.ok(!errorStr.includes('rpcuser'));
      assert.ok(!errorStr.includes('rpcpass'));
      assert.ok(!errorStr.includes('/redacted/file.js'));
      assert.ok(!errorStr.includes('.js:100'));
    });

    it('response does not contain raw credentials', async () => {
      const { createRpcClient } = require('../rpcClient');
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: rpcPort, user: 'test', pass: 'test' },
      });

      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithDest = {
        ...cfg,
        consolidation: { ...cfg.consolidation, destinationAddress: POOL_ADDRESS },
      };
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      initAdminRoutes(app, cfgWithDest, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc,
      });

      const res = await request(app, 'POST', '/admin/consolidation/plan', { body: {} });
      assert.strictEqual(res.status, 200);
      const bodyStr = JSON.stringify(res.body);
      assert.ok(!bodyStr.includes('testpassword123'));
      assert.ok(!bodyStr.includes('TestUser'));
    });
  });

  describe('public endpoints remain accessible', () => {
    it('GET /admin/status works with auth token configured', async () => {
      const cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
      const cfgWithToken = { ...cfg, adminToken: 'plan-token-xyz' };
      const app = express();

      app.use(express.json({ limit: '64kb' }));
      app.get('/stats', (req, res) => {
        res.json({ shares: 0 });
      });

      initAdminRoutes(app, cfgWithToken, {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: null,
        rpc: null,
      });

      const statsRes = await request(app, 'GET', '/stats');
      assert.strictEqual(statsRes.status, 200);

      const statusRes = await request(app, 'GET', '/admin/status', {
        headers: { Authorization: 'Bearer plan-token-xyz' },
      });
      assert.strictEqual(statusRes.status, 200);
    });
  });

  describe('source safety review', () => {
    it('adminApi source does not contain wallet unlock or broadcast RPC strings', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'adminApi.js'), 'utf8');
      assert.ok(!src.includes('sendmany'));
      assert.ok(!src.includes('sendrawtransaction'));
      assert.ok(!src.includes('walletpassphrase'));
      assert.ok(!src.includes('signrawtransaction'));
      assert.ok(!src.includes('dumpprivkey'));
      assert.ok(!src.includes('walletlock'));
      assert.ok(!src.includes('createrawtransaction'));
    });

    it('admin.html does not contain standalone approve/broadcast buttons', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
      assert.ok(!html.match(/>\s*Approve\s*</));
      assert.ok(!html.match(/>\s*Broadcast\s*</));
      assert.ok(!html.match(/>\s*Sign\s*</));
      assert.ok(!html.match(/>\s*Unlock\s*</));
    });

    it('admin.html does not contain config write/reload controls', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
      assert.ok(!html.includes('/admin/config/write'));
      assert.ok(!html.includes('/admin/config/reload'));
      assert.ok(!html.includes('/admin/config/save'));
    });

    it('admin.html does not contain unsafe RPC method strings', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
      assert.ok(!html.includes('sendmany'));
      assert.ok(!html.includes('sendrawtransaction'));
      assert.ok(!html.includes('walletpassphrase'));
      assert.ok(!html.includes('signrawtransaction'));
      assert.ok(!html.includes('createrawtransaction'));
    });

    it('admin.html uses escapeHtml for dynamic data', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
      assert.ok(html.includes('escapeHtml'));
    });

    it('admin.html uses sessionStorage not localStorage for token', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
      assert.ok(html.includes('sessionStorage'));
      assert.ok(!html.includes('localStorage'));
    });

    it('admin.html does not contain hardcoded secrets', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
      assert.ok(!html.includes('testpassword123'));
      assert.ok(!html.includes('TestUser'));
      assert.ok(!html.match(/Bearer\s+[A-Za-z0-9_\-]{4,}/));
    });

    it('adminApi source does not contain raw stack traces', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'adminApi.js'), 'utf8');
      assert.ok(!src.includes('console.error'));
      assert.ok(!src.includes('stack'));
    });
  });

  describe('payout plan history / review endpoints', () => {
    let db;
    let cfg;

    before(async () => {
      db = createDb();
      await setupDb(db);
      cfg = loadConfig(path.join(__dirname, 'fixtures', 'admin-full-config.json'));
    });

    after(() => {
      db.close();
    });

    function makeApp(overrides) {
      const app = express();
      app.use(express.json({ limit: '64kb' }));
      const base = {
        workers: new Map(),
        stats: { shares: 0 },
        daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
        currentTemplate: null,
        db: null,
        rawDb: db,
        rpc: null,
      };
      initAdminRoutes(app, cfg, Object.assign(base, overrides || {}));
      return app;
    }

    async function seedRun(ledger) {
      const run = await ledger.createRun({
        blockHeightStart: 100,
        blockHeightEnd: 105,
        totalBlocks: 5,
        totalMiners: 3,
        totalAmountSats: 500000000,
        feeAmountSats: 5000000,
        netAmountSats: 495000000,
      });
      const bc = await ledger.createBlockCredit({
        runId: run.id,
        height: 100,
        hash: '000000abc',
        finder: 'RXfinderExampleAddress12345',
        mode: 'pool',
        rewardSats: 100000000,
        feeDeductedSats: 1000000,
        finderBonusSats: 250000,
        remainderSats: 98750000,
        minerCount: 2,
      });
      await ledger.createMinerCredit({
        blockCreditId: bc.id,
        miner: 'RXminerOneAddress12345678',
        category: 'pool',
        amountSats: 49375000,
      });
      await ledger.createMinerCredit({
        blockCreditId: bc.id,
        miner: 'RXminerTwoAddress12345678',
        category: 'pool',
        amountSats: 49375000,
      });
      const batch = await ledger.createBatch({
        runId: run.id,
        batchIndex: 0,
        totalAmountSats: 98750000,
        outputCount: 2,
      });
      await ledger.createBatchOutput({
        batchId: batch.id,
        address: 'RXminerOneAddress12345678',
        amountSats: 49375000,
      });
      await ledger.createBatchOutput({
        batchId: batch.id,
        address: 'RXminerTwoAddress12345678',
        amountSats: 49375000,
      });
      return run;
    }

    describe('auth for history endpoints', () => {
      it('GET /admin/payout/runs rejects unauthenticated requests when token is configured', async () => {
        const cfgWithToken = { ...cfg, adminToken: 'review-token-1' };
        const app = express();
        app.use(express.json({ limit: '64kb' }));
        initAdminRoutes(app, cfgWithToken, {
          workers: new Map(), stats: { shares: 0 },
          daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
          currentTemplate: null, db: null, rawDb: db, rpc: null,
        });
        const res = await request(app, 'GET', '/admin/payout/runs');
        assert.strictEqual(res.status, 401);
      });

      it('GET /admin/payout/runs accepts requests with correct token', async () => {
        const cfgWithToken = { ...cfg, adminToken: 'review-token-2' };
        const app = express();
        app.use(express.json({ limit: '64kb' }));
        initAdminRoutes(app, cfgWithToken, {
          workers: new Map(), stats: { shares: 0 },
          daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
          currentTemplate: null, db: null, rawDb: db, rpc: null,
        });
        const res = await request(app, 'GET', '/admin/payout/runs', {
          headers: { Authorization: 'Bearer review-token-2' },
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.hasOwnProperty('runs'));
        assert.ok(res.body.hasOwnProperty('total'));
      });
    });

    describe('GET /admin/payout/runs', () => {
      it('returns empty list when no runs exist', async () => {
        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/runs');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.total, 0);
        assert.strictEqual(res.body.runs.length, 0);
      });

      it('returns runs when they exist', async () => {
        const ledger = new PayoutLedger(db);
        await seedRun(ledger);

        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/runs');
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.total >= 1);
        assert.ok(res.body.runs.length >= 1);
        assert.ok(res.body.runs[0].id);
        assert.strictEqual(typeof res.body.runs[0].status, 'string');
      });

      it('respects limit and offset', async () => {
        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/runs?limit=1&offset=0');
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.runs.length <= 1);
        assert.strictEqual(res.body.limit, 1);
      });

      it('returns 503 when no db', async () => {
        const app = express();
        app.use(express.json({ limit: '64kb' }));
        initAdminRoutes(app, cfg, {
          workers: new Map(), stats: { shares: 0 },
          daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
          currentTemplate: null, db: null, rawDb: null, rpc: null,
        });
        const res = await request(app, 'GET', '/admin/payout/runs');
        assert.strictEqual(res.status, 503);
      });
    });

    describe('GET /admin/payout/runs/:runId', () => {
      it('returns 400 for invalid runId', async () => {
        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/runs/notanumber');
        assert.strictEqual(res.status, 400);
        assert.ok(res.body.error.includes('runId'));
      });

      it('returns 404 for missing run', async () => {
        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/runs/99999');
        assert.strictEqual(res.status, 404);
      });

      it('returns full detail for existing run', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);

        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/runs/' + run.id);
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.run);
        assert.strictEqual(res.body.run.id, run.id);
        assert.ok(Array.isArray(res.body.blockCredits));
        assert.ok(Array.isArray(res.body.batches));
        assert.ok(Array.isArray(res.body.events));
        assert.ok(res.body.blockCredits.length > 0);
        assert.ok(res.body.batches.length > 0);
      });

      it('responses do not expose raw credentials', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);

        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/runs/' + run.id);
        assert.strictEqual(res.status, 200);
        const bodyStr = JSON.stringify(res.body);
        assert.ok(!bodyStr.includes('testpassword123'));
        assert.ok(!bodyStr.includes('TestUser'));
      });
    });

    describe('POST /admin/payout/runs/:runId/approve', () => {
      it('records approval as an event without changing run status', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);

        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/approve', {
          body: { note: 'Looks good, approved for review' },
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.action, 'approve');
        assert.strictEqual(res.body.status, 'operator_review_intent_recorded');
        assert.ok(res.body.message.includes('review-only'));

        const events = await ledger.getEventsForRun(run.id);
        const approvalEvents = events.filter((e) => e.event_type === 'operator_approved');
        assert.ok(approvalEvents.length > 0);

        const updatedRun = await ledger.getRun(run.id);
        assert.strictEqual(updatedRun.status, 'planned');
      });

      it('returns 404 for missing run', async () => {
        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/99999/approve', { body: {} });
        assert.strictEqual(res.status, 404);
      });

      it('returns 400 for invalid runId', async () => {
        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/abc/approve', { body: {} });
        assert.strictEqual(res.status, 400);
      });

      it('returns 400 for non-object body', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);
        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/approve', { body: [1, 2] });
        assert.strictEqual(res.status, 400);
      });

      it('truncates long notes', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);
        const app = makeApp();
        const longNote = 'x'.repeat(1000);
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/approve', {
          body: { note: longNote },
        });
        assert.strictEqual(res.status, 200);
        const events = await ledger.getEventsForRun(run.id);
        const approvalEvents = events.filter((e) => e.event_type === 'operator_approved');
        const lastEv = approvalEvents[approvalEvents.length - 1];
        const detail = JSON.parse(lastEv.detail);
        assert.ok(detail.reason.length <= 500);
      });
    });

    describe('POST /admin/payout/runs/:runId/reject', () => {
      it('records rejection as an event with a reason', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);

        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/reject', {
          body: { reason: 'Fees too high for this batch' },
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.action, 'reject');
        assert.strictEqual(res.body.status, 'operator_review_intent_recorded');
        assert.ok(res.body.message.includes('review-only'));

        const events = await ledger.getEventsForRun(run.id);
        const rejectEvents = events.filter((e) => e.event_type === 'operator_rejected');
        assert.ok(rejectEvents.length > 0);

        const updatedRun = await ledger.getRun(run.id);
        assert.strictEqual(updatedRun.status, 'planned');
      });

      it('returns 400 when reason is missing', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);
        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/reject', { body: {} });
        assert.strictEqual(res.status, 400);
        assert.ok(res.body.error.includes('reason'));
      });

      it('returns 400 when reason is empty string', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);
        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/reject', {
          body: { reason: '' },
        });
        assert.strictEqual(res.status, 400);
      });

      it('truncates long reasons', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);
        const app = makeApp();
        const longReason = 'R'.repeat(1000);
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/reject', {
          body: { reason: longReason },
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.reason.length <= 500);
      });
    });

    describe('source safety for review endpoints', () => {
      it('adminApi source does not contain wallet unlock or broadcast RPC strings', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'adminApi.js'), 'utf8');
        assert.ok(!src.includes('sendmany'));
        assert.ok(!src.includes('sendrawtransaction'));
        assert.ok(!src.includes('walletpassphrase'));
        assert.ok(!src.includes('signrawtransaction'));
        assert.ok(!src.includes('dumpprivkey'));
        assert.ok(!src.includes('walletlock'));
        assert.ok(!src.includes('createrawtransaction'));
      });

      it('approve endpoint response contains no-broadcast disclaimer', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);
        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/approve', { body: {} });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.message.includes('No transaction was signed or broadcast'));
      });

      it('reject endpoint response contains no-broadcast disclaimer', async () => {
        const ledger = new PayoutLedger(db);
        const run = await seedRun(ledger);
        const app = makeApp();
        const res = await request(app, 'POST', '/admin/payout/runs/' + run.id + '/reject', {
          body: { reason: 'Test rejection' },
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.message.includes('No transaction was signed or broadcast'));
      });
    });

    describe('cleanup report endpoint', () => {
      it('returns report with policy info', async () => {
        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/cleanup-report?days=30');
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.hasOwnProperty('eligibleReport'));
        assert.ok(res.body.hasOwnProperty('staleRunCount'));
        assert.ok(res.body.hasOwnProperty('policy'));
        assert.strictEqual(res.body.policy.action, 'report_only');
      });

      it('returns 503 without db', async () => {
        const app = express();
        app.use(express.json({ limit: '64kb' }));
        initAdminRoutes(app, cfg, {
          workers: new Map(), stats: { shares: 0 },
          daemonHealth: { ok: true, height: 100, lastChecked: Date.now(), error: null },
          currentTemplate: null, db: null, rawDb: null, rpc: null,
        });
        const res = await request(app, 'GET', '/admin/payout/cleanup-report');
        assert.strictEqual(res.status, 503);
      });

      it('respects days parameter', async () => {
        const app = makeApp();
        const res = await request(app, 'GET', '/admin/payout/cleanup-report?days=7');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.olderThanDays, 7);
      });
    });
  });
});
