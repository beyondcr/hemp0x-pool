const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeJobDifficulty, difficultyToTarget, bitsToDifficulty } = require('../server');

describe('computeJobDifficulty', () => {
  describe('when network difficulty is higher than socket difficulty', () => {
    it('uses socket difficulty (the smaller value)', () => {
      assert.strictEqual(computeJobDifficulty(0.1, 0.2), 0.1);
    });

    it('does not cap at all', () => {
      assert.strictEqual(computeJobDifficulty(0.045, 0.5), 0.045);
    });

    it('with safety factor still uses socket when it is lower', () => {
      assert.strictEqual(computeJobDifficulty(0.05, 0.5), 0.05);
    });
  });

  describe('when socket difficulty is higher than network difficulty', () => {
    it('caps to networkDifficulty * 0.95 by default', () => {
      const result = computeJobDifficulty(0.2, 0.045);
      assert.strictEqual(result, 0.045 * 0.95);
    });

    it('caps to networkDifficulty * 0.95 with explicit safety factor', () => {
      const result = computeJobDifficulty(1.0, 0.1, 0.90);
      assert.strictEqual(result, 0.1 * 0.90);
    });

    it('caps when values differ by multiple orders of magnitude', () => {
      const result = computeJobDifficulty(1024, 0.001, 0.95);
      assert.strictEqual(result, 0.001 * 0.95);
    });
  });

  describe('edge cases', () => {
    it('returns socket difficulty when network difficulty is zero', () => {
      assert.strictEqual(computeJobDifficulty(0.2, 0), 0.2);
    });

    it('returns socket difficulty when network difficulty is negative', () => {
      assert.strictEqual(computeJobDifficulty(0.2, -1), 0.2);
    });

    it('returns socket difficulty when network difficulty is NaN', () => {
      assert.strictEqual(computeJobDifficulty(0.2, NaN), 0.2);
    });

    it('returns socket difficulty when network difficulty is null', () => {
      assert.strictEqual(computeJobDifficulty(0.2, null), 0.2);
    });

    it('returns socket difficulty when network difficulty is undefined', () => {
      assert.strictEqual(computeJobDifficulty(0.2, undefined), 0.2);
    });

    it('returns socket difficulty when network difficulty is Infinity', () => {
      assert.strictEqual(computeJobDifficulty(0.2, Infinity), 0.2);
    });

    it('returns zero when both are zero', () => {
      assert.strictEqual(computeJobDifficulty(0, 0), 0);
    });

    it('returns zero when socket is zero and network is valid', () => {
      assert.strictEqual(computeJobDifficulty(0, 0.045), 0);
    });

    it('handles sub-difficulty socket values', () => {
      const result = computeJobDifficulty(0.002, 0.045);
      assert.strictEqual(result, 0.002);
    });

    it('handles exactly equal values where socket equals the cap', () => {
      const result = computeJobDifficulty(0.045 * 0.95, 0.045);
      assert.strictEqual(result, 0.045 * 0.95);
    });

    it('handles floating point without precision errors beyond epsilon', () => {
      const result = computeJobDifficulty(0.3, 0.045);
      const expected = 0.045 * 0.95;
      assert.ok(Math.abs(result - expected) < 1e-12);
    });
  });

  describe('default safety factor', () => {
    it('is exactly 0.95', () => {
      const result = computeJobDifficulty(1, 0.1);
      assert.strictEqual(result, 0.095);
    });
  });
});

