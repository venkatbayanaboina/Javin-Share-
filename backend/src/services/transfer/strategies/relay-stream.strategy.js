import { PassThrough } from 'node:stream';
import Busboy from 'busboy';
import {
  BaseStreamStrategy,
  BaseStreamSession,
  chunkHighWaterMark,
} from './base-stream.strategy.js';
import { config } from '../../../config.js';
import { logger } from '../../../logger.js';
import { contentDispositionAttachment, sanitizeFilename } from '../../../utils/filename.js';
import {
  decrementPendingDownloads,
  progressReceiverDownloadQueue,
} from '../../download-queue.service.js';

export class RelayStreamStrategy extends BaseStreamStrategy {
  constructor(deps) {
    super(deps);
  }

  initializeSession(fileId, fileMetadata, expectedReceivers, senderSocketId, session) {
    const streamSession = new BaseStreamSession(
      fileId,
      fileMetadata,
      expectedReceivers,
      senderSocketId,
    );
    this.activeSessions.set(fileId, streamSession);

    logger.info(
      `🌊 Stream session initialized for file ${fileId} with expected receivers:`,
      Array.from(expectedReceivers),
    );

    streamSession.timeoutTimer = setTimeout(() => {
      logger.info(`⏰ Stream timeout fired for file ${fileId}. Triggering upload.`);
      this.triggerUpload(streamSession, session);
    }, config.transfer.streamRelayTimeoutMs || 30000);

    return streamSession;
  }

  async handleUpload(req, res, session, fileId) {
    const streamSession = this.activeSessions.get(fileId);
    if (!streamSession) {
      logger.error(`❌ Stream session not found during upload of ${fileId}`);
      return res.status(404).json({ error: 'Stream session not found' });
    }

    logger.info(`📤 Received upload POST request for stream file ${fileId}`);

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: config.maxUploadBytes },
    });

    let fileFound = false;
    let bytesReceived = 0;

    busboy.on('file', (_fieldname, file, info) => {
      fileFound = true;
      logger.info(`🌊 Streaming chunks directly to receiver branches: ${info.filename}`);

      file.on('data', (chunk) => {
        bytesReceived += chunk.length;
        this.writeChunkToBranches(streamSession, chunk, req, true);
      });

      file.on('end', () => {
        logger.info(
          `📥 Sender completed file chunks for stream file ${fileId}. Bytes: ${bytesReceived}`,
        );
      });

      file.on('error', (err) => {
        logger.error('Stream upload chunk error:', err);
        this.destroyAllBranches(streamSession);
        if (!res.headersSent) res.status(500).json({ error: 'Upload streaming failed' });
      });
    });

    busboy.on('finish', () => {
      if (!fileFound) {
        this.destroyAllBranches(streamSession);
        this.activeSessions.delete(fileId);
        return res.status(400).json({ error: 'No file uploaded' });
      }

      logger.info(`🏁 Busboy upload finished for stream ${fileId}. Finalizing streams.`);

      const finalMetadata = {
        id: fileId,
        name: sanitizeFilename(streamSession.fileMetadata.name),
        type: streamSession.fileMetadata.type || 'application/octet-stream',
        path: 'in-memory-stream',
        size: bytesReceived,
        pending: streamSession.downloads.size,
      };
      session.activeFiles.set(fileId, finalMetadata);
      streamSession.fileMetadata = finalMetadata;
      streamSession.uploadCompleted = true;
      this.endAllBranches(streamSession);

      res.json({ success: true, fileId, bytesReceived });
      this.activeSessions.delete(fileId);
    });

    req.on('error', (err) => {
      logger.error('Upload request stream error:', err);
      this.destroyAllBranches(streamSession);
      this.activeSessions.delete(fileId);
    });

    req.pipe(busboy);
  }

  async handleDownload(req, res, session, fileId, receiverPeerId) {
    const streamSession = this.activeSessions.get(fileId);
    if (!streamSession) {
      logger.error(`❌ Stream session not found during download of ${fileId}`);
      return res.status(404).json({ error: 'Stream session not found' });
    }

    logger.info(`📥 Receiver ${receiverPeerId} connected to stream download`);

    streamSession.connectedReceivers.add(receiverPeerId);
    streamSession.downloads.set(receiverPeerId, res);

    const branch = new PassThrough({ highWaterMark: chunkHighWaterMark() });
    streamSession.branches.set(receiverPeerId, branch);

    res.status(200);
    res.setHeader('Content-Type', streamSession.fileMetadata.type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      contentDispositionAttachment(streamSession.fileMetadata.name),
    );
    if (
      typeof streamSession.fileMetadata.size === 'number' &&
      Number.isFinite(streamSession.fileMetadata.size)
    ) {
      res.setHeader('Content-Length', streamSession.fileMetadata.size);
    }
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    branch.pipe(res);

    let cleanedUp = false;
    const cleanupDownload = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      streamSession.downloads.delete(receiverPeerId);
      const b = streamSession.branches.get(receiverPeerId);
      if (b && !b.destroyed) {
        try {
          b.destroy();
        } catch (_) {}
      }
      streamSession.branches.delete(receiverPeerId);
      try {
        const meta = session.activeFiles.get(fileId) || streamSession.fileMetadata;
        if (meta?.path === 'in-memory-stream') {
          decrementPendingDownloads(meta, session, fileId);
        }
        progressReceiverDownloadQueue(session.id, receiverPeerId, this.deps.io);
      } catch (err) {
        logger.error('Post-download cleanup error:', err);
      }
    };

    res.on('close', () => {
      logger.info(`Receiver ${receiverPeerId} download stream closed/aborted`);
      cleanupDownload();

      if (
        streamSession.downloads.size === 0 &&
        streamSession.uploadStarted &&
        !streamSession.uploadCompleted
      ) {
        logger.warn(
          `⚠️ All active downloads closed during stream upload of ${fileId}. Aborting stream.`,
        );
        this.destroyAllBranches(streamSession);
        this.activeSessions.delete(fileId);
        session.activeTransfer = null;
        session.currentSenderPeerId = null;
        this.deps.io.in(session.id).emit('transfer-unlocked');
      }
    });

    res.on('finish', () => {
      logger.info(`Receiver ${receiverPeerId} download stream finished successfully`);
      cleanupDownload();
    });

    this.checkAndTriggerUpload(streamSession, session);
  }
}
