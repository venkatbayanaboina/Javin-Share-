import { config } from '../config.js';
import { logger } from '../logger.js';
import { store } from '../state/store.js';
import { getDeviceName, setDeviceName } from '../services/device-names.service.js';
import { checkAndReleaseStaleTransferLocks } from '../services/transfer-lock.service.js';
import {
  getPeerPage,
  isPeerOnSession,
  PeerPage,
  peersOnPage,
  setPeerPage,
} from '../services/peer-page.service.js';
import { scheduleAbandonedSenderCheck } from '../jobs/abandoned-sender.job.js';
import { emitNavigate } from './navigate.js';
import {
  clearGraceRedirect,
  extendGraceRedirect,
  startGraceRedirect,
  syncGraceToHost,
} from '../services/grace-redirect.service.js';
import { assertHostPeer } from '../services/peer-auth.service.js';
import { isSafeId } from '../utils/ids.js';
import { getTransferCoordinator } from '../services/transfer/coordinator.service.js';

function startTransfer(session, fileId, io) {
  const activeTransfer = session.activeTransfer;
  if (!activeTransfer || activeTransfer.fileId !== fileId) return;

  const senderPeerId = activeTransfer.senderPeerId;
  const sender = session.peers.get(senderPeerId);
  if (!sender) return;

  const acceptedCount = activeTransfer.acceptedReceivers.size;
  if (acceptedCount === 0) return;

  const fileMetadata = activeTransfer.file;
  if (!fileMetadata) return;

  logger.info(
    `🔄 Initiating startTransfer helper for fileId: ${fileId}. Accepted count: ${acceptedCount}`,
  );

  // Track pending downloads
  try {
    const meta = {
      id: fileId,
      name: fileMetadata.name,
      size: fileMetadata.size,
      type: fileMetadata.type,
      path: 'relay',
      pending: acceptedCount,
    };
    session.activeFiles.set(fileId, meta);
  } catch (e) {
    logger.error('Failed to pre-register pending downloads in session:', e);
  }

  // Record recent transfers
  for (const receiverPeerId of activeTransfer.acceptedReceivers) {
    const receiver = session.peers.get(receiverPeerId);
    if (receiver) {
      try {
        store.recentTransfers.push({
          senderId: senderPeerId,
          senderName: sender.deviceName || '',
          receiverId: receiverPeerId,
          receiverName: receiver.deviceName || '',
          fileName: fileMetadata.name,
          size: fileMetadata.size,
          timestamp: Date.now(),
        });
      } catch (_) {}
    }
  }

  const expectedCount = activeTransfer.acceptedReceivers
    ? activeTransfer.acceptedReceivers.size
    : 0;
  const useStreamRelay = config.transfer.enableStreamRelay && expectedCount === 1;

  if (useStreamRelay) {
    logger.info(
      `🌊 Single receiver (${expectedCount}) -> Dynamic stream relay initialized for file ${fileId}`,
    );
    const coordinator = getTransferCoordinator();

    // 1. Initialize stream session in coordinator
    coordinator.initializeStreamSession(
      fileId,
      fileMetadata,
      activeTransfer.acceptedReceivers,
      sender.socketId,
      session,
    );

    // 2. Instruct accepted receivers to connect download stream immediately
    const baseDownloadUrl = `/download/${session.id}/${fileId}`;
    for (const receiverPeerId of activeTransfer.acceptedReceivers) {
      const receiver = session.peers.get(receiverPeerId);
      if (receiver) {
        const downloadUrl = `${baseDownloadUrl}?receiver=${encodeURIComponent(receiverPeerId)}`;
        io.to(receiver.socketId).emit('download-ready', {
          file: fileMetadata,
          downloadUrl,
          stream: true,
        });
      }
    }
  } else {
    // Traditional Disk-based relay
    logger.info(`💾 Initializing traditional disk-based transfer for file ${fileId}`);

    // Send start-upload to sender
    io.to(sender.socketId).emit('start-upload', { fileId });

    // Inform accepted receivers that upload started
    for (const receiverPeerId of activeTransfer.acceptedReceivers) {
      const receiver = session.peers.get(receiverPeerId);
      if (receiver) {
        io.to(receiver.socketId).emit('upload-started', { fileId });
      }
    }
  }
}

