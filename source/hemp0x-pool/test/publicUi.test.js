const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

describe('public miner UI', () => {
  it('serves static pages from the public directory only', () => {
    for (const file of ['index.html', 'connect.html', 'miner.html']) {
      assert.ok(fs.existsSync(path.join(PUBLIC_DIR, file)), `public/${file} should exist`);
      assert.equal(
        fs.existsSync(path.join(PUBLIC_DIR, '..', file)),
        false,
        `${file} should not be duplicated at the project root`
      );
    }
  });

  it('does not depend on external font or script assets', () => {
    for (const file of ['index.html', 'connect.html', 'miner.html']) {
      const src = readPublic(file);
      assert.ok(!src.includes('fonts.googleapis.com'), `${file} must not import remote fonts`);
      assert.ok(!src.includes('<script src="http'), `${file} must not import remote scripts`);
      assert.ok(!src.includes('<link rel="stylesheet" href="http'), `${file} must not import remote stylesheets`);
    }
  });

  it('does not hardcode the production stratum host in public pages', () => {
    for (const file of ['index.html', 'connect.html', 'miner.html']) {
      const src = readPublic(file);
      const forbiddenHost = ['147', '93', '185', '184'].join('.');
      assert.ok(!src.includes(forbiddenHost), `${file} must use runtime connection info`);
    }
  });

  it('loads runtime connection details from the public endpoint', () => {
    const index = readPublic('index.html');
    const connect = readPublic('connect.html');

    assert.ok(index.includes('/connect-info'), 'index.html should populate stratum details from /connect-info');
    assert.ok(index.includes('publicStratumUrl'), 'index.html should render the runtime stratum URL');
    assert.ok(connect.includes('/connect-info'), 'connect.html should populate connection details from /connect-info');
  });

  it('keeps copyable connection fields after runtime data loads', () => {
    const connect = readPublic('connect.html');

    assert.ok(connect.includes('function setCopyBlock'), 'connect.html should rebuild copy controls safely');
    assert.ok(connect.includes('dataset.copy'), 'connect.html should keep copy text separate from button text');
    assert.ok(connect.includes('navigator.clipboard'), 'connect.html should support clipboard copying');
  });

  it('sets a local favicon on public pages', () => {
    for (const file of ['index.html', 'connect.html', 'miner.html']) {
      const src = readPublic(file);
      assert.ok(src.includes('rel="icon"'), `${file} should define a favicon`);
      assert.ok(src.includes('href="/logo.png"'), `${file} should use the local logo favicon`);
    }
  });

  it('keeps the public dashboard focused on miner-facing endpoints', () => {
    const index = readPublic('index.html');

    for (const endpoint of ['/stats', '/miners', '/blocks', '/miner/${currentWallet}/stats', '/miner/${currentWallet}/workers']) {
      assert.ok(index.includes(endpoint), `index.html should still call ${endpoint}`);
    }
    assert.ok(!index.includes('/admin/config'), 'public dashboard must not call admin config endpoints');
  });

  it('keeps dry-run payout rows out of miner-facing activity', () => {
    const index = readPublic('index.html');
    const miner = readPublic('miner.html');

    for (const src of [index, miner]) {
      assert.ok(src.includes('ledgerPayouts'), 'miner activity should include payout ledger rows');
      assert.ok(src.includes("p.batch_status === 'broadcasted' || p.batch_status === 'confirmed'"), 'miner activity should only show broadcasted or confirmed ledger payouts');
      assert.ok(!src.includes('Planned Payout'), 'planned payout rows should not be visible to miners');
      assert.ok(!src.includes('DRY RUN'), 'dry-run payout rows should not be visible to miners');
    }
  });

  it('keeps obsolete pool reward rows out of miner-facing activity', () => {
    const index = readPublic('index.html');
    const miner = readPublic('miner.html');

    for (const src of [index, miner]) {
      assert.ok(!src.includes('Pool Rewards'), 'old pool rewards tab should not be visible');
      assert.ok(!src.includes('tabFinder'), 'old pool rewards panel should not be present');
      assert.ok(!src.includes('txRowsFinder'), 'old pool rewards rows should not be rendered');
      assert.ok(!src.includes('Pool Reward'), 'old finder payout rows should not be rendered');
      assert.ok(!src.includes('p.category'), 'miner UI should not classify old payout table rows');
    }
  });

  it('uses miner-friendly payout status labels', () => {
    const index = readPublic('index.html');
    const miner = readPublic('miner.html');

    for (const src of [index, miner]) {
      assert.ok(src.includes('function payoutStatusLabel'), 'public pages should normalize payout status labels');
      assert.ok(src.includes("normalized === 'confirmed'"), 'confirmed payout ledger rows should be shown as paid');
      assert.ok(src.includes("return 'PAID'"), 'confirmed payout ledger rows should use PAID');
      assert.ok(src.includes("return 'BROADCASTED'"), 'broadcast payout ledger rows should use BROADCASTED');
    }
  });

  it('validates miner lookup and makes txids copyable', () => {
    const index = readPublic('index.html');
    const miner = readPublic('miner.html');

    assert.ok(index.includes('Invalid Hemp0x address.'), 'dashboard lookup should reject invalid addresses');
    assert.ok(index.includes('Address not found on this pool yet.'), 'dashboard lookup should report missing miners');
    for (const src of [index, miner]) {
      assert.ok(src.includes('class="copy-tx"'), 'payout txids should render as copy buttons');
      assert.ok(src.includes('navigator.clipboard.writeText'), 'copy buttons should use clipboard API');
      assert.ok(src.includes('data-copy='), 'full txid should be available for copying');
    }
  });

  it('links pool branding home and renders activity timestamps with dates', () => {
    const index = readPublic('index.html');
    const miner = readPublic('miner.html');

    for (const src of [index, miner]) {
      assert.ok(src.includes('href="/" class="brand-link"'), 'logo/title branding should link to the pool home page');
      assert.ok(src.includes('function formatActivityTime'), 'activity tables should use the shared timestamp formatter');
      assert.ok(src.includes("year: 'numeric'"), 'activity timestamps should include the date');
      assert.ok(!src.includes('toLocaleTimeString'), 'activity timestamps should not be time-only');
    }
  });
});
