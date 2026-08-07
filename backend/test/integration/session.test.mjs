import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { store } from '../../src/state/store.js';
import { createSession } from '../../src/services/session.service.js';
import { createTestApp } from '../helpers/test-app.mjs';
import { resetStoreForTests } from '../helpers/reset-store.mjs';
import { resetPinRateLimitForTests } from '../../src/services/pin-rate-limit.service.js';

describe('session API', () => {
  let app;
  let io;

  beforeEach(() => {
    resetStoreForTests();
    resetPinRateLimitForTests();
    ({ app, io } = createTestApp());
  });

  it('verifies PIN for an active session', async () => {
    const { sessionId, pin } = await createSession(io, true);

    const res = await request(app).post('/api/verify-pin').send({ sessionId, pin });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.sessionId, sessionId);
  });

  it('rejects invalid PIN', async () => {
    const { sessionId } = await createSession(io, true);

    const res = await request(app).post('/api/verify-pin').send({ sessionId, pin: '000000' });

    assert.equal(res.status, 400);
  });

  it('allows only host to request shutdown', async () => {
    const { sessionId } = await createSession(io, true);
    const session = store.sessions.get(sessionId);

    session.peers.set('hostPeer', {
      peerId: 'hostPeer',
      role: 'host',
      socketId: 'sock-host',
      isDisconnected: false,
    });
    session.peers.set('clientPeer', {
      peerId: 'clientPeer',
      role: 'client',
      socketId: 'sock-client',
      isDisconnected: false,
    });

    const denied = await request(app)
      .post('/api/shutdown')
      .send({ force: true, sessionId, peerId: 'clientPeer' });
    assert.equal(denied.status, 403);

    const allowed = await request(app)
      .post('/api/shutdown')
      .send({ force: true, sessionId, peerId: 'hostPeer' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.ok, true);
  });

  it('redirects legacy main.html to session.html', async () => {
    const res = await request(app).get('/main.html');
    assert.equal(res.status, 301);
    assert.match(res.headers.location, /session\.html/);
  });

  describe('Host / Loopback Access Restrictions', () => {
    it('allows loopback host to fetch/create session', async () => {
      const res = await request(app).get('/get-current-session');
      assert.equal(res.status, 200);
      assert.ok(res.body.sessionId);
    });

    it('denies external client from creating session (returns 404)', async () => {
      const res = await request(app)
        .get('/get-current-session')
        .set('x-forwarded-for', '192.168.1.100');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'No active session found');
    });

    it('allows external client to get active session details', async () => {
      const { sessionId } = await createSession(io, true);

      const res = await request(app)
        .get('/get-current-session')
        .set('x-forwarded-for', '192.168.1.100');
      assert.equal(res.status, 200);
      assert.equal(res.body.sessionId, sessionId);
    });

    it('allows loopback host to access host.html', async () => {
      const res = await request(app).get('/host.html');
      assert.equal(res.status, 200);
    });

    it('redirects external client from host.html to join-pin.html', async () => {
      const res = await request(app).get('/host.html').set('x-forwarded-for', '192.168.1.100');
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /join-pin\.html/);
    });
  });
});
