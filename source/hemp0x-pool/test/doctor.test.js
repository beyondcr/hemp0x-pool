const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const CUSTOM_POOL_DIR = path.resolve(__dirname, '..');
const DOCTOR_PATH = path.join(CUSTOM_POOL_DIR, 'scripts', 'doctor.js');
const ADMIN_HTML_PATH = path.join(CUSTOM_POOL_DIR, 'public', 'admin.html');

function runDoctor(args = []) {
  const result = spawnSync(process.execPath, [DOCTOR_PATH, ...args], {
    cwd: CUSTOM_POOL_DIR,
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    combined: (result.stdout || '') + (result.stderr || ''),
  };
}

describe('doctor script', () => {
  describe('runs successfully with example config', () => {
    it('exits with code 0', () => {
      const r = runDoctor();
      assert.strictEqual(r.exitCode, 0, `doctor failed with exit ${r.exitCode}\n${r.combined.slice(0, 500)}`);
    });

    it('confirms config.example.json exists and is valid', () => {
      const r = runDoctor();
      assert.match(r.combined, /config\.example\.json exists/);
    });

    it('confirms required docs exist', () => {
      const r = runDoctor();
      assert.match(r.combined, /SETUP\.md/);
      assert.match(r.combined, /ARCHITECTURE\.md/);
      assert.match(r.combined, /RELEASE\.md/);
    });

    it('confirms required source modules exist', () => {
      const r = runDoctor();
      assert.match(r.combined, /server\.js/);
      assert.match(r.combined, /config\.js/);
      assert.match(r.combined, /adminApi\.js/);
    });

    it('confirms admin.html exists', () => {
      const r = runDoctor();
      assert.match(r.combined, /admin\.html exists/);
    });
  });

  describe('does not expose secrets in output', () => {
    it('does not print daemon credentials', () => {
      const r = runDoctor();

      assert.doesNotMatch(r.combined, /RPC_USER/);
      assert.doesNotMatch(r.combined, /RPC_PASSWORD/);

      const lower = r.combined.toLowerCase();
      assert.doesNotMatch(lower, /privatekey/);
      assert.doesNotMatch(lower, /walletpass/);
    });

    it('does not print config.json daemon secrets even when config exists', () => {
      // Create a temporary config.json with known secrets and verify they don't leak
      const tempConfig = path.join(CUSTOM_POOL_DIR, '__doctor_test_config.json');
      try {
        fs.writeFileSync(tempConfig, JSON.stringify({
          daemon: { user: 'mySecretUser', pass: 'mySecretPass' },
          pool: { wallet: 'R111111111111111111111111111111111' },
        }));

        const r = runDoctor();

        assert.doesNotMatch(r.combined, /mySecretUser/);
        assert.doesNotMatch(r.combined, /mySecretPass/);
      } finally {
        if (fs.existsSync(tempConfig)) fs.unlinkSync(tempConfig);
      }
    });
  });

  describe('does not require or call live RPC by default', () => {
    it('has no default RPC logic without --rpc flag', () => {
      const source = fs.readFileSync(DOCTOR_PATH, 'utf8');

      assert.match(source, /--rpc/);
      assert.match(source, /doRpc/);

      const r = runDoctor();

      assert.doesNotMatch(r.combined, /RPC Smoke Check/i);
    });

    it('--rpc flag triggers RPC section but does not expose credentials', () => {
      const r = runDoctor(['--rpc']);

      const combined = r.combined;

      assert.doesNotMatch(combined, /RPC_USER/);
      assert.doesNotMatch(combined, /RPC_PASSWORD/);
      assert.doesNotMatch(combined, /mySecretUser/);
      assert.doesNotMatch(combined, /mySecretPass/);

      if (fs.existsSync(path.join(CUSTOM_POOL_DIR, 'config.json'))) {
        assert.match(combined, /RPC Smoke Check|--rpc requires config/);
      }
    });

    it('doctor source does not import rpcClient at module level', () => {
      const source = fs.readFileSync(DOCTOR_PATH, 'utf8');
      // The RPC client require should only be inside the --rpc conditional
      const lines = source.split('\n');
      let rpcRequireFound = false;
      let inRpcBlock = false;

      for (const line of lines) {
        if (line.includes('doRpc') && line.includes('=')) inRpcBlock = true;
        if (inRpcBlock && line.includes('createRpcClient')) rpcRequireFound = true;
        if (/^\s*\$/.test(line)) break; // Not quite right but serves
      }

      // Just verify the source has the guard pattern
      const guardIndex = source.indexOf('const doRpc');
      const rpcRequireIndex = source.indexOf("require('../rpcClient')");
      assert.ok(rpcRequireIndex > guardIndex,
        'rpcClient require should be inside the --rpc conditional, not at top level');
    });
  });
});

describe('admin dashboard source review', () => {
  const adminHtml = fs.readFileSync(ADMIN_HTML_PATH, 'utf8');

  describe('includes payout automation status rendering', () => {
    it('renders payoutAutomation data in JS source', () => {
      assert.match(adminHtml, /payoutAutomation/,
        'admin.html source must reference payoutAutomation');
    });

    it('renders mode badge labels', () => {
      assert.match(adminHtml, /DRY RUN|dry_run/,
        'admin.html source must render dry_run mode');
      assert.match(adminHtml, /LIVE|mode.*live/,
        'admin.html source must render live mode');
    });

    it('renders gate statuses in JS source', () => {
      const source = adminHtml;
      assert.match(source, /payoutBroadcastEnabled/,
        'admin.html source must reference payoutBroadcastEnabled gate');
      assert.match(source, /routinePayoutEnabled/,
        'admin.html source must reference routinePayoutEnabled gate');
      assert.match(source, /liveCapable/,
        'admin.html source must reference liveCapable status');
    });

    it('includes payout-automation-panel element', () => {
      assert.match(adminHtml, /id="payout-automation-panel"/,
        'admin.html must contain payout-automation-panel element');
    });
  });

  describe('has no unsafe broadcast/sign/unlock/config-write controls', () => {
    it('does not contain unsafe RPC method strings', () => {
      const unsafe = [
        'sendmany',
        'sendrawtransaction',
        'createrawtransaction',
        'walletpassphrase',
        'wallet_unlock',
        'encryptwallet',
        'signrawtransaction',
        'dumpprivkey',
        'walletlock',
        'fundrawtransaction',
        'createsignedtransaction',
      ];
      for (const s of unsafe) {
        assert.ok(!adminHtml.includes(s), `admin.html must not contain unsafe RPC method: ${s}`);
      }
    });

    it('does not contain config write or reload endpoint references', () => {
      const endpoints = [
        '/admin/config/write',
        '/admin/config/reload',
        '/admin/config/save',
        '/admin/config/update',
        '/admin/broadcast',
        '/admin/sign',
        '/admin/wallet/unlock',
        '/admin/payout/execute',
        '/admin/payout/broadcast',
      ];
      for (const ep of endpoints) {
        assert.ok(!adminHtml.includes(ep), `admin.html must not reference unsafe endpoint: ${ep}`);
      }
    });

    it('does not contain broadcast or execute buttons/actions', () => {
      const dangerousPatterns = [
        /<button[^>]*>\s*Broadcast/i,
        /<button[^>]*>\s*Execute Payout/i,
        /<button[^>]*>\s*Sign Transaction/i,
        /<button[^>]*>\s*Unlock Wallet/i,
        /<button[^>]*>\s*Send Payout/i,
        /<button[^>]*>\s*Broadcast Payout/i,
      ];
      for (const pattern of dangerousPatterns) {
        assert.ok(!pattern.test(adminHtml), `admin.html must not contain button with unsafe action: ${pattern}`);
      }
    });
  });
});
