import { createServer } from 'node:http';

/**
 * Local-only ACK endpoint for integration tests. Production continues to
 * require HTTPS; this helper binds exclusively to 127.0.0.1.
 */
export async function startTestPrivacyRecoveryLedger() {
  const events = [];
  const byId = new Map();
  let sequence = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/events') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!event || typeof event.event_id !== 'string') {
        response.writeHead(400).end();
        return;
      }
      const prior = byId.get(event.event_id);
      if (prior && JSON.stringify(prior.event) !== JSON.stringify(event)) {
        response.writeHead(409).end();
        return;
      }
      let accepted = prior;
      if (!accepted) {
        accepted = { event, sequence: ++sequence };
        byId.set(event.event_id, accepted);
        events.push(event);
      }
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        accepted: true,
        event_id: event.event_id,
        sequence: accepted.sequence
      }));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_ledger_bind_failed');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    events,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    )
  };
}
