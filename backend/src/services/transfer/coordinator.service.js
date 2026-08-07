import fs from 'fs';
import path from 'path';
import { RelayDiskStrategy } from './strategies/relay-disk.strategy.js';
import { RelayStreamStrategy } from './strategies/relay-stream.strategy.js';
import { RelayBufferedStrategy } from './strategies/relay-buffered.strategy.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { store } from '../../state/store.js';

export class TransferCoordinatorService {
  constructor(deps) {
    this.deps = deps; // contains { io }
    this.strategies = new Map();
    this.strategies.set('relay-disk', new RelayDiskStrategy(deps));
    this.strategies.set('relay-stream', new RelayStreamStrategy(deps));
    this.strategies.set('relay-buffered', new RelayBufferedStrategy(deps));
  }

  /**
   * Determine the strategy for a transfer.
   */
  resolveStrategy(fileId) {
    if (!fileId) {
      return this.strategies.get('relay-disk');
    }
    const streamStrategy = this.strategies.get('relay-stream');
    if (streamStrategy.activeSessions.has(fileId)) {
      return streamStrategy;
    }
    const bufferedStrategy = this.strategies.get('relay-buffered');
    if (bufferedStrategy.activeSessions.has(fileId)) {
      return bufferedStrategy;
    }
    return this.strategies.get('relay-disk');
  }

  /**
   * Pre-register a streaming session.
   */
  initializeStreamSession(fileId, fileMetadata, expectedReceivers, senderSocketId, session) {
    const defaultStrategy = config.transfer.defaultStrategy;
    if (defaultStrategy === 'relay-buffered') {
      const bufferedStrategy = this.strategies.get('relay-buffered');
      return bufferedStrategy.initializeSession(
        fileId,
        fileMetadata,
        expectedReceivers,
        senderSocketId,
        session,
      );
    }
    const streamStrategy = this.strategies.get('relay-stream');
    return streamStrategy.initializeSession(
      fileId,
      fileMetadata,
      expectedReceivers,
      senderSocketId,
      session,
    );
  }

  /**
   * Get partial upload status for resumable chunked uploads.
   */
  getUploadStatus(sessionId, fileId) {
    const filePath = path.join(config.uploadsDir, `${sessionId}-${fileId}`);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        return { bytesReceived: stat.size };
      } catch (err) {
        logger.error(`Error reading file stat for upload status of ${fileId}:`, err);
      }
    }
    return { bytesReceived: 0 };
  }

  /**
   * Delegate HTTP POST upload to the correct strategy.
   */
  async handleUpload(req, res) {
    const { sessionId } = req.params;
    const session = store.sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Resolve fileId from active transfer or query or header (can be null/undefined for traditional multipart form)
    const fileId = req.headers['x-file-id'] || req.query.fileId || session.activeTransfer?.fileId;

    const strategy = this.resolveStrategy(fileId);
    logger.info(`🎯 Delegating upload using strategy: ${strategy.constructor.name}`);
    return strategy.handleUpload(req, res, session, fileId);
  }

  /**
   * Delegate HTTP GET download to the correct strategy.
   */
  async handleDownload(req, res) {
    const { sessionId, fileId } = req.params;
    const receiverPeerId = req.query.receiver;

    const session = store.sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const strategy = this.resolveStrategy(fileId);
    logger.info(
      `🎯 Delegating download for file ${fileId} using strategy: ${strategy.constructor.name}`,
    );
    return strategy.handleDownload(req, res, session, fileId, receiverPeerId);
  }
}

// Singleton coordinator instance that will be initialized on startup
let coordinatorInstance = null;

export function initializeTransferCoordinator(deps) {
  coordinatorInstance = new TransferCoordinatorService(deps);
  return coordinatorInstance;
}

export function getTransferCoordinator() {
  if (!coordinatorInstance) {
    throw new Error('Transfer coordinator not initialized');
  }
  return coordinatorInstance;
}
