const http = require('node:http');

async function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const entry = { url: request.url, headers: request.headers, body: body ? JSON.parse(body) : undefined };
    requests.push(entry);
    await handler(entry, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}

function reply(response, content) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content } }] }));
}

module.exports = { startServer, reply };