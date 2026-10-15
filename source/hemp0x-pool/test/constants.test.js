const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  SATS_PER_HEMP,
  hempToSats,
  hempToSatsNumber,
  satsToHemp,
  satsToDisplay,
} = require('../constants');

describe('constants', () => {
  it('SATS_PER_HEMP is 100000000', () => {
    assert.strictEqual(SATS_PER_HEMP, 100_000_000);
  });

  it('hempToSats converts whole numbers', () => {
    assert.strictEqual(hempToSats(1), 100_000_000n);
    assert.strictEqual(hempToSats(5), 500_000_000n);
  });

  it('hempToSats converts decimal strings without floating-point drift', () => {
    assert.strictEqual(hempToSats('1.5'), 150_000_000n);
    assert.strictEqual(hempToSats('0.00000001'), 1n);
    assert.strictEqual(hempToSats('10.12345678'), 1012345678n);
  });

  it('hempToSats converts negative amounts', () => {
    assert.strictEqual(hempToSats('-2.5'), -250_000_000n);
  });

  it('hempToSats rejects invalid input', () => {
    assert.throws(() => hempToSats('abc'), /Invalid HEMP amount/);
    assert.throws(() => hempToSats('1.2.3'), /Invalid HEMP amount/);
    assert.throws(() => hempToSats('1.123456789'), /more than 8 decimal places/);
  });

  it('hempToSatsNumber returns a Number within safe range', () => {
    assert.strictEqual(hempToSatsNumber(1.25), 125_000_000);
  });

  it('hempToSatsNumber throws beyond MAX_SAFE_INTEGER', () => {
    const huge = (Number.MAX_SAFE_INTEGER / SATS_PER_HEMP + 1).toString();
    assert.throws(() => hempToSatsNumber(huge), /exceeds safe integer/);
  });

  it('satsToHemp converts back to decimal string', () => {
    assert.strictEqual(satsToHemp(100_000_000n), '1');
    assert.strictEqual(satsToHemp(150_000_000), '1.5');
    assert.strictEqual(satsToHemp(1), '0.00000001');
    assert.strictEqual(satsToHemp(0), '0');
  });

  it('satsToHemp handles negative values', () => {
    assert.strictEqual(satsToHemp(-50_000_000n), '-0.5');
  });

  it('satsToDisplay produces fixed 8-decimal output', () => {
    assert.strictEqual(satsToDisplay(100_000_000n), '1.00000000');
    assert.strictEqual(satsToDisplay(1), '0.00000001');
    assert.strictEqual(satsToDisplay(123456789n), '1.23456789');
  });

  it('round-trip preserves exact satoshi values', () => {
    const values = [
      '0',
      '0.00000001',
      '1',
      '1.23456789',
      '100.00000001',
      '99999999.99999999',
    ];
    for (const v of values) {
      assert.strictEqual(satsToHemp(hempToSats(v)), v);
    }
  });
});