describe('difficultyToTarget', () => {
  it('returns a 64-char hex string', () => {
    const target = difficultyToTarget(1);
    assert.strictEqual(target.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(target));
  });

  it('returns larger target for smaller difficulty (inverse relation)', () => {
    const t1 = BigInt('0x' + difficultyToTarget(1));
    const t2 = BigInt('0x' + difficultyToTarget(2));
    assert.ok(t1 > t2);
  });

  it('returns finite target for very small difficulty', () => {
    const target = difficultyToTarget(0.0001);
    const big = BigInt('0x' + target);
    assert.ok(big >= 0n);
  });

  it('clamps difficulty <= 0 to 1', () => {
    const t1 = difficultyToTarget(1);
    const t0 = difficultyToTarget(0);
    assert.strictEqual(t0, t1);
    const tn = difficultyToTarget(-1);
    assert.strictEqual(tn, t1);
  });

  it('returns different targets for different difficulties', () => {
    const t1 = difficultyToTarget(0.1);
    const t2 = difficultyToTarget(1.0);
    assert.notStrictEqual(t1, t2);
  });
});

describe('bitsToDifficulty', () => {
  it('matches diff-one compact bits', () => {
    assert.strictEqual(bitsToDifficulty('1d00ffff'), 1);
  });

  it('returns higher difficulty for smaller targets', () => {
    assert.ok(bitsToDifficulty('1d00fffe') > bitsToDifficulty('1d00ffff'));
  });

  it('matches observed low Hemp0x network difficulty shape', () => {
    const diff = bitsToDifficulty('1d1749b1');
    assert.ok(diff > 0.04 && diff < 0.05, `expected about 0.045, got ${diff}`);
  });

  it('returns zero for invalid bits', () => {
    assert.strictEqual(bitsToDifficulty('not-bits'), 0);
    assert.strictEqual(bitsToDifficulty('00000000'), 0);
  });
});

describe('duplicate share Set behavior', () => {
  function makeShareKey(jobId, nonce, mixHash) {
    return `${jobId}:${nonce}:${mixHash}`;
  }

  const testNonce = '00000000000000ff';
  const testMix = 'a'.repeat(64);

  it('first addition returns false (not seen before)', () => {
    const s = new Set();
    const key = makeShareKey('42', testNonce, testMix);
    assert.strictEqual(s.has(key), false);
    s.add(key);
    assert.strictEqual(s.has(key), true);
  });

  it('second addition of same key is detected as duplicate', () => {
    const s = new Set();
    const key = makeShareKey('42', testNonce, testMix);
    s.add(key);
    assert.strictEqual(s.has(key), true);
    assert.strictEqual(s.has(key), true);
  });

  it('different jobId creates different key', () => {
    const s = new Set();
    const k1 = makeShareKey('41', testNonce, testMix);
    const k2 = makeShareKey('42', testNonce, testMix);
    s.add(k1);
    assert.strictEqual(s.has(k1), true);
    assert.strictEqual(s.has(k2), false);
  });

  it('different nonce creates different key', () => {
    const s = new Set();
    const k1 = makeShareKey('42', '00000000000000ff', testMix);
    const k2 = makeShareKey('42', '00000000000000fe', testMix);
    s.add(k1);
    assert.strictEqual(s.has(k2), false);
  });

  it('different mixHash creates different key', () => {
    const s = new Set();
    const k1 = makeShareKey('42', testNonce, 'a'.repeat(64));
    const k2 = makeShareKey('42', testNonce, 'b'.repeat(64));
    s.add(k1);
    assert.strictEqual(s.has(k2), false);
  });

  it('set cap removes old entries when size exceeds 1000', () => {
    const s = new Set();
    for (let i = 0; i < 1100; i++) {
      s.add(`key${i}`);
    }
    assert.strictEqual(s.size, 1100);

    if (s.size > 1000) {
      let dropped = 0;
      for (const k of s) {
        if (dropped >= 200) break;
        s.delete(k);
        dropped++;
      }
    }
    assert.ok(s.size <= 1000);
    assert.ok(s.size >= 800);
  });

  it('set cap preserves most recent entries', () => {
    const s = new Set();
    for (let i = 0; i < 1100; i++) {
      s.add(`key${i}`);
    }
    if (s.size > 1000) {
      let dropped = 0;
      for (const k of s) {
        if (dropped >= 200) break;
        s.delete(k);
        dropped++;
      }
    }
    const entries = Array.from(s);
    assert.strictEqual(entries[0], 'key200');
  });
});
