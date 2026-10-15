const crypto = require('crypto');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEMP0X_P2PKH_VERSION = 60;

const TEST_ADDRESSES = {
  finderA: 'RAs77XQmzb5EuMAhocC3KbRnt7XCVKWpEu',
  finderB: 'RD4kDrdw95KorCb5aXMduvSKWXN7RhsaDT',
  miner1: 'RR7NUerfCE5MtWJH7VWB9q9Lm5xxdLnyvk',
  miner2: 'RQDGe67vstsQ6u71m9ySEvohBnrZxiyemV',
  miner3: 'RL2i1bpJSzhCo9oGJj4aLW5re4qTxF8xJK',
  miner4: 'RCWkJededMG3xW3xGJYrq1E9pfqrdm8njh',
  checksumMiner: makeTestAddress('checksum-miner-fixture'),
};

function sha256d(buffer) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buffer).digest()
  ).digest();
}

function base58Encode(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  const digits = [0];
  for (const byte of buffer) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let output = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) output += ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) output += ALPHABET[digits[i]];
  return output;
}

function makeTestAddress(seed) {
  const hash160 = crypto.createHash('ripemd160')
    .update(crypto.createHash('sha256').update(String(seed)).digest())
    .digest();
  const payload = Buffer.concat([Buffer.from([HEMP0X_P2PKH_VERSION]), hash160]);
  return base58Encode(Buffer.concat([payload, sha256d(payload).slice(0, 4)]));
}

module.exports = { TEST_ADDRESSES, makeTestAddress };
