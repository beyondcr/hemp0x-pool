const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shouldBroadcastTemplateChange } = require('../server');

function makeTemplate(opts = {}) {
  const rawTxs = opts.transactions || [];
  const txs = rawTxs.map((txObj, i) => ({
    txid: (typeof txObj === 'object' && txObj.txid) ? txObj.txid : `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${String(i).padStart(2, '0')}`,
    hash: (typeof txObj === 'object' && txObj.hash) ? txObj.hash : `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${String(i).padStart(2, '0')}`,
    data: (typeof txObj === 'object' && txObj.data) ? txObj.data : '00',
  }));
  return {
    previousblockhash: opts.previousblockhash || '000000000000000000000000000000000000000000000000000000000000000a',
    curtime: opts.curtime || 1000,
    bits: opts.bits || '1d00ffff',
    target: opts.target || '00000000ffff0000000000000000000000000000000000000000000000000000',
    transactions: txs,
    height: opts.height || 100,
  };
}

describe('shouldBroadcastTemplateChange', () => {
  it('first template returns true', () => {
    const next = makeTemplate();
    assert.equal(shouldBroadcastTemplateChange(null, next), true);
  });

  it('identical template returns false', () => {
    const curr = makeTemplate();
    const next = makeTemplate();
    assert.equal(shouldBroadcastTemplateChange(curr, next), false);
  });

  it('curtime-only change returns false', () => {
    const curr = makeTemplate({ curtime: 1000 });
    const next = makeTemplate({ curtime: 2000 });
    assert.equal(shouldBroadcastTemplateChange(curr, next), false);
  });

  it('previousblockhash change returns true', () => {
    const curr = makeTemplate({ previousblockhash: 'aaa' });
    const next = makeTemplate({ previousblockhash: 'bbb' });
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });

  it('bits change returns true', () => {
    const curr = makeTemplate({ bits: '1d00ffff' });
    const next = makeTemplate({ bits: '1d00fffe' });
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });

  it('target change returns true', () => {
    const curr = makeTemplate({ target: '00000000ffff0000000000000000000000000000000000000000000000000000' });
    const next = makeTemplate({ target: '00000000ffff0000000000000000000000000000000000000000000000000001' });
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });

  it('transaction count change returns true', () => {
    const curr = makeTemplate({ transactions: [{ txid: 'tx1' }, { txid: 'tx2' }] });
    const next = makeTemplate({ transactions: [{ txid: 'tx1' }, { txid: 'tx2' }, { txid: 'tx3' }] });
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });

  it('transaction hash change returns true', () => {
    const curr = makeTemplate({ transactions: [{ txid: 'tx1' }, { txid: 'tx2' }] });
    const next = makeTemplate({ transactions: [{ txid: 'tx1' }, { txid: 'tx3' }] });
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });

  it('transaction order change returns true', () => {
    const curr = makeTemplate({ transactions: [{ txid: 'tx1' }, { txid: 'tx2' }] });
    const next = makeTemplate({ transactions: [{ txid: 'tx2' }, { txid: 'tx1' }] });
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });

  it('same transactions with different curtime returns false', () => {
    const curr = makeTemplate({ curtime: 1000, transactions: [{ txid: 'tx1' }] });
    const next = makeTemplate({ curtime: 5000, transactions: [{ txid: 'tx1' }] });
    assert.equal(shouldBroadcastTemplateChange(curr, next), false);
  });

  it('missing transactions array treated as empty', () => {
    const curr = makeTemplate();
    delete curr.transactions;
    const next = makeTemplate();
    next.transactions = [{ txid: 'tx1' }];
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });

  it('current template missing transactions treated as empty', () => {
    const curr = makeTemplate({ transactions: [{ txid: 'tx1' }] });
    const next = makeTemplate();
    delete next.transactions;
    assert.equal(shouldBroadcastTemplateChange(curr, next), true);
  });
});
