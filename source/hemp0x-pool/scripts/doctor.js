#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const POOL_DIR = path.resolve(__dirname, '..');
const EXAMPLE_CONFIG = path.join(POOL_DIR, 'config.example.json');
const LIVE_CONFIG = path.join(POOL_DIR, 'config.json');

const REQUIRED_DOCS = [
  'README.md',
  'docs/SETUP.md',
  'docs/ARCHITECTURE.md',
  'docs/CONFIG.md',
  'docs/OPERATIONS.md',
  'docs/RELEASE.md',
];

const REQUIRED_MODULES = [
  'server.js',
  'config.js',
  'configSchema.js',
  'configRedaction.js',
  'adminApi.js',
  'payoutPlanner.js',
  'payoutLedger.js',
  'payoutWorker.js',
  'consolidationPlanner.js',
  'consolidationLedger.js',
  'utxoHealth.js',
  'address.js',
  'rpcClient.js',
  'confirmation.js',
  'database.js',
  'migrations.js',
  'constants.js',
  'txConstants.js',
];

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const INFO = '\x1b[36mℹ\x1b[0m';

let failures = 0;
let warnings = 0;

function log(prefix, msg) {
  console.log(`  ${prefix} ${msg}`);
}

function check(label, fn) {
  try {
    const result = fn();
    if (result === false) {
      log(FAIL, label);
      failures++;
    } else if (result === 'warn') {
      log(WARN, label);
      warnings++;
    } else {
      log(PASS, label);
    }
  } catch (e) {
    log(FAIL, `${label} — ${e.message}`);
    failures++;
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

// ---------------------------------------------------------------------------
// 1. Example config
// ---------------------------------------------------------------------------
section('Config');

check('config.example.json exists', () => {
  return fs.existsSync(EXAMPLE_CONFIG);
});

let exampleCfg = null;
check('config.example.json is valid JSON', () => {
  const raw = fs.readFileSync(EXAMPLE_CONFIG, 'utf8');
  exampleCfg = JSON.parse(raw);
  return typeof exampleCfg === 'object';
});

check('config.example.json has safe defaults', () => {
  if (!exampleCfg) return false;

  const checks = [
    exampleCfg.payout?.dryRun === true,
    exampleCfg.consolidation?.enabled === false,
    exampleCfg.consolidation?.dryRunOnly === true,
    exampleCfg.automation?.routinePayoutEnabled === false,
    exampleCfg.automation?.payoutBroadcastEnabled === false,
    exampleCfg.automation?.consolidationBroadcastEnabled === false,
  ];
  return checks.every(Boolean);
});

check('config.example.json has no hardcoded secrets', () => {
  if (!exampleCfg) return false;
  const raw = fs.readFileSync(EXAMPLE_CONFIG, 'utf8');
  const lower = raw.toLowerCase();

  const noSecrets =
    exampleCfg.daemon.useCookieAuth === true &&
    exampleCfg.daemon.cookiePath === '/var/lib/hemp0x-pool/rpc.cookie' &&
    exampleCfg.daemon.user === undefined &&
    exampleCfg.daemon.pass === undefined &&
    exampleCfg.pool.wallet === 'YOUR_POOL_WALLET_ADDRESS' &&
    !lower.includes('privatekey') &&
    !lower.includes('mainnet-prod');

  if (noSecrets) {
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// 2. Live config (if exists)
// ---------------------------------------------------------------------------
if (fs.existsSync(LIVE_CONFIG)) {
  check('config.json loads and validates (safe defaults enforced)', () => {
    const { loadConfig } = require('../config');
    try {
      const cfg = loadConfig(LIVE_CONFIG);
      const safetyGates = cfg && cfg.automation
        ? 'ok'
        : null;
      return safetyGates === 'ok';
    } catch (e) {
      if (e.message && e.message.includes('Safety gate')) {
        return false;
      }
      return false;
    }
  });

  try {
    const { loadConfig } = require('../config');
    const cfg = loadConfig(LIVE_CONFIG);
    const { getSafetyGateStatus } = require('../config');
    const gates = getSafetyGateStatus(cfg);

    console.log(`  ${INFO} Safety gates:`);
    for (const g of gates.gates) {
      const marker = g.safe ? PASS : FAIL;
      const val = typeof g.currentValue === 'boolean' ? g.currentValue : String(g.currentValue);
      console.log(`    ${marker} ${g.name} = ${val}`);
    }
    if (!gates.allSafe) failures++;
  } catch (e) {
    log(FAIL, `Safety gate check failed: ${e.message}`);
    failures++;
  }

  try {
    const { loadConfig } = require('../config');
    const cfg = loadConfig(LIVE_CONFIG);
    const { redactSecrets } = require('../configRedaction');
    const redacted = redactSecrets(cfg);

    log(INFO, 'Redacted config summary (secrets hidden):');
    for (const section of Object.keys(redacted)) {
      if (typeof redacted[section] === 'object' && redacted[section] !== null) {
        const keys = Object.keys(redacted[section]);
        if (keys.length > 0) {
          const displayKeys = keys.slice(0, 5).join(', ') + (keys.length > 5 ? '...' : '');
          log(INFO, `  ${section}: { ${displayKeys} }`);
        }
      }
    }
  } catch (e) {
    log(FAIL, `Config redaction check failed: ${e.message}`);
    failures++;
  }
} else {
  log(WARN, 'config.json not found — skipping live config checks');
  warnings++;
}

// ---------------------------------------------------------------------------
// 3. Git safety — check sensitive files not tracked
// ---------------------------------------------------------------------------
section('Git Safety');

function gitAvailable() {
  try {
    execSync('git rev-parse --git-dir', { cwd: POOL_DIR, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (gitAvailable()) {
  check('No config.json tracked by git', () => {
    try {
      const output = execSync('git ls-files --cached -- config.json', {
        cwd: POOL_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (output.trim()) {
        console.log(`      tracked: ${output.trim()}`);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  });

  check('No .db files tracked by git', () => {
    try {
      const output = execSync('git ls-files --cached -- "*.db" "*.sqlite" "*.sqlite3" "*.db-*"', {
        cwd: POOL_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (output.trim()) {
        console.log(`      tracked: ${output.trim().split('\n').slice(0, 3).join(', ')}`);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  });

  check('No .env files tracked by git', () => {
    try {
      const output = execSync('git ls-files --cached -- ".env" ".env.*"', {
        cwd: POOL_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (output.trim()) {
        console.log(`      tracked: ${output.trim()}`);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  });

  check('No log/pid/sock files tracked by git', () => {
    try {
      const output = execSync('git ls-files --cached -- "*.log" "*.pid" "*.sock"', {
        cwd: POOL_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (output.trim()) {
        console.log(`      tracked: ${output.trim()}`);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  });
} else {
  log(WARN, 'Git not available — skipping git safety checks');
  warnings++;
}

// ---------------------------------------------------------------------------
// 4. Required docs
// ---------------------------------------------------------------------------
section('Documentation');

for (const doc of REQUIRED_DOCS) {
  check(`Doc exists: ${doc}`, () => {
    return fs.existsSync(path.join(POOL_DIR, doc));
  });
}

// ---------------------------------------------------------------------------
// 5. Required source modules
// ---------------------------------------------------------------------------
section('Source Modules');

for (const mod of REQUIRED_MODULES) {
  check(`Module exists: ${mod}`, () => {
    return fs.existsSync(path.join(POOL_DIR, mod));
  });
}

// ---------------------------------------------------------------------------
// 6. Admin dashboard
// ---------------------------------------------------------------------------
section('Admin Dashboard');

const adminHtmlPath = path.join(POOL_DIR, 'public', 'admin.html');
check('admin.html exists', () => {
  return fs.existsSync(adminHtmlPath);
});

if (fs.existsSync(adminHtmlPath)) {
  const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');

  check('admin.html includes payoutAutomation display', () => {
    return adminHtml.includes('payoutAutomation') || adminHtml.includes('Payout Automation');
  });

  check('admin.html has no unsafe broadcast RPC strings', () => {
    const unsafe = ['sendmany', 'sendrawtransaction', 'walletpassphrase',
      'wallet_unlock', 'signrawtransaction', 'dumpprivkey', 'walletlock'];
    for (const s of unsafe) {
      if (adminHtml.includes(s)) {
        log(FAIL, `admin.html contains unsafe string: ${s}`);
        return false;
      }
    }
    return true;
  });

  check('admin.html has no config-write endpoints', () => {
    const writeEndpoints = [
      '/admin/config/write',
      '/admin/config/reload',
      '/admin/config/save',
    ];
    for (const ep of writeEndpoints) {
      if (adminHtml.includes(ep)) {
        log(FAIL, `admin.html references config-write endpoint: ${ep}`);
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 7. Optional: RPC smoke check (--rpc flag)
// ---------------------------------------------------------------------------
const doRpc = process.argv.includes('--rpc') || process.argv.includes('--rpc-check');

function printSummaryAndExit() {
  console.log(`\n${'═'.repeat(50)}`);
  if (failures === 0) {
    console.log(`${PASS} Preflight complete — ${failures} failures, ${warnings} warnings`);
  } else {
    console.log(`${FAIL} Preflight complete — ${failures} failures, ${warnings} warnings`);
  }
  console.log(`${'═'.repeat(50)}`);
  process.exit(failures > 0 ? 1 : 0);
}

async function runRpcSmokeCheck() {
  section('RPC Smoke Check (opt-in)');

  if (!fs.existsSync(LIVE_CONFIG)) {
    log(FAIL, '--rpc requires config.json');
    failures++;
    return;
  }

  try {
    const { loadConfig } = require('../config');
    const cfg = loadConfig(LIVE_CONFIG);

    log(INFO, `Connecting to daemon at ${cfg.daemon.host}:${cfg.daemon.port}`);
    log(INFO, '(credentials not displayed)');

    const { createRpcClient } = require('../rpcClient');
    const rpc = createRpcClient({ daemon: cfg.daemon });

    try {
      const info = await rpc('getblockchaininfo');
      log(PASS, `Daemon reachable — chain: ${info.chain}, blocks: ${info.blocks}, headers: ${info.headers}`);
    } catch (e) {
      const rawMsg = e.message || String(e);
      const user = cfg.daemon.user || '';
      const pass = cfg.daemon.pass || '';
      const msg = rawMsg
        .replace(user ? new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$a/, '***')
        .replace(pass ? new RegExp(pass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$a/, '***');
      log(FAIL, `RPC getblockchaininfo failed: ${msg}`);
      failures++;
    }
  } catch (e) {
    log(FAIL, `RPC client setup failed: ${e.message}`);
    failures++;
  }
}

if (doRpc) {
  runRpcSmokeCheck()
    .catch((e) => {
      log(FAIL, `RPC smoke check crashed: ${e.message}`);
      failures++;
    })
    .finally(printSummaryAndExit);
} else {
  printSummaryAndExit();
}
