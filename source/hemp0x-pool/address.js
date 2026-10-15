const crypto = require('crypto');

const ADDRESS_REGEX = /^R[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const P2PKH_ADDRESS_REGEX = /^R[1-9A-HJ-NP-Za-km-z]{33}$/;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = {};
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET.charAt(i)] = i;

function sha256d(buffer) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buffer).digest()
  ).digest();
}

function base58Decode(string) {
  if (typeof string !== 'string' || string.length === 0) return null;
  let bytes = [0];
  for (let i = 0; i < string.length; i++) {
    const c = string[i];
    if (!(c in ALPHABET_MAP)) return null;
    for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
    bytes[0] += ALPHABET_MAP[c];
    let carry = 0;
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < string.length && string[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function isValidAddress(addr) {
  return typeof addr === 'string' && ADDRESS_REGEX.test(addr);
}

function hasValidBase58Check(addr) {
  const decoded = base58Decode(addr);
  if (!decoded || decoded.length !== 25) return false;
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const hash = sha256d(payload);
  return hash[0] === checksum[0] && hash[1] === checksum[1] &&
    hash[2] === checksum[2] && hash[3] === checksum[3];
}

function isRoutableAddress(addr) {
  return isValidAddress(addr) && hasValidBase58Check(addr);
}

function isP2PKHAddress(addr) {
  return typeof addr === 'string' && P2PKH_ADDRESS_REGEX.test(addr);
}

function addressToPubkeyHash(address) {
  try {
    const decoded = base58Decode(address);
    if (!decoded || decoded.length !== 25) {
      return Buffer.alloc(20, 0);
    }
    const payload = decoded.slice(0, 21);
    const checksum = decoded.slice(21);
    const hash = sha256d(payload);
    if (hash[0] !== checksum[0] || hash[1] !== checksum[1] ||
        hash[2] !== checksum[2] || hash[3] !== checksum[3]) {
      return Buffer.alloc(20, 0);
    }
    return payload.slice(1);
  } catch (_e) {
    return Buffer.alloc(20, 0);
  }
}

function buildP2PKHScript(address) {
  const pubKeyHash = addressToPubkeyHash(address);
  return Buffer.concat([Buffer.from('76a914', 'hex'), pubKeyHash, Buffer.from('88ac', 'hex')]);
}

module.exports = {
  isValidAddress,
  isRoutableAddress,
  hasValidBase58Check,
  isP2PKHAddress,
  base58Decode,
  addressToPubkeyHash,
  buildP2PKHScript,
  ADDRESS_REGEX,
  P2PKH_ADDRESS_REGEX,
};
