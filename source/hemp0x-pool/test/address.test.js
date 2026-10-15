const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidAddress,
  isRoutableAddress,
  hasValidBase58Check,
  isP2PKHAddress,
  base58Decode,
  addressToPubkeyHash,
  buildP2PKHScript,
} = require('../address');
const { TEST_ADDRESSES } = require('./addressFixtures');

describe('address', () => {
  describe('isValidAddress', () => {
    it('accepts valid 25-34 char Hemp0x addresses', () => {
      assert.equal(isValidAddress('RXfinder1111111111111111111111111'), true);
      assert.equal(isValidAddress('RXminer11111111111111111111111111'), true);
      assert.equal(isValidAddress('RXminer22222222222222222222222222'), true);
    });

    it('rejects non-string inputs', () => {
      assert.equal(isValidAddress(null), false);
      assert.equal(isValidAddress(undefined), false);
      assert.equal(isValidAddress(123), false);
      assert.equal(isValidAddress({}), false);
    });

    it('rejects empty string', () => {
      assert.equal(isValidAddress(''), false);
    });

    it('rejects address with invalid prefix', () => {
      assert.equal(isValidAddress('XXfinder111111111111111111111111'), false);
      assert.equal(isValidAddress('1Xfinder11111111111111111111111'), false);
    });

    it('rejects address with invalid characters', () => {
      // 0, O, I, l are excluded from Base58 - but only if present
      assert.equal(isValidAddress('RXf0nder11111111111111111111111'), false);
      assert.equal(isValidAddress('RXfOnder11111111111111111111111'), false);
      assert.equal(isValidAddress('RXfInder11111111111111111111111'), false);
      assert.equal(isValidAddress('RXflnder11111111111111111111111'), false);
    });

    it('rejects address that is too short', () => {
      assert.equal(isValidAddress('RXbad'), false);
      assert.equal(isValidAddress('R123456789012345678901234'), false);
    });

    it('rejects address that is too long', () => {
      assert.equal(isValidAddress('R' + 'a'.repeat(35)), false);
    });
  });

  describe('isRoutableAddress', () => {
    it('accepts a checksum-valid Hemp0x address', () => {
      assert.equal(isValidAddress(TEST_ADDRESSES.checksumMiner), true);
      assert.equal(hasValidBase58Check(TEST_ADDRESSES.checksumMiner), true);
      assert.equal(isRoutableAddress(TEST_ADDRESSES.checksumMiner), true);
    });

    it('rejects a syntactically valid address with a bad checksum', () => {
      const badChecksum = `${TEST_ADDRESSES.checksumMiner.slice(0, -1)}d`;
      assert.equal(isValidAddress(badChecksum), true);
      assert.equal(hasValidBase58Check(badChecksum), false);
      assert.equal(isRoutableAddress(badChecksum), false);
    });
  });

  describe('isP2PKHAddress', () => {
    it('accepts exactly 33 character addresses', () => {
      assert.equal(isP2PKHAddress('R' + 'm'.repeat(33)), true);
      assert.equal(isP2PKHAddress('R' + 'n'.repeat(33)), true);
    });

    it('rejects non-33 character addresses', () => {
      assert.equal(isP2PKHAddress('RXfinder1111111111111111111111111'), false);
      assert.equal(isP2PKHAddress('RXshorter'), false);
    });

    it('rejects non-string inputs', () => {
      assert.equal(isP2PKHAddress(null), false);
      assert.equal(isP2PKHAddress(undefined), false);
    });
  });

  describe('base58Decode', () => {
    it('returns null for non-string or empty input', () => {
      assert.equal(base58Decode(''), null);
      assert.equal(base58Decode(null), null);
      assert.equal(base58Decode(undefined), null);
      assert.equal(base58Decode(123), null);
    });

    it('returns null for invalid base58 chars', () => {
      assert.equal(base58Decode('RX0OOO'), null);
    });

    it('decodes a valid address to a buffer', () => {
      const buf = base58Decode('RXminer11111111111111111111111111');
      assert.ok(buf);
      assert.ok(Buffer.isBuffer(buf));
      assert.ok(buf.length > 0);
    });
  });

  describe('addressToPubkeyHash', () => {
    it('returns a 20-byte zero buffer for invalid addresses', () => {
      const result = addressToPubkeyHash('invalid_address');
      assert.ok(Buffer.isBuffer(result));
      assert.equal(result.length, 20);
      assert.equal(result.equals(Buffer.alloc(20, 0)), true);
    });

    it('returns a 20-byte buffer for a valid address', () => {
      const result = addressToPubkeyHash('RXminer11111111111111111111111111');
      assert.ok(Buffer.isBuffer(result));
      assert.equal(result.length, 20);
    });
  });

  describe('buildP2PKHScript', () => {
    it('produces a script starting with 76a914 and ending with 88ac', () => {
      const script = buildP2PKHScript('RXminer11111111111111111111111111');
      const hex = script.toString('hex');
      assert.ok(hex.startsWith('76a914'));
      assert.ok(hex.endsWith('88ac'));
      assert.equal(hex.length, 50);
    });
  });

  describe('exports', () => {
    it('exports all expected functions', () => {
      assert.equal(typeof isValidAddress, 'function');
      assert.equal(typeof isRoutableAddress, 'function');
      assert.equal(typeof hasValidBase58Check, 'function');
      assert.equal(typeof isP2PKHAddress, 'function');
      assert.equal(typeof base58Decode, 'function');
      assert.equal(typeof addressToPubkeyHash, 'function');
      assert.equal(typeof buildP2PKHScript, 'function');
    });
  });
});