function handleReceiverExit(session, peerId, io) {
  const activeTransfer = session.activeTransfer;
  if (!activeTransfer) return;

  const isExpected = activeTransfer.receiversSnapshot.includes(peerId);
  const hasResponded =
    activeTransfer.acceptedReceivers.has(peerId) || activeTransfer.rejectedReceivers.has(peerId);

  if (isExpected && !hasResponded) {
    logger.info(
      `🔌 Receiver ${peerId} exited session/page during pending transfer for ${activeTransfer.fileId}. Registering auto-rejection.`,
    );

    // Register rejection on behalf of the exiting peer
    activeTransfer.rejectedReceivers.add(peerId);
    activeTransfer.totalResponses++;

    const fileId = activeTransfer.fileId;
    const totalReceivers = activeTransfer.receiversSnapshot.length;
    const totalResponses = activeTransfer.totalResponses;
    const acceptedCount = activeTransfer.acceptedReceivers.size;

    // Update all clients with the response count
    io.in(session.id).emit('response-count-updated', {
      fileId,
      totalResponses,
      totalReceivers,
    });

    const hostPeer = Array.from(session.peers.values()).find((p) => p.role === 'host');
    const hostSocket = hostPeer ? io.sockets.sockets.get(hostPeer.socketId) : null;
    if (hostSocket) {
      hostSocket.emit('response-count-updated', {
        fileId,
        totalResponses,
        totalReceivers,
      });
    }

    const sender = session.peers.get(activeTransfer.senderPeerId);
    if (sender) {
      io.to(sender.socketId).emit('receiver-rejected', { fileId, receiverPeerId: peerId });
    }

    // Check if all receivers have responded now
    if (totalResponses >= totalReceivers) {
      logger.info(
        `All responses received for ${fileId} after auto-rejection: ${totalResponses}/${totalReceivers}`,
      );

      try {
        if (activeTransfer.responseTimer) {
          clearTimeout(activeTransfer.responseTimer);
        }
      } catch (_) {}

      if (acceptedCount > 0) {
        startTransfer(session, fileId, io);
      } else {
        if (sender) {
          io.to(sender.socketId).emit('all-rejected', { fileId });
        }
        session.activeTransfer = null;
        session.currentSenderPeerId = null;
        io.in(session.id).emit('transfer-unlocked');
      }
    }
  }
}

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    logger.info(`New socket connection: ${socket.id}`);

    socket.on('join-session', ({ sessionId, role, peerId, deviceName }) => {
      logger.info(`Join session request: ${peerId} as ${role} in ${sessionId}`);

      const session = store.sessions.get(sessionId);
      if (!session) {
        logger.info(`❌ Session ${sessionId} not found`);
        return socket.emit('error', { message: 'Session not found' });
      }

      // Allow peers to rejoin sessions they previously exited
      // Clear the exited status when they rejoin
      if (session.exitedPeers && session.exitedPeers.has(peerId)) {
        logger.info(`✅ Peer ${peerId} rejoining after exit. Allowing reconnection.`);
        session.exitedPeers.delete(peerId);
      }

      // Check if peer already exists with different socket
      const existing = session.peers.get(peerId);
      if (existing && existing.socketId !== socket.id) {
        logger.info(`🔄 Updating socket for existing peer ${peerId}`);
        // Leave old socket from session if it exists
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket) {
          oldSocket.leave(sessionId);
        }

        // If peer was marked as disconnected, clear the disconnect timeout
        if (existing.disconnectTimeout) {
          clearTimeout(existing.disconnectTimeout);
          logger.info(`Cleared disconnect timeout for reconnecting peer ${peerId}`);
        }
      }

      const queryPage = socket.handshake.query.page;
      const joiningSessionPage = queryPage === 'main' || queryPage === 'session';
      const joiningSendPage = queryPage === 'send';
      const joiningReceivePage = queryPage === 'receive';

      let finalDeviceName = deviceName || '';
      if (!finalDeviceName && existing?.deviceName) {
        finalDeviceName = existing.deviceName;
      }
      if (!finalDeviceName) {
        finalDeviceName = getDeviceName(peerId);
      }

      const peerData = {
        role,
        socketId: socket.id,
        peerId,
        deviceName: finalDeviceName,
        isDisconnected: false,
        disconnectedAt: null,
      };

      if (joiningSendPage) {
        setPeerPage(peerData, PeerPage.SEND);
      } else if (joiningReceivePage) {
        setPeerPage(peerData, PeerPage.RECEIVE);
      } else if (existing) {
        setPeerPage(peerData, getPeerPage(existing));
      } else if (joiningSessionPage) {
        setPeerPage(peerData, PeerPage.SESSION);
      }

      session.peers.set(peerId, peerData);
      socket.join(sessionId);
      socket.data = { peerId, sessionId, role, page: getPeerPage(peerData) };

      if (role === 'host' && isPeerOnSession(peerData)) {
        logger.info(`🌟 Host ${peerId} is now on the main page`);
        // Check and release any stale locks when host joins main page
        checkAndReleaseStaleTransferLocks(sessionId, io);
      }

      logger.info(`✅ Peer ${peerId} joined session ${sessionId} as ${role}`);
      if (role === 'client') {
        logger.info(
          `📱 Client ${peerId} scanned QR code - waiting for PIN verification before redirecting host`,
        );
      }
      logger.info(
        `Current peers in ${sessionId}:`,
        Array.from(session.peers.values()).map((p) => `${p.peerId}(${p.role})`),
      );

      // Emit updates (only include connected peers)
      const connectedPeers = Array.from(session.peers.values()).filter((p) => !p.isDisconnected);
      io.in(sessionId).emit('peers-updated', connectedPeers);
      socket.emit('session-joined', { sessionId, role });
      socket.emit('history-updated', store.transferHistory.get(sessionId) || []);

      if (role === 'host') {
        syncGraceToHost(io, session, socket.id);
      }

      // Note: Automatic host redirect moved to client-has-verified event to wait for PIN verification
    });

    socket.on('client-has-verified', ({ sessionId }) => {
      logger.info(`Client verified for session ${sessionId}`);
      const session = store.sessions.get(sessionId);
      if (!session) return;

      // Check if host is connected
      const hostPeer = Array.from(session.peers.values()).find((p) => p.role === 'host');
      logger.info(`Host peer found:`, hostPeer ? `Yes (${hostPeer.peerId})` : 'No');

      // Emit session-joined event to the client immediately
      socket.emit('session-joined', { sessionId: sessionId, role: 'client' });
      logger.info(`✅ Emitted session-joined event to client for session ${sessionId}`);

      // 🎯 HOST REDIRECT BEHAVIOR:
      // - NO automatic redirect when PIN auto-verifies
      // - Host redirects ONLY when:
      //   1. User clicks "Go to Main Immediately" button, OR
      //   2. Grace timer expires (30 seconds)
      // This respects user choice and maintains the grace period system
      logger.info(
        `📱 Client ${socket.id} verified PIN - host stays on index page until user choice or grace timer expires`,
      );

      startGraceRedirect(session, io);
    });

    // When a client scans QR and verifies PIN, they can request to clear exit status
    socket.on('client-reset-exit', ({ sessionId, peerId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;
      try {
        if (session.exitedPeers) session.exitedPeers.delete(peerId);
      } catch (_) {}
    });

    // Handle device name updates
    socket.on('update-device-name', ({ sessionId, deviceName }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;

      const peer = Array.from(session.peers.values()).find((p) => p.socketId === socket.id);
      if (peer) {
        // 🆕 NEW: Update both session and persistent storage
        peer.deviceName = deviceName;
        setDeviceName(peer.peerId, deviceName); // Save to persistent storage

        logger.info(`📱 Device name updated for ${peer.peerId}: ${deviceName}`);
        logger.info(`💾 Device name saved to persistent storage for ${peer.peerId}`);

        // Notify other peers about the name update
        io.in(sessionId).emit('peer-name-updated', {
          peerId: peer.peerId,
          deviceName: deviceName,
        });
      }
    });

    // New: allow host/client to prepare other peers by redirecting them to receive page
    socket.on('prepare-receivers', ({ sessionId, senderId }, ack) => {
      logger.info(`Prepare receivers requested by ${senderId} in ${sessionId}`);
      const session = store.sessions.get(sessionId);
      if (!session) {
        logger.info(`❌ Session ${sessionId} not found for prepare-receivers`);
        if (typeof ack === 'function') ack({ ok: false, reason: 'session_not_found' });
        return;
      }
      const sender = session.peers.get(senderId);
      if (sender) {
        setPeerPage(sender, PeerPage.SEND);
        session.peers.set(senderId, sender);
        session.recentEnterSendPageAt = Date.now();
        logger.info(`📤 Marked sender ${senderId} as on send page (prepare-receivers)`);
      }

      const receivers = Array.from(session.peers.values()).filter(
        (p) => p.peerId !== senderId && !p.isDisconnected,
      );
      receivers.forEach((receiver) => {
        logger.info(`Preparing receiver ${receiver.peerId} → redirect to receive`);
        // Update receiver's page state immediately
        setPeerPage(receiver, PeerPage.RECEIVE);
        session.peers.set(receiver.peerId, receiver);
        emitNavigate(io, receiver.socketId, {
          page: PeerPage.RECEIVE,
          sessionId,
          role: receiver.role,
          peerId: receiver.peerId,
          forced: true,
        });
      });
      scheduleAbandonedSenderCheck(sessionId, io);
      if (typeof ack === 'function') ack({ ok: true, receivers: receivers.length });
    });

    // Host can choose to go to main immediately (only if at least one non-host is connected)
    socket.on('host-go-now', ({ sessionId }, ack) => {
      const session = store.sessions.get(sessionId);
      if (!session)
        return typeof ack === 'function' && ack({ ok: false, reason: 'session_not_found' });
      const clientsConnected = Array.from(session.peers.values()).some((p) => p.role !== 'host');
      if (!clientsConnected) {
        logger.info(`Host requested go-now but no clients connected in session ${sessionId}`);
        return (
          typeof ack === 'function' &&
          ack({ ok: false, reason: 'no_clients', message: 'No clients connected yet.' })
        );
      }
      clearGraceRedirect(session, io, { notifyHost: true });
      const hostPeer = Array.from(session.peers.values()).find((p) => p.role === 'host');
      if (hostPeer) {
        logger.info(
          `🚀 Host ${hostPeer.peerId} clicked "Go to Main Immediately" - redirecting to main.`,
        );
        setPeerPage(hostPeer, PeerPage.SESSION);
        session.peers.set(hostPeer.peerId, hostPeer);
        if (typeof ack === 'function') ack({ ok: true });
        emitNavigate(io, hostPeer.socketId, {
          page: PeerPage.SESSION,
          sessionId,
          role: 'host',
          peerId: hostPeer.peerId,
        });
      } else {
        if (typeof ack === 'function') ack({ ok: false, reason: 'no_host' });
      }
    });

    socket.on('host-extend-redirect', ({ sessionId }, ack) => {
      const session = store.sessions.get(sessionId);
      if (!session) {
        if (typeof ack === 'function') ack({ ok: false, reason: 'session_not_found' });
        return;
      }
      const result = extendGraceRedirect(session, io);
      if (typeof ack === 'function') ack(result);
    });

    // Mark the host as being on the main page as soon as they intend to navigate there
    socket.on('host-going-to-main', ({ sessionId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;
      const hostPeer = Array.from(session.peers.values()).find(
        (p) => p.role === 'host' && p.socketId === socket.id,
      );
      if (hostPeer) {
        hostPeer.currentPage = 'main';
        session.peers.set(hostPeer.peerId, hostPeer);
        logger.info(`🌟 Host ${hostPeer.peerId} marked as on main page (pre-navigation)`);
        const connectedPeers = Array.from(session.peers.values()).filter((p) => !p.isDisconnected);
        io.in(sessionId).emit('peers-updated', connectedPeers);

        clearGraceRedirect(session, io, { notifyHost: true });
        logger.info(`🧹 Grace timer cleared for host going to main page`);

        // Also release any stale locks now that host is ready
        try {
          checkAndReleaseStaleTransferLocks(sessionId, io);
        } catch (_) {}
      }
    });

    // 🎯 ENHANCED: Send lock system with automatic redirects
    socket.on('request-send-lock', ({ sessionId, senderId }, ack) => {
      const session = store.sessions.get(sessionId);
      if (!session)
        return typeof ack === 'function' && ack({ ok: false, reason: 'session_not_found' });

      // Check if host is in the main page
      const hostPeer = Array.from(session.peers.values()).find((p) => p.role === 'host');
      const hostInMainPage = hostPeer && hostPeer.currentPage === 'main';

      logger.info(
        `🔍 request-send-lock debug: senderId=${senderId}, hostPeerId=${hostPeer?.peerId}, senderId === hostPeerId: ${senderId === hostPeer?.peerId}, hostInMainPage=${hostInMainPage}`,
      );

      // If host is not in main page, but exists or grace window is active, proactively move host to main and proceed
      if (!hostInMainPage) {
        if (
          hostPeer &&
          senderId !== hostPeer.peerId &&
          hostPeer.currentPage !== 'send' &&
          hostPeer.currentPage !== 'receive'
        ) {
          logger.info(`⚠️ Host not on main, proactively redirecting for sender ${senderId}`);
          try {
            // Update host's page state to main
            hostPeer.currentPage = 'main';
            session.peers.set(hostPeer.peerId, hostPeer);
            const connectedPeers = Array.from(session.peers.values()).filter(
              (p) => !p.isDisconnected,
            );
            io.in(sessionId).emit('peers-updated', connectedPeers);
            setPeerPage(hostPeer, PeerPage.SESSION);
            emitNavigate(io, hostPeer.socketId, {
              page: PeerPage.SESSION,
              sessionId,
              role: 'host',
              peerId: hostPeer.peerId,
            });
            clearGraceRedirect(session, io, { notifyHost: true });
            // Release any stale locks
            checkAndReleaseStaleTransferLocks(sessionId, io);
          } catch (_) {}
        } else if (!hostPeer) {
          logger.info(
            `❌ No host present in session, rejecting send lock request from ${senderId}`,
          );
          return (
            typeof ack === 'function' &&
            ack({
              ok: false,
              reason: 'host_not_ready',
              message: 'Please wait for the host to connect (30 seconds delay).',
            })
          );
        }
      }

      // 🎯 ENHANCED CHECK: If someone is in send page, lock send button for others AND redirect them to receive
      const peersInSendPage = Array.from(session.peers.values()).filter(
        (p) => p.currentPage === 'send' && !p.isDisconnected,
      );

      if (peersInSendPage.length > 0) {
        const senderInSendPage = peersInSendPage.find((p) => p.peerId === senderId);
        if (!senderInSendPage) {
          logger.info(
            `🚫 Blocking send lock for ${senderId} - ${peersInSendPage.length} peer(s) currently in send page`,
          );

          // 🆕 NEW: Automatically redirect this peer to receive page since sender is active
          const peer = session.peers.get(senderId);
          if (peer) {
            logger.info(
              `🔄 Automatically redirecting ${senderId} to receive page since sender is active`,
            );
            setPeerPage(peer, PeerPage.RECEIVE);
            session.peers.set(senderId, peer);
            emitNavigate(io, peer.socketId, {
              page: PeerPage.RECEIVE,
              reason: 'sender_already_active',
              message:
                'Someone is already sending files. You have been redirected to the receive page.',
              sessionId,
              role: peer.role,
              peerId: peer.peerId,
            });
          }

          return (
            typeof ack === 'function' &&
            ack({
              ok: false,
              reason: 'send_page_occupied',
              message:
                'Someone is currently sending files. You have been redirected to the receive page.',
              autoRedirect: true,
            })
          );
        }
      }

      // Check if there's an active transfer lock
      if (session.currentSenderPeerId && session.currentSenderPeerId !== senderId) {
        logger.info(
          `🚫 Send lock already held by ${session.currentSenderPeerId}, rejecting ${senderId}`,
        );
        return (
          typeof ack === 'function' &&
          ack({
            ok: false,
            reason: 'locked',
            message: 'Another file transfer is already in progress. Please wait.',
            currentSender: session.currentSenderPeerId,
          })
        );
      }

      // Grant send lock and mark sender on send page (avoids abandoned-sender race before enter-send-page)
      session.currentSenderPeerId = senderId;
      const senderPeer = session.peers.get(senderId);
      if (senderPeer) {
        setPeerPage(senderPeer, PeerPage.SEND);
        session.peers.set(senderId, senderPeer);
        session.recentEnterSendPageAt = Date.now();
      }
      logger.info(`✅ Granted send lock to ${senderId} - no peers currently in send page`);

      // 🆕 NEW: Notify all peers that send button is now locked
      io.in(sessionId).emit('send-button-locked', {
        lockedBy: senderId,
        message: 'Send button is now locked. File transfer in progress.',
        timestamp: Date.now(),
      });

      return typeof ack === 'function' && ack({ ok: true });
    });

    socket.on('release-send-lock', ({ sessionId, senderId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;
      if (session.currentSenderPeerId === senderId) {
        session.currentSenderPeerId = null;
        logger.info(`🔓 Send lock released by ${senderId} in session ${sessionId}`);

        // 🆕 NEW: Check if there are still senders in send page before unlocking
        const sendersInSendPage = Array.from(session.peers.values()).filter(
          (p) => p.currentPage === 'send' && !p.isDisconnected,
        );

        if (sendersInSendPage.length === 0) {
          logger.info(`🔓 No senders in send page, unlocking send button`);

          // Notify all peers that send button is now unlocked
          io.in(sessionId).emit('send-button-unlocked', {
            unlockedBy: senderId,
            message: 'Send button is now unlocked. You can start a new file transfer.',
            timestamp: Date.now(),
          });

          io.in(sessionId).emit('transfer-unlocked');
        } else {
          logger.info(
            `🔒 Send button remains locked - ${sendersInSendPage.length} sender(s) still in send page`,
          );
        }
      }
    });

    // Replace the request-to-send handler in server.js with this corrected version:

    socket.on('request-to-send', ({ sessionId, file, senderId }) => {
      logger.info(`Send request from ${senderId} for file ${file.id}`);

      const session = store.sessions.get(sessionId);
      if (!session) {
        logger.info(`❌ Session ${sessionId} not found for send request`);
        return socket.emit('send-rejected', { fileId: file.id, reason: 'Session not found' });
      }

      if (session.activeTransfer) {
        logger.info(`❌ Active transfer in progress, rejecting ${file.id}`);
        return socket.emit('send-rejected', {
          fileId: file.id,
          reason: 'Another transfer is in progress.',
        });
      }

      // FIXED: Find all peers except the sender as potential receivers
      const receivers = Array.from(session.peers.values()).filter(
        (p) => p.peerId !== senderId && !p.isDisconnected,
      );
      logger.info(
        `Available receivers:`,
        receivers.map((r) => `${r.peerId}(${r.role})`),
      );

      if (receivers.length === 0) {
        logger.info(`❌ No receivers available for ${file.id}`);
        return socket.emit('send-rejected', { fileId: file.id, reason: 'No receivers available.' });
      }

      session.activeTransfer = {
        senderPeerId: senderId,
        fileId: file.id,
        file: file, // Store the offered file metadata
        acceptedReceivers: new Set(),
        rejectedReceivers: new Set(),
        receiversSnapshot: receivers.map((r) => r.peerId),
        // offerTimer removed - using only responseTimer now
        responseTimer: null,
        responseDeadlineMs: null,
        totalResponses: 0,
      };
      logger.info(`✅ Send approved for ${file.id}, notifying ${receivers.length} receivers`);

      socket.emit('send-approved', { fileId: file.id });

      // Add cooldown to prevent abandoned sender check from running immediately
      session.recentSendRequestAt = Date.now();

      // Redirect all other peers (receivers) to receive page
      receivers.forEach((receiver) => {
        logger.info(`Redirecting ${receiver.peerId} to receive page`);
        // Update receiver's page state immediately
        setPeerPage(receiver, PeerPage.RECEIVE);
        session.peers.set(receiver.peerId, receiver);
        emitNavigate(io, receiver.socketId, {
          page: PeerPage.RECEIVE,
          sessionId,
          role: receiver.role,
          peerId: receiver.peerId,
          forced: true,
        });
      });
      scheduleAbandonedSenderCheck(sessionId, io);

      const sender = session.peers.get(senderId);
      if (sender) {
        setPeerPage(sender, PeerPage.SEND);
        session.peers.set(senderId, sender);
        logger.info(`📤 Updated sender ${senderId} page state to send`);
      }

      // Also immediately offer file metadata to receivers
      const senderName = sender ? sender.deviceName : 'Unknown Device';
      receivers.forEach((receiver) => {
        io.to(receiver.socketId).emit('file-offer', { file, senderId, senderName });
      });

      // Start 30-second timer to check if all receivers have responded
      try {
        if (session.activeTransfer.responseTimer)
          clearTimeout(session.activeTransfer.responseTimer);
      } catch (_) {}

      // Emit the timer start event to all clients, including those on the index page
      io.in(sessionId).emit('response-timer-started', {
        fileId: file.id,
        duration: 30,
        totalReceivers: receivers.length,
      });

      // Also emit to any sockets in the session that might be on the index page
      const hostPeer = Array.from(session.peers.values()).find((p) => p.role === 'host');
      const hostSocket = hostPeer ? io.sockets.sockets.get(hostPeer.socketId) : null;
      if (hostSocket) {
        logger.info(`Emitting response timer to host on index page`);
        hostSocket.emit('response-timer-started', {
          fileId: file.id,
          duration: 30,
          totalReceivers: receivers.length,
        });
      }

      // Track response deadline and timer
      session.activeTransfer.responseDeadlineMs = Date.now() + 30000;
      session.activeTransfer.responseTimer = setTimeout(() => {
        const current = store.sessions.get(sessionId);
        if (!current || !current.activeTransfer) return;
        if (current.activeTransfer.fileId !== file.id) return;

        logger.info(`Response timer expired for file ${file.id}`);

        const totalReceivers = current.activeTransfer.receiversSnapshot.length;
        const acceptedCount = current.activeTransfer.acceptedReceivers.size;
        const totalResponses = current.activeTransfer.totalResponses;

        logger.info(
          `Timer expired - Responses: ${totalResponses}/${totalReceivers}, Accepted: ${acceptedCount}`,
        );

        // Timer expired - make decision based on current state
        if (acceptedCount > 0) {
          startTransfer(current, file.id, io);
        } else {
          // No one accepted, move to next file
          const sender = current.peers.get(senderId);
          if (sender) {
            logger.info(`Timer expired - No accepts for ${file.id}, moving to next file`);
            io.to(sender.socketId).emit('offer-timeout', { fileId: file.id });
          }
          current.activeTransfer = null;
          current.currentSenderPeerId = null; // Release the send lock
          io.in(sessionId).emit('transfer-unlocked');
        }
      }, 30000);

      // Note: We removed the 2-minute offer timer as it was redundant
      // The 30-second response timer handles all cases: all responses received OR timer expiry
    });

    // Also update the file-uploaded-offer-to-peers handler:
    socket.on('file-uploaded-offer-to-peers', ({ sessionId, file, senderId }) => {
      logger.info(`File uploaded, offering ${file.name} to peers`);

      const session = store.sessions.get(sessionId);
      if (!session) return;

      const history = store.transferHistory.get(sessionId) || [];
      history.unshift({
        id: file.id,
        fileName: file.name,
        fileSize: file.size,
        sender: senderId,
        status: 'pending',
        timestamp: new Date().toISOString(),
      });
      store.transferHistory.set(sessionId, history);
      io.in(sessionId).emit('history-updated', history);

      // FIXED: Offer to all peers except sender (regardless of role)
      const receivers = Array.from(session.peers.values()).filter(
        (p) => p.peerId !== senderId && !p.isDisconnected,
      );
      logger.info(
        `Offering file to:`,
        receivers.map((r) => `${r.peerId}(${r.role})`),
      );

      const sender = session.peers.get(senderId);
      const senderName = sender ? sender.deviceName : 'Unknown Device';
      receivers.forEach((receiver) => {
        io.to(receiver.socketId).emit('file-offer', { file, senderId, senderName });
      });
    });

    socket.on('accept-file', ({ sessionId, fileId, receiverPeerId }) => {
      logger.info(`File ${fileId} accepted by ${receiverPeerId}`);
      const session = store.sessions.get(sessionId);
      if (!session) return;
      if (!session.activeTransfer || session.activeTransfer.fileId !== fileId) return;
      session.activeTransfer.acceptedReceivers.add(receiverPeerId);
      session.activeTransfer.totalResponses++;

      const totalReceivers = session.activeTransfer.receiversSnapshot.length;
      const totalResponses = session.activeTransfer.totalResponses;
      const acceptedCount = session.activeTransfer.acceptedReceivers.size;

      logger.info(
        `Accept response: ${totalResponses}/${totalReceivers} responses, ${acceptedCount} accepted`,
      );

      // Update all clients with the response count
      io.in(sessionId).emit('response-count-updated', {
        fileId,
        totalResponses,
        totalReceivers,
      });

      // Also emit to the host if they're on the index page
      const hostPeer = Array.from(session.peers.values()).find((p) => p.role === 'host');
      const hostSocket = hostPeer ? io.sockets.sockets.get(hostPeer.socketId) : null;
      if (hostSocket) {
        logger.info(`Emitting response count update to host on index page`);
        hostSocket.emit('response-count-updated', {
          fileId,
          totalResponses,
          totalReceivers,
        });
      }

      // Check if all receivers have responded
      if (totalResponses >= totalReceivers) {
        logger.info(`All responses received for ${fileId}: ${totalResponses}/${totalReceivers}`);

        // Clear the response timer as all have responded
        try {
          if (session.activeTransfer.responseTimer)
            clearTimeout(session.activeTransfer.responseTimer);
        } catch (_) {}

        // Check if at least one accepted
        if (session.activeTransfer.acceptedReceivers.size > 0) {
          startTransfer(session, fileId, io);
        } else {
          // All rejected, notify sender and unlock for next file
          const senderPeerId = session.activeTransfer.senderPeerId;
          const sender = session.peers.get(senderPeerId);
          if (sender) {
            logger.info(`All responses received - All rejected for ${fileId}, moving to next file`);
            io.to(sender.socketId).emit('all-rejected', { fileId });
          }
          session.activeTransfer = null;
          session.currentSenderPeerId = null; // Release the send lock
          io.in(sessionId).emit('transfer-unlocked');
        }
      } else {
        logger.info(`Waiting for more responses: ${totalResponses}/${totalReceivers} received`);
      }
      // Note: We don't start upload on first accept anymore - wait for all responses or timer
    });

    socket.on('reject-file', ({ sessionId, fileId, receiverPeerId }) => {
      logger.info(`File ${fileId} rejected by ${receiverPeerId}`);
      const session = store.sessions.get(sessionId);
      if (!session || !session.activeTransfer) return;
      if (session.activeTransfer.fileId !== fileId) return;
      session.activeTransfer.rejectedReceivers.add(receiverPeerId);
      session.activeTransfer.totalResponses++;

      const totalReceivers = session.activeTransfer.receiversSnapshot.length;
      const totalResponses = session.activeTransfer.totalResponses;
      const acceptedCount = session.activeTransfer.acceptedReceivers.size;

      logger.info(
        `Reject response: ${totalResponses}/${totalReceivers} responses, ${acceptedCount} accepted`,
      );

      // Update all clients with the response count
      io.in(sessionId).emit('response-count-updated', {
        fileId,
        totalResponses,
        totalReceivers,
      });

      // Also emit to the host if they're on the index page
      const hostPeer = Array.from(session.peers.values()).find((p) => p.role === 'host');
      const hostSocket = hostPeer ? io.sockets.sockets.get(hostPeer.socketId) : null;
      if (hostSocket) {
        logger.info(`Emitting response count update to host on index page`);
        hostSocket.emit('response-count-updated', {
          fileId,
          totalResponses,
          totalReceivers,
        });
      }

      const senderPeerId = session.activeTransfer.senderPeerId;
      const sender = session.peers.get(senderPeerId);
      // Notify sender of a single rejection
      if (sender) io.to(sender.socketId).emit('receiver-rejected', { fileId, receiverPeerId });

      // Check if all receivers have responded
      if (totalResponses >= totalReceivers) {
        logger.info(`All responses received for ${fileId}: ${totalResponses}/${totalReceivers}`);

        // Clear the response timer as all have responded
        try {
          if (session.activeTransfer.responseTimer)
            clearTimeout(session.activeTransfer.responseTimer);
        } catch (_) {}

        // Check if at least one accepted
        if (session.activeTransfer.acceptedReceivers.size > 0) {
          startTransfer(session, fileId, io);
        } else {
          // All rejected, notify sender and unlock for next file
          if (sender) {
            logger.info(`All responses received - All rejected for ${fileId}, moving to next file`);
            io.to(sender.socketId).emit('all-rejected', { fileId });
          }
          session.activeTransfer = null;
          session.currentSenderPeerId = null; // Release the send lock
          io.in(sessionId).emit('transfer-unlocked');
        }
      } else {
        logger.info(`Waiting for more responses: ${totalResponses}/${totalReceivers} received`);
      }
    });

    socket.on('transfer-complete', ({ sessionId }) => {
      logger.info(`Transfer complete for session ${sessionId}`);
      const session = store.sessions.get(sessionId);
      if (session) {
        session.activeTransfer = null;
        session.currentSenderPeerId = null; // Release the send lock
        io.in(sessionId).emit('transfer-unlocked');
      }
    });

    // Sender notifies server when upload completed so we can deliver download URLs
    socket.on('upload-complete', ({ sessionId, file }) => {
      const session = store.sessions.get(sessionId);
      if (!session || !session.activeTransfer) {
        // If there's no active transfer but we got an upload-complete event,
        // check and release any stale locks
        checkAndReleaseStaleTransferLocks(sessionId, io);
        return;
      }
      const { acceptedReceivers } = session.activeTransfer;
      const baseDownloadUrl = `/download/${sessionId}/${file.id}`;
      // Initialize/refresh pending counter for this file so we only delete after all receivers finish
      try {
        const meta = session.activeFiles.get(file.id);
        if (meta) {
          meta.pending = acceptedReceivers ? acceptedReceivers.size : 1;
          session.activeFiles.set(file.id, meta);
          logger.info(`📊 Pending downloads for ${file.name}: ${meta.pending}`);
        }
      } catch (e) {
        logger.error('Failed to set pending counter for file:', e);
      }

      // Check each receiver's download queue before sending
      for (const receiverPeerId of acceptedReceivers || []) {
        const receiver = session.peers.get(receiverPeerId);
        if (receiver) {
          // Record per-receiver recent transfer with names
          try {
            const senderPeer = session.peers.get(session.activeTransfer.senderPeerId) || {};
            store.recentTransfers.push({
              senderId: session.activeTransfer.senderPeerId,
              senderName: senderPeer.deviceName || '',
              receiverId: receiverPeerId,
              receiverName: receiver.deviceName || '',
              fileName: file.name,
              size: file.size,
              timestamp: Date.now(),
            });
            if (store.recentTransfers.length > 100)
              store.recentTransfers.splice(0, store.recentTransfers.length - 100);
          } catch (_) {}
          // Check if receiver has an empty download queue
          const sessionDownloadQueue = store.receiverDownloadQueues.get(sessionId);
          const receiverQueue = sessionDownloadQueue?.get(receiverPeerId) || [];

          // Check download flag for this receiver
          // Determine current active count
          let activeCount = 0;
          if (store.receiverActiveDownloads.has(sessionId)) {
            activeCount = store.receiverActiveDownloads.get(sessionId).get(receiverPeerId) || 0;
          }

          if (activeCount < config.maxConcurrentDownloadsPerReceiver) {
            // Download flag is 0 (ready), send file immediately
            const downloadUrl = `${baseDownloadUrl}?receiver=${encodeURIComponent(receiverPeerId)}`;
            logger.info(
              `🚀 SENDING FILE: ${file.name} to ${receiverPeerId} (download flag = 0, browser should start download now)`,
            );
            io.to(receiver.socketId).emit('download-ready', { file, downloadUrl });

            // Increment active downloads
            if (!store.receiverActiveDownloads.has(sessionId))
              store.receiverActiveDownloads.set(sessionId, new Map());
            const m = store.receiverActiveDownloads.get(sessionId);
            m.set(receiverPeerId, (m.get(receiverPeerId) || 0) + 1);
            logger.info(`📥 Active downloads for ${receiverPeerId}: ${m.get(receiverPeerId)}`);

            // Queue progression will now be driven by actual download completion in /download route
          } else {
            // Download flag is 1 (downloading), add to queue
            logger.info(
              `File ${file.name} waiting for ${receiverPeerId} to finish current download`,
            );

            // Add to queue for later processing
            if (!store.receiverDownloadQueues.has(sessionId)) {
              store.receiverDownloadQueues.set(sessionId, new Map());
            }
            if (!store.receiverDownloadQueues.get(sessionId).has(receiverPeerId)) {
              store.receiverDownloadQueues.get(sessionId).set(receiverPeerId, []);
            }
            const queuedUrl = `${baseDownloadUrl}?receiver=${encodeURIComponent(receiverPeerId)}`;
            store.receiverDownloadQueues
              .get(sessionId)
              .get(receiverPeerId)
              .push({ file, downloadUrl: queuedUrl });

            // Debug: Show current queue state
            const currentQueue = store.receiverDownloadQueues.get(sessionId).get(receiverPeerId);
            logger.info(`Queue state for ${receiverPeerId}: ${currentQueue.length} files waiting`);
            currentQueue.forEach((item, index) => {
              logger.info(`  [${index}] ${item.file.name}`);
            });
          }
        }
      }

      // Update history entry: mark as completed and add recipients list
      try {
        const acceptedList = acceptedReceivers ? Array.from(acceptedReceivers) : [];
        const history = store.transferHistory.get(sessionId) || [];
        const entry = history.find((h) => h.id === file.id);
        if (entry) {
          entry.status = 'completed';
          entry.recipients = acceptedList;
          store.transferHistory.set(sessionId, history);
          io.in(sessionId).emit('history-updated', history);
        }
      } catch (e) {
        logger.error('Failed to update transfer history after upload-complete:', e);
      }

      // Notify clients that recent history changed
      try {
        io.in(sessionId).emit('recent-updated');
      } catch (_) {}

      // Clear active transfer and release sender lock so new sends can start
      session.activeTransfer = null;
      session.currentSenderPeerId = null;
      session.lastTransferCompletedAt = Date.now(); // Track when transfer completed
      io.in(sessionId).emit('transfer-unlocked');
    });

    // Function to start 5-second timer for checking download flag and sending next file
    function startDownloadTimer(sessionId, receiverPeerId) {
      logger.info(`Starting 5-second download timer for ${receiverPeerId}`);

      setTimeout(() => {
        logger.info(`Download timer fired for ${receiverPeerId}`);

        // Check if receiver still exists and has files in queue
        const session = store.sessions.get(sessionId);
        if (!session) return;

        const receiver = session.peers.get(receiverPeerId);
        if (!receiver) return;

        const sessionDownloadQueue = store.receiverDownloadQueues.get(sessionId);
        if (!sessionDownloadQueue) return;

        const receiverQueue = sessionDownloadQueue.get(receiverPeerId);
        if (!receiverQueue || receiverQueue.length === 0) return;

        // Set download flag to 0 (ready) and send next file
        if (store.receiverDownloadFlags.has(sessionId)) {
          store.receiverDownloadFlags.get(sessionId).set(receiverPeerId, false);
          logger.info(`📥 Download flag reset to 0 (ready) for ${receiverPeerId}`);
        }

        // Get the top file from queue
        const nextFile = receiverQueue.shift();
        logger.info(
          `🚀 SENDING QUEUED FILE: ${nextFile.file.name} to ${receiverPeerId} (download flag was 0, browser should start download now)`,
        );

        // Send the file
        io.to(receiver.socketId).emit('download-ready', {
          file: nextFile.file,
          downloadUrl: nextFile.downloadUrl,
        });

        // Set download flag to 1 (downloading) and start timer again
        if (!store.receiverDownloadFlags.has(sessionId)) {
          store.receiverDownloadFlags.set(sessionId, new Map());
        }
        store.receiverDownloadFlags.get(sessionId).set(receiverPeerId, true);

        // If there are more files in queue, start timer again
        if (receiverQueue.length > 0) {
          startDownloadTimer(sessionId, receiverPeerId);
        } else {
          // Queue is empty, clean up
          sessionDownloadQueue.delete(receiverPeerId);
          if (sessionDownloadQueue.size === 0) {
            store.receiverDownloadQueues.delete(sessionId);
          }
          logger.info(`Queue empty for ${receiverPeerId}, cleanup complete`);
        }
      }, 5000); // 5-second timer as requested
    }

    // Relay sender upload progress to receivers for UI updates
    socket.on('sender-progress', ({ sessionId, fileId, loaded, total, speedBps, etaSeconds }) => {
      const session = store.sessions.get(sessionId);
      if (!session || !session.activeTransfer || session.activeTransfer.fileId !== fileId) return;

      // Only send progress to receivers who accepted the file
      const { acceptedReceivers } = session.activeTransfer;
      for (const receiverPeerId of acceptedReceivers || []) {
        const receiver = session.peers.get(receiverPeerId);
        if (receiver) {
          io.to(receiver.socketId).emit('sender-progress', {
            fileId,
            loaded,
            total,
            speedBps,
            etaSeconds,
          });
        }
      }
    });

    // Allow sender to extend the response window by 30 seconds (adds to remaining)
    socket.on('extend-response-timer', ({ sessionId, fileId, senderId }) => {
      const session = store.sessions.get(sessionId);
      if (!session || !session.activeTransfer) return;
      if (session.activeTransfer.fileId !== fileId) return;
      if (session.activeTransfer.senderPeerId !== senderId) return;

      // Compute remaining; add 30s; reset timer to new deadline
      const now = Date.now();
      const remainingMs = Math.max(0, (session.activeTransfer.responseDeadlineMs || now) - now);
      const newRemainingMs = remainingMs + 30000;
      session.activeTransfer.responseDeadlineMs = now + newRemainingMs;

      try {
        if (session.activeTransfer.responseTimer)
          clearTimeout(session.activeTransfer.responseTimer);
      } catch (_) {}
      const totalReceivers = session.activeTransfer.receiversSnapshot.length;
      io.in(sessionId).emit('response-timer-started', {
        fileId,
        duration: Math.ceil(newRemainingMs / 1000),
        totalReceivers,
      });

      session.activeTransfer.responseTimer = setTimeout(() => {
        const current = store.sessions.get(sessionId);
        if (!current || !current.activeTransfer) return;
        if (current.activeTransfer.fileId !== fileId) return;

        const totalReceiversNow = current.activeTransfer.receiversSnapshot.length;
        const acceptedCount = current.activeTransfer.acceptedReceivers.size;
        const sender = current.peers.get(senderId);

        if (acceptedCount > 0) {
          if (sender) io.to(sender.socketId).emit('start-upload', { fileId });
          // Inform only accepted receivers that the sender has started preparing upload
          for (const receiverPeerId of current.activeTransfer.acceptedReceivers || []) {
            const receiver = current.peers.get(receiverPeerId);
            if (receiver) {
              io.to(receiver.socketId).emit('upload-started', { fileId });
            }
          }
        } else {
          if (sender) io.to(sender.socketId).emit('offer-timeout', { fileId });
          current.activeTransfer = null;
          current.currentSenderPeerId = null; // Release the send lock
          io.in(sessionId).emit('transfer-unlocked');
        }
      }, newRemainingMs);
    });

    // Manual proceed: start upload immediately if >=1 accept, else treat as all rejected
    socket.on('manual-proceed', ({ sessionId, fileId, senderId }) => {
      const session = store.sessions.get(sessionId);
      if (!session || !session.activeTransfer) return;
      if (session.activeTransfer.fileId !== fileId) return;
      if (session.activeTransfer.senderPeerId !== senderId) return;
      try {
        if (session.activeTransfer.responseTimer)
          clearTimeout(session.activeTransfer.responseTimer);
      } catch (_) {}
      const acceptedCount = session.activeTransfer.acceptedReceivers.size;
      const sender = session.peers.get(senderId);
      if (acceptedCount > 0) {
        if (sender) io.to(sender.socketId).emit('start-upload', { fileId });
        // Inform only accepted receivers that the sender has started preparing upload
        for (const receiverPeerId of session.activeTransfer.acceptedReceivers || []) {
          const receiver = session.peers.get(receiverPeerId);
          if (receiver) {
            io.to(receiver.socketId).emit('upload-started', { fileId });
          }
        }
      } else {
        if (sender) io.to(sender.socketId).emit('all-rejected', { fileId });
        session.activeTransfer = null;
        session.currentSenderPeerId = null; // Release the send lock
        io.in(sessionId).emit('transfer-unlocked');
      }
    });

    // Cancel a pending offer (pre-upload) without redirecting pages
    socket.on('cancel-pending-offer', ({ sessionId, fileId, senderId }) => {
      const session = store.sessions.get(sessionId);
      if (!session || !session.activeTransfer) return;
      if (session.activeTransfer.fileId !== fileId) return;
      if (session.activeTransfer.senderPeerId !== senderId) return;
      // Clear timers and active transfer, keep the sender lock so they can immediately send next
      try {
        if (session.activeTransfer.responseTimer)
          clearTimeout(session.activeTransfer.responseTimer);
      } catch (_) {}
      session.activeTransfer = null;
      session.currentSenderPeerId = null; // Release the send lock
      io.in(sessionId).emit('transfer-unlocked');
    });

    // Sender cancels or goes back: unlock and return everyone to main page
    socket.on('cancel-transfer', ({ sessionId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;
      session.activeTransfer = null;
      session.currentSenderPeerId = null;
      io.in(sessionId).emit('transfer-unlocked');
      io.in(sessionId).emit('return-all-to-main');
      scheduleAbandonedSenderCheck(sessionId, io);
    });

    // 📍 NEW: Track when users enter receive page
    socket.on('enter-receive-page', ({ sessionId, peerId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;

      const peer = session.peers.get(peerId);
      if (peer) {
        // Check if peer was already in receive page (page refresh scenario)
        const wasAlreadyInReceivePage = getPeerPage(peer) === PeerPage.RECEIVE;

        setPeerPage(peer, PeerPage.RECEIVE);
        session.peers.set(peerId, peer);
        logger.info(
          `📥 Peer ${peerId} entered receive page in session ${sessionId} (was already in receive: ${wasAlreadyInReceivePage})`,
        );

        session.recentEnterReceivePageAt = Date.now();
        scheduleAbandonedSenderCheck(sessionId, io);
      }
    });

    // 📍 NEW: Track when users navigate to PIN page (browser back scenario)
    socket.on('enter-pin-page', ({ sessionId, peerId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;

      const peer = session.peers.get(peerId);
      if (peer) {
        logger.info(`📱 Peer ${peerId} navigated to PIN page in session ${sessionId}`);

        // Update peer's page state to indicate they're on PIN page
        setPeerPage(peer, PeerPage.PIN);
        session.peers.set(peerId, peer);

        const connectedOnMain = peersOnPage(session, PeerPage.SESSION);
        io.in(sessionId).emit('peer-count-updated', { count: connectedOnMain.length });

        // 🆕 NEW: Emit peers-updated event to update peer count display
        const connectedPeers = Array.from(session.peers.values()).filter((p) => !p.isDisconnected);
        io.in(sessionId).emit('peers-updated', connectedPeers);
      }
    });

    // 📍 NEW: Track when users leave receive page
    socket.on('leave-receive-page', ({ sessionId, peerId }) => {
      logger.info(`📥 leave-receive-page event received from ${peerId} in session ${sessionId}`);
      const session = store.sessions.get(sessionId);
      if (!session) {
        logger.info(`❌ Session ${sessionId} not found for leave-receive-page`);
        return;
      }

      const peer = session.peers.get(peerId);
      if (peer) {
        setPeerPage(peer, PeerPage.SESSION);
        session.peers.set(peerId, peer);
        logger.info(`📥 Peer ${peerId} left receive page in session ${sessionId}`);
        handleReceiverExit(session, peerId, io);
      } else {
        logger.info(
          `⚠️ Peer ${peerId} not found in session ${sessionId} when trying to leave receive page`,
        );
      }
      scheduleAbandonedSenderCheck(sessionId, io);
    });

    // 📍 NEW: Track when users enter send page
    socket.on('enter-send-page', ({ sessionId, peerId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;

      const peer = session.peers.get(peerId);
      if (peer) {
        // Check if peer was already in send page (page refresh scenario)
        const wasAlreadyInSendPage = getPeerPage(peer) === PeerPage.SEND;

        setPeerPage(peer, PeerPage.SEND);
        session.peers.set(peerId, peer);
        logger.info(
          `📤 Peer ${peerId} entered send page in session ${sessionId} (was already in send: ${wasAlreadyInSendPage})`,
        );

        session.recentEnterSendPageAt = Date.now();

        if (!wasAlreadyInSendPage) {
          const otherPeers = Array.from(session.peers.values()).filter(
            (p) => p.peerId !== peerId && getPeerPage(p) !== PeerPage.SEND && !p.isDisconnected,
          );

          otherPeers.forEach((otherPeer) => {
            logger.info(`🔄 Redirecting ${otherPeer.peerId} to receive (sender ${peerId} active)`);

            setPeerPage(otherPeer, PeerPage.RECEIVE);
            session.peers.set(otherPeer.peerId, otherPeer);

            emitNavigate(io, otherPeer.socketId, {
              page: PeerPage.RECEIVE,
              reason: 'sender_in_send_page',
              message: 'A sender is active. You have been redirected to the receive page.',
              sessionId,
              role: otherPeer.role,
              peerId: otherPeer.peerId,
              forced: true,
            });
          });
        } else {
          logger.info(`🔄 Send page refresh detected for ${peerId} - not redirecting other peers`);
        }
        scheduleAbandonedSenderCheck(sessionId, io);
      }
    });

    // 📍 NEW: Track when users leave send page
    socket.on('leave-send-page', ({ sessionId, peerId }) => {
      const session = store.sessions.get(sessionId);
      if (!session) return;

      const peer = session.peers.get(peerId);
      if (peer) {
        const wasActiveSender = session.currentSenderPeerId === peerId;
        setPeerPage(peer, PeerPage.SESSION);
        session.peers.set(peerId, peer);
        logger.info(`📤 Peer ${peerId} left send page in session ${sessionId}`);

        const receiversInReceivePage = peersOnPage(session, PeerPage.RECEIVE);

        // Only bounce receivers to session when the active sender leaves — not when another
        // peer is redirected to receive (their navigate handler emits leave-send-page).
        if (wasActiveSender && receiversInReceivePage.length > 0) {
          logger.info(
            `🔄 Sender ${peerId} left send — redirecting ${receiversInReceivePage.length} receivers to session page`,
          );

          receiversInReceivePage.forEach((receiver) => {
            setPeerPage(receiver, PeerPage.SESSION);
            session.peers.set(receiver.peerId, receiver);

            emitNavigate(io, receiver.socketId, {
              page: PeerPage.SESSION,
              reason: 'sender_left_send_page',
              message:
                'The sender has left the send page. You have been redirected to the session page.',
              sessionId,
              role: receiver.role,
              peerId: receiver.peerId,
            });
          });
        }

        // 🆕 NEW: Release the send lock since sender is no longer in send page
        if (wasActiveSender) {
          session.currentSenderPeerId = null;
          logger.info(`🔓 Send lock released for ${peerId} - sender left send page`);

          // Notify all peers that send button is now unlocked
          io.in(sessionId).emit('send-button-unlocked', {
            unlockedBy: peerId,
            message: 'Send button is now unlocked. Sender left send page.',
            timestamp: Date.now(),
          });
        }
        scheduleAbandonedSenderCheck(sessionId, io);
      }
    });

    // 🆕 NEW: Track when users enter main page
    socket.on('enter-main-page', ({ sessionId, peerId, role }) => {
      logger.info(`🔍 enter-main-page event received:`, { sessionId, peerId, role });

      const session = store.sessions.get(sessionId);
      if (!session) {
        logger.info(`❌ Session ${sessionId} not found for enter-main-page`);
        return;
      }

      const peer = session.peers.get(peerId);
      if (peer) {
        logger.info(`🔍 Peer before update:`, {
          peerId: peer.peerId,
          role: peer.role,
          currentPage: peer.currentPage,
          inMain: peer.inMain,
        });

        setPeerPage(peer, PeerPage.SESSION);
        session.peers.set(peerId, peer);

        logger.info(`✅ Updated peer ${peerId} to page=session`);
        logger.info(`🔍 Peer after update:`, {
          peerId: peer.peerId,
          role: peer.role,
          currentPage: peer.currentPage,
          inMain: peer.inMain,
        });
      } else {
        logger.info(`❌ Peer ${peerId} not found in session ${sessionId}`);
      }

      // 🆕 NEW: Check if this peer was previously in receive page and if sender is still in send page
      const senderInSendPage = peersOnPage(session, PeerPage.SEND)[0];

      if (senderInSendPage && peer && peer.role !== 'host') {
        logger.info(
          `🔄 Peer ${peerId} entered main page, but sender ${senderInSendPage.peerId} is still in send page - redirecting all non-senders to receive`,
        );

        // Redirect ALL non-sender peers to receive to keep session aligned with active sender
        const peersToRedirect = Array.from(session.peers.values()).filter(
          (p) => p.peerId !== senderInSendPage.peerId && !p.isDisconnected,
        );

        peersToRedirect.forEach((target) => {
          try {
            emitNavigate(io, target.socketId, {
              page: PeerPage.RECEIVE,
              reason: 'sender_in_send_page',
              message: 'A sender is active. You have been redirected to the receive page.',
              sessionId,
              role: target.role,
              peerId: target.peerId,
              forced: true,
            });
            setPeerPage(target, PeerPage.RECEIVE);
            session.peers.set(target.peerId, target);
          } catch (e) {
            logger.error('Failed to redirect peer to receive:', target.peerId, e);
          }
        });
      }

      // 🆕 NEW: Special handling for host entering main page - prepare navigation blocking
      if (peer.role === 'host') {
        logger.info(`🚫 Host ${peerId} entered main page - preparing navigation blocking`);

        // Mark host as on main page (but not permanently locked)
        setPeerPage(peer, PeerPage.SESSION);
        session.peers.set(peerId, peer);

        const otherConnectedPeers = Array.from(session.peers.values()).filter(
          (p) => p.peerId !== peerId && !p.isDisconnected,
        );

        if (otherConnectedPeers.length > 0) {
          logger.info(
            `🚫 Host ${peerId} has ${otherConnectedPeers.length} connected peers - navigation will be blocked if they try to leave`,
          );

          // Don't emit navigation blocked yet - only when they actually try to leave
          // The blocking will happen in the leave-main-page event handler
        } else {
          logger.info(
            `✅ Host ${peerId} entered main page with no other peers - navigation allowed`,
          );
        }
      }

      // Count only verified clients in main
      const clientCount = peersOnPage(session, PeerPage.SESSION).filter(
        (p) => p.role === 'client',
      ).length;

      logger.info(`🔍 Enter main page - Client count in main: ${clientCount}`);
      logger.info(
        `🔍 All peers after enter:`,
        Array.from(session.peers.values()).map(
          (p) => `${p.peerId}(${p.role}, inMain:${p.inMain}, disconnected:${p.isDisconnected})`,
        ),
      );

      io.in(sessionId).emit('peer-count-updated', { count: clientCount });
    });

    // 🚫 NEW: Track when host leaves main page (navigation blocking)
    socket.on('leave-main-page', ({ sessionId, peerId, reason }) => {
      logger.info(`🔍 leave-main-page event received:`, { sessionId, peerId, reason });

      const session = store.sessions.get(sessionId);
      if (!session) {
        logger.info(`❌ Session ${sessionId} not found for leave-main-page`);
        return;
      }

      const peer = session.peers.get(peerId);
      if (!peer) {
        logger.info(`❌ Peer ${peerId} not found in session ${sessionId}`);
        return;
      }

      logger.info(`🔍 Peer details:`, {
        peerId: peer.peerId,
        role: peer.role,
        currentPage: peer.currentPage,
        isDisconnected: peer.isDisconnected,
        socketId: peer.socketId,
      });

      if (peer.role === 'host') {
        logger.info(`🚫 Host ${peerId} attempting to leave main page`);

        // 🆕 NEW: Allow auto-redirects and exits (don't block when reason is provided)
        if (
          reason &&
          (reason === 'auto_redirect_to_send' ||
            reason === 'auto_redirect_to_receive' ||
            reason === 'host_exit_session')
        ) {
          logger.info(`✅ Host ${peerId} ${reason} - allowing navigation`);

          // Update host's page state based on redirect reason
          if (reason === 'auto_redirect_to_send') {
            peer.currentPage = 'send';
          } else if (reason === 'auto_redirect_to_receive') {
            peer.currentPage = 'receive';
          } else if (reason === 'host_exit_session') {
            peer.currentPage = 'index';
          }

          // Update peer state and return
          session.peers.set(peerId, peer);
          logger.info(`✅ Host ${peerId} page state updated to: ${peer.currentPage}`);
          return;
        }

        // 🆕 NEW: Block host navigation from main page if they are currently on main page
        if (peer.currentPage === 'main') {
          logger.info(
            `🚫 Host ${peerId} attempted to leave main page - checking if navigation should be blocked`,
          );

          // Check current connected peers count
          const otherConnectedPeers = Array.from(session.peers.values()).filter(
            (p) => p.peerId !== peerId && !p.isDisconnected,
          );

          logger.info(
            `🔍 Other connected peers:`,
            otherConnectedPeers.map((p) => ({
              peerId: p.peerId,
              role: p.role,
              currentPage: p.currentPage,
            })),
          );

          if (otherConnectedPeers.length > 0) {
            logger.info(
              `🚫 Host ${peerId} attempted to leave main page while ${otherConnectedPeers.length} peers are connected - blocking navigation`,
            );

            // Block the navigation by keeping host on main page
            peer.currentPage = 'main';
            session.peers.set(peerId, peer);

            // Emit warning to host with current peer count
            io.to(peer.socketId).emit('host-navigation-blocked', {
              reason: 'others_connected',
              message: `You cannot leave the main page while ${otherConnectedPeers.length} other user(s) are connected. Please use the Exit button to leave the session.`,
              connectedPeers: otherConnectedPeers.length,
            });

            logger.info(
              `🚫 Navigation blocked for host ${peerId} - kept on main page (${otherConnectedPeers.length} peers connected)`,
            );
            return;
          } else {
            // No other peers connected, allow host to leave
            logger.info(`✅ Host ${peerId} allowed to leave main page - no other peers connected`);

            // Update host's page state
            peer.currentPage = 'index';
            session.peers.set(peerId, peer);

            // Notify host that navigation is allowed
            io.to(peer.socketId).emit('host-navigation-allowed', {
              reason: 'no_peers_connected',
              message: 'No other users are connected. You can now leave the main page.',
              connectedPeers: 0,
            });
            return;
          }
        } else {
          logger.info(
            `⚠️ Host ${peerId} not on main page (currentPage: ${peer.currentPage}) - navigation blocking not applicable`,
          );
        }

        // The navigation blocking logic is now handled above in the currentPage === 'main' check
      } else {
        logger.info(`ℹ️ Non-host peer ${peerId} leaving main page - no navigation blocking`);
      }
    });

    // Explicitly allow a peer to leave the session (used by receivers on Exit)
    socket.on('leave-session', ({ sessionId, peerId }, ack) => {
      const session = store.sessions.get(sessionId);
      if (!session)
        return typeof ack === 'function' && ack({ ok: false, reason: 'session_not_found' });

      handleReceiverExit(session, peerId, io);
      const peer = session.peers.get(peerId);
      if (!peer) {
        try {
          session.exitedPeers && session.exitedPeers.add(peerId);
        } catch (_) {}
        return typeof ack === 'function' && ack({ ok: true });
      }

      // Remove peer and update others
      try {
        session.peers.delete(peerId);
        const connectedPeers = Array.from(session.peers.values()).filter((p) => !p.isDisconnected);
        io.in(sessionId).emit('peers-updated', connectedPeers);

        // If no clients are left, clear the grace timer
        const remainingClients = connectedPeers.filter((p) => p.role !== 'host').length;
        if (remainingClients === 0 && session.graceRedirectEndMs) {
          logger.info(`🧹 Clearing grace timer - last client left session ${sessionId}`);
          clearGraceRedirect(session, io, { notifyHost: true });
        }
      } catch (_) {}

      // Allow peers to rejoin the same session
      // Don't mark as exited - they can reconnect freely

      // Release locks if this peer held any
      try {
        if (session.currentSenderPeerId === peerId) {
          session.currentSenderPeerId = null;
          session.activeTransfer = null;
          io.in(sessionId).emit('transfer-unlocked');
        }
      } catch (_) {}

      // Clear download queue and flags for this peer
      try {
        const sessionDownloadQueue = store.receiverDownloadQueues.get(sessionId);
        if (sessionDownloadQueue) {
          sessionDownloadQueue.delete(peerId);
          if (sessionDownloadQueue.size === 0) store.receiverDownloadQueues.delete(sessionId);
        }
        const sessionDownloadFlags = store.receiverDownloadFlags.get(sessionId);
        if (sessionDownloadFlags) {
          sessionDownloadFlags.delete(peerId);
          if (sessionDownloadFlags.size === 0) store.receiverDownloadFlags.delete(sessionId);
        }
        const sessionActive = store.receiverActiveDownloads.get(sessionId);
        if (sessionActive) {
          sessionActive.delete(peerId);
          if (sessionActive.size === 0) store.receiverActiveDownloads.delete(sessionId);
        }
      } catch (_) {}

      // Remove from room
      try {
        socket.leave(sessionId);
      } catch (_) {}

      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('announce-shutdown', ({ sessionId, peerId } = {}) => {
      if (!isSafeId(sessionId) || !isSafeId(peerId)) {
        return socket.emit('error', { message: 'sessionId and peerId required' });
      }
      if (!assertHostPeer(sessionId, peerId)) {
        return socket.emit('error', { message: 'Only the host may announce shutdown' });
      }
      logger.info(`Host ${peerId} announcing server shutdown for session ${sessionId}`);
      io.emit('server-shutdown');
    });

    socket.on('disconnect', () => {
      const { peerId, sessionId } = socket.data || {};
      logger.info(`Socket ${socket.id} disconnected (peer: ${peerId}, session: ${sessionId})`);

      if (sessionId && peerId) {
        const session = store.sessions.get(sessionId);
        if (session) {
          const peer = session.peers.get(peerId);
          // Only remove if this socket was the active one for this peer
          if (peer && peer.socketId === socket.id) {
            // Mark peer as disconnected but don't remove immediately
            peer.disconnectedAt = Date.now();
            peer.isDisconnected = true;
            logger.info(`Peer ${peerId} marked as disconnected, waiting for reconnection...`);
            handleReceiverExit(session, peerId, io);

            // Set a timeout to remove the peer if they don't reconnect
            const disconnectTimeout = setTimeout(() => {
              const currentPeer = session.peers.get(peerId);
              if (
                currentPeer &&
                currentPeer.isDisconnected &&
                currentPeer.disconnectedAt === peer.disconnectedAt
              ) {
                // Peer still disconnected after timeout, remove them
                session.peers.delete(peerId);
                logger.info(`🗑️ Removed peer ${peerId} from session ${sessionId} after timeout`);
                const connectedPeers = Array.from(session.peers.values()).filter(
                  (p) => !p.isDisconnected,
                );
                io.in(sessionId).emit('peers-updated', connectedPeers);

                // If this peer held the send lock or active transfer, release and unlock
                if (session.currentSenderPeerId === peerId) {
                  session.currentSenderPeerId = null;
                  session.activeTransfer = null;
                  io.in(sessionId).emit('transfer-unlocked');
                }
                // Check for stale locks after a peer disconnects
                checkAndReleaseStaleTransferLocks(sessionId, io);

                // Clear download queue and flags for this peer when they disconnect
                const sessionDownloadQueue = store.receiverDownloadQueues.get(sessionId);
                if (sessionDownloadQueue) {
                  sessionDownloadQueue.delete(peerId);
                  if (sessionDownloadQueue.size === 0) {
                    store.receiverDownloadQueues.delete(sessionId);
                  }
                  logger.info(`Cleared download queue for disconnected peer ${peerId}`);
                }

                // Clear download flags for this peer
                const sessionDownloadFlags = store.receiverDownloadFlags.get(sessionId);
                if (sessionDownloadFlags) {
                  sessionDownloadFlags.delete(peerId);
                  if (sessionDownloadFlags.size === 0) {
                    store.receiverDownloadFlags.delete(sessionId);
                  }
                  logger.info(`Cleared download flags for disconnected peer ${peerId}`);
                }
              }
            }, 10000); // 10 second timeout

            // Store the timeout reference so we can clear it if peer reconnects
            peer.disconnectTimeout = disconnectTimeout;
          }
        }
      }
    });
  });
}
