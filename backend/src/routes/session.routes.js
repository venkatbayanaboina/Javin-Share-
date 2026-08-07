import { Router } from 'express';
import QRCode from 'qrcode';
import { logger } from '../logger.js';
import { store } from '../state/store.js';
import { peersOnPage, PeerPage } from '../services/peer-page.service.js';
import { getGraceState } from '../services/grace-redirect.service.js';
import {
  buildPinUrl,
  buildLocalUrl,
  createSession,
  invalidateSessionById,
} from '../services/session.service.js';
import { getAllDeviceNames, getDeviceName } from '../services/device-names.service.js';
import { assertHostPeer } from '../services/peer-auth.service.js';
import {
  clearPinFailures,
  getPinRateLimitStatus,
  recordPinFailure,
} from '../services/pin-rate-limit.service.js';
import { getClientIp, isLocalRequest } from '../utils/request.js';
import { isSafeId } from '../utils/ids.js';
import { gracefulShutdown } from '../shutdown.js';
import { getTransferCoordinator } from '../services/transfer/coordinator.service.js';

function pinRateLimitedResponse(res, status) {
  const retryAfterSec = Math.ceil(status.retryAfterMs / 1000);
  res.setHeader('Retry-After', String(retryAfterSec));
  return res.status(429).json({
    error: 'Too many PIN attempts. Try again later.',
    retryAfterSeconds: retryAfterSec,
  });
}

function verifyPinHandler(req, res, { sessionIdRequired }) {
  const ip = getClientIp(req);
  const { sessionId, pin } = req.body || {};

  if (sessionIdRequired && !isSafeId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }

  const rateKey = sessionIdRequired ? sessionId : null;
  const rateStatus = getPinRateLimitStatus(ip, rateKey);
  if (rateStatus.blocked) {
    return pinRateLimitedResponse(res, rateStatus);
  }

  if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    recordPinFailure(ip, rateKey);
    return res.status(400).json({ error: 'Invalid PIN format' });
  }

  if (sessionIdRequired) {
    const session = store.sessions.get(sessionId);
    if (!session) {
      recordPinFailure(ip, rateKey);
      return res.status(404).json({ error: 'Session not found or expired' });
    }
    if (Date.now() > session.pinExpiry) {
      return res.status(400).json({ error: 'PIN has expired' });
    }
    if (session.pin === pin) {
      clearPinFailures(ip, rateKey);
      return res.json({ success: true, sessionId });
    }
    recordPinFailure(ip, rateKey);
    return res.status(400).json({ error: 'Invalid PIN' });
  }

  for (const [, session] of store.sessions.entries()) {
    if (session.pin === pin && Date.now() <= session.pinExpiry) {
      clearPinFailures(ip, null);
      return res.json({ success: true, sessionId: session.id });
    }
  }

  recordPinFailure(ip, null);
  return res.status(400).json({ error: 'Invalid PIN or session expired' });
}

