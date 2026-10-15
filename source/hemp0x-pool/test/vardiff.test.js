const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeVardiffAdjustment, updateHashrate } = require('../server');

const DEFAULT_VARDIFF = Object.freeze({
  minDiff: 0.2,
  maxDiff: 1024,
  targetTime: 15,
  retargetTime: 30,
  variance: 0.4,
});

function makeShareHistory(diffsOverTimeSeconds) {
  const now = Date.now();
  return diffsOverTimeSeconds.map(([secsAgo, diff]) => ({
    time: now - secsAgo * 1000,
    diff,
  }));
}

describe('computeVardiffAdjustment', () => {
  describe('guard conditions', () => {
    it('returns unchanged when shareHistory has fewer than 5 entries', () => {
      const history = makeShareHistory([[1, 1], [2, 1], [3, 1], [4, 1]]);
      const result = computeVardiffAdjustment(1, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, false);
      assert.equal(result.newDiff, 1);
    });

    it('returns unchanged when retargetDeadline has not yet elapsed', () => {
      const futureDeadline = Date.now() + 60000;
      const history = makeShareHistory([
        [50, 1], [40, 1], [30, 1], [20, 1], [10, 1], [5, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, DEFAULT_VARDIFF, futureDeadline);
      assert.equal(result.changed, false);
      assert.equal(result.newDiff, 1);
    });

    it('returns unchanged for exactly 5 shares within retarget window', () => {
      const history = makeShareHistory([
        [50, 1], [40, 1], [30, 1], [20, 1], [10, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, false);
    });
  });

  describe('difficulty increase', () => {
    it('raises difficulty when shares arrive too fast', () => {
      const history = makeShareHistory([
        [50, 1], [49, 1], [48, 1], [47, 1], [46, 1],
        [45, 1], [44, 1], [43, 1], [42, 1], [41, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, true);
      assert.ok(result.newDiff > 1, `Expected increased diff, got ${result.newDiff}`);
      assert.equal(result.newDiff, 1.5);
    });

    it('raises difficulty cumulatively when shares are extremely fast', () => {
      const history = makeShareHistory([
        [50, 4], [49.5, 4], [49, 4], [48.5, 4], [48, 4],
        [47.5, 4], [47, 4], [46.5, 4], [46, 4], [45.5, 4],
      ]);
      const result = computeVardiffAdjustment(4, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, true);
      assert.equal(result.newDiff, 6);
    });
  });

  describe('difficulty decrease', () => {
    it('lowers difficulty when shares arrive too slowly', () => {
      const history = makeShareHistory([
        [270, 8], [240, 8], [210, 8], [180, 8], [150, 8],
        [120, 8], [90, 8], [60, 8], [30, 8], [0, 8],
      ]);
      const result = computeVardiffAdjustment(8, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, true);
      assert.ok(result.newDiff < 8, `Expected decreased diff, got ${result.newDiff}`);
    });

    it('lowers difficulty cumulatively', () => {
      const history = makeShareHistory([
        [450, 4], [420, 4], [390, 4], [360, 4], [330, 4],
        [300, 4], [270, 4], [240, 4], [210, 4], [180, 4],
      ]);
      const result = computeVardiffAdjustment(4, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, true);
      assert.ok(result.newDiff < 4, `Expected decreased diff, got ${result.newDiff}`);
    });
  });

  describe('stable zone', () => {
    it('does not change when avgTime is within variance band', () => {
      const history = makeShareHistory([
        [150, 1], [135, 1], [120, 1], [105, 1], [90, 1],
        [75, 1], [60, 1], [45, 1], [30, 1], [15, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, false);
      assert.equal(result.newDiff, 1);
    });

    it('remains stable near targetTime boundary', () => {
      const history = makeShareHistory([
        [135, 2], [120, 2], [105, 2], [90, 2], [75, 2],
        [60, 2], [45, 2], [30, 2], [15, 2], [0, 2],
      ]);
      const result = computeVardiffAdjustment(2, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, false);
    });
  });

  describe('bounds clamping', () => {
    it('clamps to minDiff when decrease would go below floor', () => {
      const history = makeShareHistory([
        [270, 0.25], [240, 0.25], [210, 0.25], [180, 0.25], [150, 0.25],
        [120, 0.25], [90, 0.25], [60, 0.25], [30, 0.25], [0, 0.25],
      ]);
      const result = computeVardiffAdjustment(0.25, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, true);
      assert.equal(result.newDiff, 0.2);
    });

    it('clamps to maxDiff when increase would go above ceiling', () => {
      const tightConfig = { ...DEFAULT_VARDIFF, maxDiff: 1024 };
      const history = makeShareHistory([
        [50, 800], [49, 800], [48, 800], [47, 800], [46, 800],
        [45, 800], [44, 800], [43, 800], [42, 800], [41, 800],
      ]);
      const result = computeVardiffAdjustment(800, history, tightConfig, 0);
      assert.equal(result.changed, true);
      assert.equal(result.newDiff, 1024);
    });

    it('does not exceed maxDiff even with very fast shares at ceiling', () => {
      const tightConfig = { ...DEFAULT_VARDIFF, maxDiff: 100 };
      const history = makeShareHistory([
        [50, 100], [49, 100], [48, 100], [47, 100], [46, 100],
        [45, 100], [44, 100], [43, 100], [42, 100], [41, 100],
      ]);
      const result = computeVardiffAdjustment(100, history, tightConfig, 0);
      assert.equal(result.changed, false);
      assert.ok(result.newDiff <= 100);
    });

    it('does not go below minDiff even with very slow shares at floor', () => {
      const tightConfig = { ...DEFAULT_VARDIFF, minDiff: 0.3 };
      const history = makeShareHistory([
        [500, 0.3], [480, 0.3], [460, 0.3], [440, 0.3], [420, 0.3],
        [400, 0.3], [380, 0.3], [360, 0.3], [340, 0.3], [320, 0.3],
      ]);
      const result = computeVardiffAdjustment(0.3, history, tightConfig, 0);
      assert.equal(result.changed, false);
      assert.ok(result.newDiff >= 0.3);
    });
  });

  describe('variance field is honored', () => {
    it('uses a tight variance to trigger change near targetTime', () => {
      const tightVariance = { ...DEFAULT_VARDIFF, variance: 0.1 };
      const history = makeShareHistory([
        [120, 1], [108, 1], [96, 1], [84, 1], [72, 1],
        [60, 1], [48, 1], [36, 1], [24, 1], [12, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, tightVariance, 0);
      assert.equal(result.changed, true);
    });

    it('uses a wide variance to prevent change near targetTime', () => {
      const wideVariance = { ...DEFAULT_VARDIFF, variance: 0.8 };
      const history = makeShareHistory([
        [120, 1], [108, 1], [96, 1], [84, 1], [72, 1],
        [60, 1], [48, 1], [36, 1], [24, 1], [12, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, wideVariance, 0);
      assert.equal(result.changed, false);
    });
  });

  describe('float safety', () => {
    it('handles sub-1 difficulty values without NaN', () => {
      const history = makeShareHistory([
        [50, 0.5], [49, 0.5], [48, 0.5], [47, 0.5], [46, 0.5],
        [45, 0.5], [44, 0.5], [43, 0.5], [42, 0.5], [41, 0.5],
      ]);
      const result = computeVardiffAdjustment(0.5, history, DEFAULT_VARDIFF, 0);
      assert.ok(!Number.isNaN(result.newDiff), 'newDiff must not be NaN');
      assert.ok(result.newDiff > 0, 'newDiff must be positive');
    });

    it('handles very large difficulty without overflow', () => {
      const largeConfig = { ...DEFAULT_VARDIFF, maxDiff: 1000000 };
      const history = makeShareHistory([
        [270, 50000], [240, 50000], [210, 50000], [180, 50000], [150, 50000],
        [120, 50000], [90, 50000], [60, 50000], [30, 50000], [0, 50000],
      ]);
      const result = computeVardiffAdjustment(50000, history, largeConfig, 0);
      assert.ok(Number.isFinite(result.newDiff), 'newDiff must be finite');
      assert.equal(result.changed, true);
      assert.ok(result.newDiff < 50000);
    });
  });

  describe('invalid direct config input', () => {
    it('does not return NaN when called with targetTime 0', () => {
      const badConfig = { ...DEFAULT_VARDIFF, targetTime: 0 };
      const history = makeShareHistory([
        [50, 1], [40, 1], [30, 1], [20, 1], [10, 1], [5, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, badConfig, 0);
      assert.ok(!Number.isNaN(result.newDiff));
    });
  });

  describe('only last 10 shares are used', () => {
    it('ignores shares beyond the 10 most recent', () => {
      const history = makeShareHistory([
        [1000, 1], [990, 1], [980, 1], [970, 1], [960, 1],
        [950, 1], [940, 1], [930, 1], [920, 1], [910, 1],
        [50, 1], [49, 1], [48, 1], [47, 1], [46, 1],
        [45, 1], [44, 1], [43, 1], [42, 1], [41, 1],
      ]);
      const result = computeVardiffAdjustment(1, history, DEFAULT_VARDIFF, 0);
      assert.equal(result.changed, true);
      assert.equal(result.newDiff, 1.5);
    });
  });
});

describe('updateHashrate', () => {
  it('smooths the first-share startup estimate', () => {
    const now = Date.now();
    const worker = {
      shareHistory: [{ diff: 0.2, time: now }],
      hashrate: 0,
    };

    updateHashrate(worker);

    assert.ok(worker.hashrate > 50, `expected nonzero warmup hashrate, got ${worker.hashrate}`);
    assert.ok(worker.hashrate < 60, `first share should not report an 850+ MH/s burst, got ${worker.hashrate}`);
  });

  it('uses elapsed window time after warmup', () => {
    const now = Date.now();
    const worker = {
      shareHistory: [
        { diff: 0.2, time: now - 30000 },
        { diff: 0.2, time: now },
      ],
      hashrate: 0,
    };

    updateHashrate(worker);

    const expected = (0.4 * Math.pow(2, 32)) / 30 / 1000000;
    assert.ok(Math.abs(worker.hashrate - expected) < 0.1);
  });
});
