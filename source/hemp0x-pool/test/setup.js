const http = require('http');

/**
 * Create a local HTTP mock RPC server for tests.
 * @param {function} handler - (requestData, response) => void
 * @returns {Promise<{server: http.Server, port: number}>}
 */
function createMockRpcServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          handler(data, res);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON', id: null }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/**
 * Build a handler that maps method names to fixed responses.
 * @param {Record<string, any>} responses
 * @returns {function}
 */
function defaultRpcHandler(responses) {
  return (data, res) => {
    const response = responses[data.method];
    if (response !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ result: response, error: null, id: data.id })
      );
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          result: null,
          error: { code: -32601, message: `Method not found: ${data.method}` },
          id: data.id,
        })
      );
    }
  };
}

module.exports = { createMockRpcServer, defaultRpcHandler };
