/**
 * SSE Broadcaster — manages connected clients and broadcasts events.
 */
const clients = [];

function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  // Keep alive
  const keepAlive = setInterval(() => res.write(':ping\n\n'), 25000);
  const client = { res, keepAlive };
  clients.push(client);
  res.req.on('close', () => removeClient(client));
  return client;
}

function removeClient(client) {
  clearInterval(client.keepAlive);
  const idx = clients.indexOf(client);
  if (idx !== -1) clients.splice(idx, 1);
}

function send(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (let i = clients.length - 1; i >= 0; i--) {
    try { send(clients[i], event, data); }
    catch { removeClient(clients[i]); }
  }
}

module.exports = { addClient, send, broadcast };
