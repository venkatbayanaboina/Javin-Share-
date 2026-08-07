import assert from 'assert';
import { test, describe } from 'node:test';
import { startMdnsResponder } from '../../src/services/mdns.service.js';

describe('mDNS Service Tests', () => {
  test('returns null for non-local custom hosts', () => {
    const server = startMdnsResponder('example.com', '192.168.1.100');
    assert.strictEqual(server, null);
  });

  test('returns null if no custom host provided', () => {
    const server = startMdnsResponder('', '192.168.1.100');
    assert.strictEqual(server, null);
  });

  test('initializes and responds to A record queries matching customHost', () => {
    const customHost = 'javin.share.abcd.local';
    const localIP = '192.168.1.200';

    const server = startMdnsResponder(customHost, localIP);
    assert.ok(server);

    try {
      let responseSent = null;
      server.respond = (response) => {
        responseSent = response;
      };

      // 1. Simulate query for the correct host (with trailing dot)
      server.emit('query', {
        questions: [{ name: 'javin.share.abcd.local.', type: 'A' }],
      });

      assert.ok(responseSent);
      assert.strictEqual(responseSent.answers[0].name, 'javin.share.abcd.local.');
      assert.strictEqual(responseSent.answers[0].type, 'A');
      assert.strictEqual(responseSent.answers[0].data, localIP);

      // 2. Simulate query for correct host (without trailing dot)
      responseSent = null;
      server.emit('query', {
        questions: [{ name: 'javin.share.abcd.local', type: 'A' }],
      });

      assert.ok(responseSent);
      assert.strictEqual(responseSent.answers[0].name, 'javin.share.abcd.local');
      assert.strictEqual(responseSent.answers[0].type, 'A');
      assert.strictEqual(responseSent.answers[0].data, localIP);

      // 3. Simulate query for different query type (e.g. AAAA)
      responseSent = null;
      server.emit('query', {
        questions: [{ name: 'javin.share.abcd.local.', type: 'AAAA' }],
      });
      assert.strictEqual(responseSent, null);

      // 4. Simulate query for a completely different host
      responseSent = null;
      server.emit('query', {
        questions: [{ name: 'other.local.', type: 'A' }],
      });
      assert.strictEqual(responseSent, null);
    } finally {
      server.destroy();
    }
  });
});