export function createSessionRouter(deps) {
  const router = Router();

  router.post('/api/shutdown', (req, res) => {
    const { force, sessionId, peerId } = req.body || {};

    if (!force) {
      logger.info('Shutdown request rejected - not forced');
      return res.status(403).json({ error: 'Shutdown must be explicitly requested' });
    }

    if (!isSafeId(sessionId) || !isSafeId(peerId)) {
      return res.status(400).json({ error: 'sessionId and peerId are required' });
    }

    if (!assertHostPeer(sessionId, peerId)) {
      return res.status(403).json({ error: 'Only the session host may shut down the server' });
    }

    res.json({ ok: true, message: 'Session ended successfully' });
    logger.info(`Host ${peerId} requested end session for ${sessionId}`);
    invalidateSessionById(deps.io, sessionId);

    // Gracefully shutdown the server process after a short delay so the response finishes sending
    setTimeout(() => {
      logger.info('Host requested server shutdown. Shutting down server process gracefully...');
      gracefulShutdown(deps.server, deps.io);
    }, 1000);
  });

  router.get('/get-current-session', async (req, res) => {
    const requestedSessionId = req.query.session;

    if (requestedSessionId) {
      const requestedSession = store.sessions.get(requestedSessionId);
      if (requestedSession && Date.now() <= requestedSession.pinExpiry) {
        const pinUrl = buildPinUrl(store.localIP);
        const qrUrl = buildPinUrl(store.localIP);
        const qrDataUrl = await QRCode.toDataURL(qrUrl);
        const localUrl = buildLocalUrl();
        res.json({
          sessionId: requestedSession.id,
          pin: requestedSession.pin,
          url: pinUrl,
          localUrl,
          qrDataUrl,
          pinExpiry: requestedSession.pinExpiry,
        });
        return;
      }
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }

    const forceNew = req.query.forceNew === '1';
    let session = store.currentHostSessionId
      ? store.sessions.get(store.currentHostSessionId)
      : null;
    const clientsConnected = session
      ? Array.from(session.peers.values()).some((p) => p.role === 'client')
      : false;
    const refreshRequested = req.query.refresh === '1';

    // Single active session enforcement:
    // If a session is already active (exists in store and has not expired), we reuse it.
    // We ignore forceNew if there is an active session, to prevent duplicate sessions.
    if (session && Date.now() <= session.pinExpiry) {
      const pinUrl = buildPinUrl(store.localIP);
      const qrUrl = buildPinUrl(store.localIP);
      const qrDataUrl = await QRCode.toDataURL(qrUrl);
      const localUrl = buildLocalUrl();
      res.json({
        sessionId: session.id,
        pin: session.pin,
        url: pinUrl,
        localUrl,
        qrDataUrl,
        pinExpiry: session.pinExpiry,
      });
      return;
    }

    // No active session exists or it has expired - create a new one
    // Only allow local request to create a new session. If it is non-local (external client device), return 404.
    if (!isLocalRequest(req)) {
      res.status(404).json({ error: 'No active session found' });
      return;
    }

    try {
      const newSessionData = await createSession(deps.io, forceNew);
      res.json(newSessionData);
    } catch (err) {
      logger.error('Error creating session:', err);
      res.status(500).json({ error: 'Could not create session.' });
    }
  });

  router.get('/api/benchmark/register-session/:sessionId/:fileId', (req, res) => {
    const { sessionId, fileId } = req.params;
    const session = store.sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const expectedReceivers = new Set();
    const receiversCount = Number(req.query.receivers || 1);

    for (let i = 1; i <= receiversCount; i++) {
      const peerId = `receiver-bench-peer-${i}`;
      expectedReceivers.add(peerId);
      session.peers.set(peerId, {
        peerId,
        socketId: `mock-socket-id-${i}`,
        role: 'client'
      });
    }

    const fileMetadata = { name: 'benchmark.bin', size: Number(req.query.size || 0) };
    const coordinator = getTransferCoordinator();
    coordinator.initializeStreamSession(fileId, fileMetadata, expectedReceivers, 'mock-sender-socket-id', session);

    res.json({ success: true });
  });

  router.get('/api/session-details/:sessionId', (req, res) => {
    const session = store.sessions.get(req.params.sessionId);
    if (session) {
      const activePeers = Array.from(session.peers.values()).filter((p) => !p.isDisconnected);
      res.json({
        pinExpiry: session.pinExpiry,
        peerCount: activePeers.length,
        grace: getGraceState(session),
      });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  router.get('/api/session-history/:sessionId', (req, res) => {
    const history = store.transferHistory.get(req.params.sessionId) || [];
    res.json(history);
  });

  router.get('/recent/:userId', (req, res) => {
    const userId = req.params.userId;
    const history = store.recentTransfers.filter(
      (t) => t.senderId === userId || t.receiverId === userId,
    );
    res.json(history);
  });

  router.get('/api/get-pin-expiry', (_req, res) => {
    let latestSession = null;
    let latestTime = 0;

    for (const [, session] of store.sessions.entries()) {
      if (session.pinExpiry > latestTime) {
        latestTime = session.pinExpiry;
        latestSession = session;
      }
    }

    if (latestSession && Date.now() <= latestSession.pinExpiry) {
      res.json({
        pinExpiry: latestSession.pinExpiry,
        sessionId: latestSession.id,
      });
    } else {
      res.status(404).json({ error: 'No active session found' });
    }
  });

  router.post('/api/find-session-by-pin', (req, res) => {
    verifyPinHandler(req, res, { sessionIdRequired: false });
  });

  router.get('/api/device-name/:peerId', (req, res) => {
    const { peerId } = req.params;
    const deviceName = getDeviceName(peerId);
    if (deviceName) {
      res.json({ success: true, deviceName });
    } else {
      res.status(404).json({ error: 'Device name not found' });
    }
  });

  router.get('/api/device-names', (_req, res) => {
    res.json({ success: true, deviceNames: getAllDeviceNames() });
  });

  router.post('/api/verify-pin', (req, res) => {
    verifyPinHandler(req, res, { sessionIdRequired: true });
  });

  return router;
}
