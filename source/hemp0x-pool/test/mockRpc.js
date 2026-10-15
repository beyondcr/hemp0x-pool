const { createMockRpcServer } = require('./setup');

function rpcOk(result) {
  return { result, error: null, id: 'mock' };
}

function rpcErr(code, message) {
  return { result: null, error: { code, message }, id: 'mock' };
}

function utxoToRpc(utxo) {
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    address: utxo.address,
    account: '',
    scriptPubKey: '76a914c0ffee0000000000000000000000000000000c088ac',
    amount: utxo.amount,
    confirmations: utxo.confirmations,
    spendable: utxo.spendable,
    solvable: utxo.solvable,
  };
}

/**
 * Create a mock RPC server that serves synthetic UTXO fixtures.
 * @param {object[]} utxos - UTXO objects from fixtures.generateTestUtxos()
 * @returns {Promise<{server: http.Server, port: number}>}
 */
function createMockRpcWithUtxos(utxos) {
  return createMockRpcServer((data, res) => {
    const write = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    switch (data.method) {
      case 'listunspent': {
        let filtered = utxos;
        const p = data.params || [];
        if (p.length >= 1 && p[0] > 0) filtered = filtered.filter((u) => u.confirmations >= p[0]);
        if (p.length >= 2 && p[1] !== null && p[1] !== undefined) filtered = filtered.filter((u) => u.confirmations <= p[1]);
        if (p.length >= 3) {
          const addresses = Array.isArray(p[2]) ? p[2] : (p[2] ? [p[2]] : []);
          if (addresses.length > 0) filtered = filtered.filter((u) => addresses.includes(u.address));
        }
        write(rpcOk(filtered.map(utxoToRpc)));
        return;
      }
      case 'estimatesmartfee': {
        const target = (data.params && data.params[0]) || 6;
        write(rpcOk({ feerate: 0.00001000, blocks: target }));
        return;
      }
      case 'getwalletinfo': {
        const total = utxos.reduce((sum, u) => sum + u.amountSats, 0);
        write(rpcOk({
          walletname: 'hemp0xpool',
          balance: total / 100000000,
          txcount: utxos.length,
          keypoolsize: 1000,
          unlocked_until: 0,
        }));
        return;
      }
      case 'getblockchaininfo': {
        write(rpcOk({ blocks: 500000, bestblockhash: 'abc123' }));
        return;
      }
      case 'error_method': {
        write(rpcErr(-1, 'simulated RPC error'));
        return;
      }
      case 'http_error': {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      default: {
        write(rpcErr(-32601, `Method not found: ${data.method}`));
      }
    }
  });
}

module.exports = { createMockRpcWithUtxos, utxoToRpc };
