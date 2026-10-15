const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createRpcClient } = require('../rpcClient');
const { createMockRpcServer } = require('./setup');

describe('rpcClient', () => {
  let server;
  let port;

  before(async () => {
    const mock = await createMockRpcServer((data, res) => {
      if (data.method === 'getblockchaininfo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            result: { blocks: 1000, bestblockhash: 'abc123' },
            error: null,
            id: data.id,
          })
        );
      } else if (data.method === 'error_method') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            result: null,
            error: { code: -1, message: 'simulated RPC error' },
            id: data.id,
          })
        );
      } else if (data.method === 'http_error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } else if (data.method === 'bad_json') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('not json');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            result: null,
            error: { code: -32601, message: 'Method not found' },
            id: data.id,
          })
        );
      }
    });
    server = mock.server;
    port = mock.port;
  });

  after(() => {
    server.close();
  });

  it('returns result on successful RPC call', async () => {
    const rpc = createRpcClient({
      daemon: { host: '127.0.0.1', port, user: 'test', pass: 'test' },
    });
    const result = await rpc('getblockchaininfo');
    assert.strictEqual(result.blocks, 1000);
    assert.strictEqual(result.bestblockhash, 'abc123');
  });

  it('throws on RPC error response', async () => {
    const rpc = createRpcClient({
      daemon: { host: '127.0.0.1', port, user: 'test', pass: 'test' },
    });
    await assert.rejects(rpc('error_method'), /simulated RPC error/);
  });

  it('throws on HTTP error status', async () => {
    const rpc = createRpcClient({
      daemon: { host: '127.0.0.1', port, user: 'test', pass: 'test' },
    });
    await assert.rejects(rpc('http_error'), /HTTP 500/);
  });

  it('throws on non-JSON response', async () => {
    const rpc = createRpcClient({
      daemon: { host: '127.0.0.1', port, user: 'test', pass: 'test' },
    });
    await assert.rejects(rpc('bad_json'), /non-JSON response/);
  });

  it('uses default host and port when not provided', async () => {
    const rpc = createRpcClient({ daemon: {} });
    assert.strictEqual(typeof rpc, 'function');
  });

  it('does not expose credentials in thrown errors', async () => {
    const rpc = createRpcClient({
      daemon: { host: '127.0.0.1', port, user: 'secretuser', pass: 'secretpass' },
    });
    try {
      await rpc('http_error');
      assert.fail('Expected rejection');
    } catch (err) {
      const msg = err.message || '';
      assert.strictEqual(msg.includes('secretuser'), false);
      assert.strictEqual(msg.includes('secretpass'), false);
    }
  });

  it('supports per-call RPC timeout overrides', async () => {
    const slowServer = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: null, error: null, id: 'slow_method' }));
      }, 50);
    });

    await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    const slowPort = slowServer.address().port;

    try {
      const rpc = createRpcClient({
        daemon: { host: '127.0.0.1', port: slowPort, user: 'test', pass: 'test' },
      });
      await assert.rejects(
        () => rpc('slow_method', [], { timeoutMs: 5 }),
        /RPC slow_method timed out/
      );
    } finally {
      slowServer.close();
    }
  });

  describe('cookie auth', () => {
    let tempDir;

    before(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcClient-cookie-'));
    });

    after(() => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    function makeCookiePath(name) {
      return path.join(tempDir, name);
    }

    function writeCookie(filePath, content) {
      fs.writeFileSync(filePath, content + '\n', 'utf8');
    }

    function startCookieServer(handler) {
      return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              handler(data, req, res);
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON', id: null }));
            }
          });
        });
        srv.listen(0, '127.0.0.1', () => {
          const { port } = srv.address();
          resolve({ server: srv, port });
        });
      });
    }

    it('uses user/pass Basic auth when useCookieAuth is false', async () => {
      const cp = makeCookiePath('.cookie-userpass');
      try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }

      let capturedAuth = '';
      const mock = await startCookieServer((data, req, res) => {
        capturedAuth = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { blocks: 999 }, error: null, id: data.id }));
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, user: 'myuser', pass: 'mypass', useCookieAuth: false, cookiePath: cp },
        });
        await rpc('getblockchaininfo');
        const decoded = Buffer.from(capturedAuth.replace('Basic ', ''), 'base64').toString('utf8');
        assert.strictEqual(decoded, 'myuser:mypass');
      } finally {
        mock.server.close();
        try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      }
    });

    it('uses cookie auth when useCookieAuth is true', async () => {
      const cp = makeCookiePath('.cookie-use');
      const cookieContent = '__cookie__:DEADBEEFCAFE1234';
      writeCookie(cp, cookieContent);

      let capturedAuth = '';
      const mock = await startCookieServer((data, req, res) => {
        capturedAuth = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { blocks: 999 }, error: null, id: data.id }));
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, useCookieAuth: true, cookiePath: cp },
        });
        await rpc('getblockchaininfo');
        const decoded = Buffer.from(capturedAuth.replace('Basic ', ''), 'base64').toString('utf8');
        assert.strictEqual(decoded, cookieContent);
      } finally {
        mock.server.close();
        try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      }
    });

    it('accepts token-only cookie files and builds standard cookie credentials', async () => {
      const cp = makeCookiePath('.cookie-token-only');
      writeCookie(cp, 'TOKENONLY123');

      let capturedAuth = '';
      const mock = await startCookieServer((data, req, res) => {
        capturedAuth = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true }, error: null, id: data.id }));
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, useCookieAuth: true, cookiePath: cp },
        });
        await rpc('getblockchaininfo');
        const decoded = Buffer.from(capturedAuth.replace('Basic ', ''), 'base64').toString('utf8');
        assert.strictEqual(decoded, '__cookie__:TOKENONLY123');
      } finally {
        mock.server.close();
        try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      }
    });

    it('falls back to user/pass when useCookieAuth=true but cookie file missing', async () => {
      const cp = makeCookiePath('.cookie-fallback');
      // Ensure this file does not exist and no cache entry exists for it
      try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }

      let capturedAuth = '';
      const mock = await startCookieServer((data, req, res) => {
        capturedAuth = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { blocks: 999 }, error: null, id: data.id }));
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, user: 'fbuser', pass: 'fbpass', useCookieAuth: true, cookiePath: cp },
        });
        await rpc('getblockchaininfo');
        const decoded = Buffer.from(capturedAuth.replace('Basic ', ''), 'base64').toString('utf8');
        assert.strictEqual(decoded, 'fbuser:fbpass');
      } finally {
        mock.server.close();
        try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      }
    });

    it('re-reads cookie file on HTTP 401 response', async () => {
      const cp = makeCookiePath('.cookie-401');
      try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      const cookieContent = '__cookie__:INITIALCOOKIE';
      writeCookie(cp, cookieContent);

      let callCount = 0;
      const mock = await startCookieServer((data, req, res) => {
        callCount++;
        if (data.method === 'getblockchaininfo') {
          if (callCount === 1) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: { blocks: 555 }, error: null, id: data.id }));
          }
        }
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, useCookieAuth: true, cookiePath: cp },
        });
        const result = await rpc('getblockchaininfo');
        assert.strictEqual(result.blocks, 555);
        assert.strictEqual(callCount, 2);
      } finally {
        mock.server.close();
        try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      }
    });

    it('re-reads cookie file on HTTP 403 response', async () => {
      const cp = makeCookiePath('.cookie-403');
      try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      const cookieContent = '__cookie__:INITIAL403';
      writeCookie(cp, cookieContent);

      let callCount = 0;
      const mock = await startCookieServer((data, req, res) => {
        callCount++;
        if (data.method === 'getblockchaininfo') {
          if (callCount === 1) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: { blocks: 777 }, error: null, id: data.id }));
          }
        }
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, useCookieAuth: true, cookiePath: cp },
        });
        const result = await rpc('getblockchaininfo');
        assert.strictEqual(result.blocks, 777);
        assert.strictEqual(callCount, 2);
      } finally {
        mock.server.close();
        try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      }
    });

    it('does not retry infinitely on persistent 401', async () => {
      const cp = makeCookiePath('.cookie-inf401');
      try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      const cookieContent = '__cookie__:PERSISTENT401';
      writeCookie(cp, cookieContent);

      const mock = await startCookieServer((data, req, res) => {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, useCookieAuth: true, cookiePath: cp },
        });
        await assert.rejects(rpc('getblockchaininfo'), /HTTP 401/);
      } finally {
        mock.server.close();
        try { fs.unlinkSync(cp); } catch (e) { /* ignore */ }
      }
    });

    it('does not leak cookie content in error message on HTTP error', async () => {
      const mock = await startCookieServer((data, req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error with __cookie__:DEADBEEF in body');
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', useCookieAuth: false },
        });
        await assert.rejects(rpc('getblockchaininfo'), (err) => {
          const msg = err.message || '';
          assert.strictEqual(msg.includes('DEADBEEF'), false);
          return true;
        });
      } finally {
        mock.server.close();
      }
    });

    it('does not leak cookie content in error message on RPC error', async () => {
      const mock = await startCookieServer((data, req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: null, error: { code: -1, message: 'rejected __cookie__:CAFEBABE' }, id: data.id }));
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', useCookieAuth: false },
        });
        await assert.rejects(rpc('getblockchaininfo'), (err) => {
          const msg = err.message || '';
          assert.strictEqual(msg.includes('CAFEBABE'), false);
          return true;
        });
      } finally {
        mock.server.close();
      }
    });

    it('does not leak __cookie__ in HTTP error messages', async () => {
      const mock = await startCookieServer((data, req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error with __cookie__:CAFEBABE in body');
      });
      try {
        const rpc = createRpcClient({
          daemon: { host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', useCookieAuth: false },
        });
        await assert.rejects(rpc('getblockchaininfo'), (err) => {
          const msg = err.message || '';
          assert.strictEqual(msg.includes('__cookie__'), false);
          return true;
        });
      } finally {
        mock.server.close();
      }
    });
  });
});
