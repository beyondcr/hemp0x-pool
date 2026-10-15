const SATS_PER_HEMP = 100_000_000;

/**
 * Convert a HEMP amount (decimal string or number) to satoshis as a BigInt.
 * Rejects floating-point inputs that would lose precision.
 */
function hempToSats(hemp) {
  if (typeof hemp === 'bigint') return hemp;
  const str = String(hemp);
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid HEMP amount: ${hemp}`);
  }
  const [whole, frac = ''] = str.split('.');
  if (frac.length > 8) {
    throw new Error(`HEMP amount has more than 8 decimal places: ${hemp}`);
  }
  const paddedFrac = frac.padEnd(8, '0').slice(0, 8);
  const sign = whole.startsWith('-') ? '-' : '';
  const absWhole = whole.replace(/^-/, '');
  return BigInt(`${sign}${absWhole}${paddedFrac}`);
}

/**
 * Convert a HEMP amount (decimal string or number) to satoshis as a Number.
 * Throws if the result exceeds Number.MAX_SAFE_INTEGER.
 */
function hempToSatsNumber(hemp) {
  const sats = hempToSats(hemp);
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`HEMP amount exceeds safe integer range: ${hemp}`);
  }
  return Number(sats);
}

/**
 * Convert integer satoshis to a decimal HEMP display string.
 * Accepts BigInt or Number. No floating-point math is used.
 */
function satsToHemp(sats) {
  const big = typeof sats === 'bigint' ? sats : BigInt(sats);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;
  const s = abs.toString().padStart(9, '0');
  const whole = s.slice(0, -8) || '0';
  const frac = s.slice(-8).replace(/0+$/, '');
  return `${sign}${whole}${frac ? '.' + frac : ''}`;
}

/**
 * Format integer satoshis as a fixed 8-decimal display string.
 */
function satsToDisplay(sats) {
  const big = typeof sats === 'bigint' ? sats : BigInt(sats);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;
  const s = abs.toString().padStart(9, '0');
  const whole = s.slice(0, -8) || '0';
  const frac = s.slice(-8);
  return `${sign}${whole}.${frac}`;
}

module.exports = {
  SATS_PER_HEMP,
  hempToSats,
  hempToSatsNumber,
  satsToHemp,
  satsToDisplay,
};
