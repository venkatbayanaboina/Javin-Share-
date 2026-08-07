import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import { store } from '../../src/state/store.js';
import { createMockIo } from '../helpers/mock-io.mjs';
import {
  getGraceState,
  startGraceRedirect,
  extendGraceRedirect,
  clearGraceRedirect,
} from '../../src/services/grace-redirect.service.js';

function createTestSession(id = 'sess-test') {
  return {
    id,
    peers: new Map([
      ['host1', { peerId: 'host1', role: 'host', socketId: 'host-sock', isDisconnected: false }],
      [
        'client1',
        { peerId: 'client1', role: 'client', socketId: 'client-sock', isDisconnected: false },
      ],
    ]),
    graceRedirectTimer: null,
    graceRedirectEndMs: null,
    graceRedirectStartedAt: null,
  };
}

describe('grace-redirect.service', () => {
  beforeEach(() => {
    store.sessions.clear();
  });

  it('getGraceState returns null when grace is inactive', () => {
    const session = createTestSession();
    assert.equal(getGraceState(session), null);
  });

  it('startGraceRedirect sets graceRedirectEndMs from config', () => {
    const session = createTestSession();
    store.sessions.set(session.id, session);
    const io = createMockIo();
    const before = Date.now();
    startGraceRedirect(session, io);
    assert.ok(session.graceRedirectEndMs >= before + config.gracePeriodMs - 50);
    assert.ok(session.graceRedirectEndMs <= before + config.gracePeriodMs + 50);
    const state = getGraceState(session);
    assert.ok(state?.active);
    assert.equal(state.sessionId, session.id);
    clearGraceRedirect(session, io, { notifyHost: false });
  });

  it('extendGraceRedirect increases remaining time within cap', () => {
    const session = createTestSession();
    store.sessions.set(session.id, session);
    const io = createMockIo();
    startGraceRedirect(session, io);
    const endBefore = session.graceRedirectEndMs;
    const result = extendGraceRedirect(session, io);
    assert.equal(result.ok, true);
    assert.ok(session.graceRedirectEndMs >= endBefore);
    clearGraceRedirect(session, io, { notifyHost: false });
  });

  it('clearGraceRedirect removes timer state', () => {
    const session = createTestSession();
    store.sessions.set(session.id, session);
    const io = createMockIo();
    startGraceRedirect(session, io);
    clearGraceRedirect(session, io, { notifyHost: false });
    assert.equal(session.graceRedirectEndMs, null);
    assert.equal(session.graceRedirectTimer, null);
    assert.equal(getGraceState(session), null);
  });
});
