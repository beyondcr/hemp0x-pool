const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isAcceptedKawpowShare } = require('../server');

describe('isAcceptedKawpowShare', () => {
  describe('accepted shares', () => {
    it('accepts when both result and meets_target are boolean true', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true, meets_target: true }), true);
    });

    it('accepts when both result and meets_target are string "true"', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: 'true', meets_target: 'true' }), true);
    });

    it('accepts when result is boolean true and meets_target is string "true"', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true, meets_target: 'true' }), true);
    });

    it('accepts when result is string "true" and meets_target is boolean true', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: 'true', meets_target: true }), true);
    });
  });

  describe('rejected shares - result false', () => {
    it('rejects when result is false (boolean)', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: false, meets_target: true }), false);
    });

    it('rejects when result is "false" (string)', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: 'false', meets_target: true }), false);
    });

    it('rejects when result is false and meets_target is false', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: false, meets_target: false }), false);
    });

    it('rejects when result is missing entirely', () => {
      assert.strictEqual(isAcceptedKawpowShare({ meets_target: true }), false);
    });

    it('rejects when result is a truthy non-boolean that is not "true"', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: 1, meets_target: true }), false);
    });
  });

  describe('rejected shares - meets_target false or missing', () => {
    it('rejects when meets_target is false (boolean)', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true, meets_target: false }), false);
    });

    it('rejects when meets_target is "false" (string)', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true, meets_target: 'false' }), false);
    });

    it('rejects when meets_target is missing entirely (fails closed)', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true }), false);
    });

    it('rejects when meets_target is undefined', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true, meets_target: undefined }), false);
    });

    it('rejects when meets_target is null', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true, meets_target: null }), false);
    });

    it('rejects when meets_target is an empty string', () => {
      assert.strictEqual(isAcceptedKawpowShare({ result: true, meets_target: '' }), false);
    });
  });

  describe('rejected shares - falsy input', () => {
    it('rejects null', () => {
      assert.strictEqual(isAcceptedKawpowShare(null), false);
    });

    it('rejects undefined', () => {
      assert.strictEqual(isAcceptedKawpowShare(undefined), false);
    });

    it('rejects an empty object', () => {
      assert.strictEqual(isAcceptedKawpowShare({}), false);
    });
  });
});
