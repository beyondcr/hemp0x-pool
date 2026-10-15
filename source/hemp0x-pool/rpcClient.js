const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COOKIE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_COOKIE_PATH = path.join(os.homedir(), '.hemp', '.cookie');

const cookieCache = new Map();

function resolveCookiePath(cookiePath) {
  return cookiePath || DEFAULT_COOKIE_PATH;
}

function sanitizeRpcMessage(value) {
  return String(value || '')
    .replace(/Authorization:\s*Basic\s+[^\r\n]*/gi, 'Authorization: Basic ***')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***')
    .replace(/__cookie__:[^\s"'<>]+/g, '[credential]');
}

/**
 * Read the daemon cookie file.
 * The cookie file format is: __cookie__:HEX_TOKEN
 * Returns the full Basic auth credential trimmed, or null if unreadable.
 */
function readCookieFile(cookiePath) {
  try {
    const resolved = resolveCookiePath(cookiePath);
    const content = fs.readFileSync(resolved, 'utf8').trim();
    if (!content) return null;
    const credential = content.startsWith('__cookie__:') ? content : `__cookie__:${content}`;
    cookieCache.set(resolved, { credential, loadedAt: Date.now() });
    return credential;
  } catch (e) {
    return null;
  }
}

/**
 * Get the current cookie content, honoring cache TTL.
 * Returns null if the cookie file cannot be read or cache is stale.
 */
function getCachedCookie(cookiePath, forceReload) {
  const resolved = resolveCookiePath(cookiePath);
  const now = Date.now();
  const cached = cookieCache.get(resolved);
  if (!forceReload && cached && cached.credential && (now - cached.loadedAt) < COOKIE_CACHE_TTL_MS) {
    return cached.credential;
  }
  cookieCache.delete(resolved);
  return readCookieFile(cookiePath);
}

/**
 * Perform a single raw HTTP RPC call with the given auth header.
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function rawRpcCall(daemon, method, params, authValue, options = {}) {
  return new Promise((resolve, reject) => {
    const host = daemon.host || '127.0.0.1';
    const port = daemon.port || 42070;
    const payload = JSON.stringify({ jsonrpc: '1.0', id: method, method, params });
    const authHeader = authValue ? `Basic ${Buffer.from(authValue).toString('base64')}` : '';
    const timeout = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 60000;

    const requestOptions = {
      hostname: host,
      port,
      path: '/',
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': authHeader,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(requestOptions, (res) => {
      let buff = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buff += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: buff });
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy(new Error(`RPC ${method} timed out`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Process an RPC response into a result or throw an error.
 * Ensures no cookie content leaks into error messages.
 */
function processRpcResponse(method, statusCode, body) {
  if (statusCode < 200 || statusCode >= 300) {
    const sanitizedBody = sanitizeRpcMessage(body);
    throw new Error(`RPC ${method} HTTP ${statusCode}: ${sanitizedBody.slice(0, 160)}`);
  }
  try {
    const result = JSON.parse(body);
    if (result.error) {
      const err = new Error(
        sanitizeRpcMessage(result.error.message || JSON.stringify(result.error))
      );
      err.code = result.error.code;
      err.rpcError = { ...result.error, message: sanitizeRpcMessage(result.error.message) };
      throw err;
    }
    return result.result;
  } catch (e) {
    if (e.code !== undefined && e.rpcError !== undefined) throw e;
    const sanitizedBody = sanitizeRpcMessage(body);
    throw new Error(`RPC ${method} returned non-JSON response: ${sanitizedBody.slice(0, 160)}`);
  }
}

/**
 * Create an RPC client function bound to a daemon config.
 *
 * Supports:
 *   - user/pass Basic auth when useCookieAuth is false (default)
 *   - cookie auth when useCookieAuth is true (reads daemon.cookiePath)
 *   - cookie file format: __cookie__:TOKEN
 *   - Cookie cached with 5-minute TTL
 *   - Automatic cookie re-read + retry on 401/403 responses
 *   - No cookie/token leaks in thrown errors or error messages
 *
 * @param {object} config - Configuration object containing `daemon` settings.
 * @returns {function(string, Array): Promise<any>} RPC caller.
 */
function createRpcClient(config) {
  const daemon = config?.daemon || {};
  const user = daemon.user || '';
  const pass = daemon.pass || '';
  const useCookieAuth = daemon.useCookieAuth === true;
  const cookiePath = daemon.cookiePath || DEFAULT_COOKIE_PATH;

  async function rpc(method, params = [], options = {}) {
    if (useCookieAuth) {
      return rpcWithCookie(method, params, false, options);
    }
    return rpcWithUserPass(method, params, options);
  }

  async function rpcWithUserPass(method, params, options) {
    const authValue = `${user}:${pass}`;
    const response = await rawRpcCall(daemon, method, params, authValue, options);
    return processRpcResponse(method, response.statusCode, response.body);
  }

  async function rpcWithCookie(method, params, isRetry, options) {
    const cookieContent = getCachedCookie(cookiePath, isRetry);

    if (!cookieContent) {
      if (user && pass) {
        console.warn('[rpcClient] Cookie file not found or unreadable, falling back to user/pass');
        return rpcWithUserPass(method, params, options);
      }
      throw new Error(
        `RPC ${method}: Cookie auth file is unavailable and no user/pass fallback is configured`
      );
    }

    const response = await rawRpcCall(daemon, method, params, cookieContent, options);

    if ((response.statusCode === 401 || response.statusCode === 403) && !isRetry) {
      return rpcWithCookie(method, params, true, options);
    }

    return processRpcResponse(method, response.statusCode, response.body);
  }

  return rpc;
}

module.exports = { createRpcClient };
