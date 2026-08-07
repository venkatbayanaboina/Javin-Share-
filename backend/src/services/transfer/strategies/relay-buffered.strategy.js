import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
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

class BufferedRelaySession extends BaseStreamSession {
  constructor(fileId, fileMetadata, expectedReceivers, senderSocketId) {
    super(fileId, fileMetadata, expectedReceivers, senderSocketId);
    this.spooled = false;
    this.tempPath = null;
    this.writeStream = null;
    this.memoryBuffer = []; // array of Buffer chunks
    this.totalBytes = 0;
    this.catchingUpReceivers = new Map(); // receiverPeerId -> { branch, queue, spooledBytesAtStart }
  }
}

export class RelayBufferedStrategy extends BaseStreamStrategy {
  constructor(deps) {
    super(deps);
  }

  initializeSession(fileId, fileMetadata, expectedReceivers, senderSocketId, session) {
    const streamSession = new BufferedRelaySession(
      fileId,
      fileMetadata,
      expectedReceivers,
      senderSocketId,
    );
    this.activeSessions.set(fileId, streamSession);

    logger.info(
      `📦 Buffered session initialized for file ${fileId} with expected receivers:`,
      Array.from(expectedReceivers),
    );

    streamSession.timeoutTimer = setTimeout(() => {
      logger.info(`⏰ Buffered timeout fired for file ${fileId}. Triggering upload.`);
      this.triggerUpload(streamSession, session);
    }, config.transfer.streamRelayTimeoutMs || 30000);

    return streamSession;
  }

  writeChunkToBranches(streamSession, chunk, uploadFileStream, enableBackpressure = false) {
    const maxBufferSize = config.transfer.maxReceiverBufferSize || 16 * 1024 * 1024;

    let paused = false;
    for (const [peerId, branch] of streamSession.branches.entries()) {
      if (branch.destroyed || branch.writableEnded) {
        streamSession.branches.delete(peerId);
        continue;
      }

      if (branch.writableLength > maxBufferSize) {
        logger.warn(
          `⚠️ Receiver ${peerId} is stalled (buffer size ${branch.writableLength} bytes > limit). Dropping branch.`,
        );
        branch.destroy(new Error('Receiver stalled / buffer overflowed'));
        streamSession.branches.delete(peerId);
        continue;
      }

      const ok = branch.write(chunk);
      if (!ok && enableBackpressure) {
        paused = true;
      }
    }

    if (streamSession.catchingUpReceivers) {
      for (const [peerId, catchingUp] of streamSession.catchingUpReceivers.entries()) {
        const branch = catchingUp.branch;
        if (branch.destroyed || branch.writableEnded) {
          streamSession.catchingUpReceivers.delete(peerId);
          continue;
        }

        const totalQueueBytes = catchingUp.queue.reduce((acc, c) => acc + c.length, 0);
        if (branch.writableLength + totalQueueBytes > maxBufferSize) {
          logger.warn(
            `⚠️ Catching-up receiver ${peerId} is stalled (buffer size + queue ${branch.writableLength + totalQueueBytes} bytes > limit). Dropping branch.`,
          );
          branch.destroy(new Error('Receiver stalled / buffer overflowed'));
          streamSession.catchingUpReceivers.delete(peerId);
          continue;
        }

        catchingUp.queue.push(chunk);
      }
    }

    if (paused && uploadFileStream && !streamSession.uploadSourcePaused) {
      streamSession.uploadSourcePaused = true;
      uploadFileStream.pause();
      const onDrain = () => {
        let allReady = true;
        for (const branch of streamSession.branches.values()) {
          if (!branch.destroyed && branch.writableNeedDrain) {
            allReady = false;
            break;
          }
        }
        if (allReady) {
          streamSession.uploadSourcePaused = false;
          uploadFileStream.resume();
        }
      };
      for (const branch of streamSession.branches.values()) {
        branch.once('drain', onDrain);
      }
    }
  }

  async handleUpload(req, res, session, fileId) {
    const streamSession = this.activeSessions.get(fileId);
    if (!streamSession) {
      logger.error(`❌ Buffered session not found during upload of ${fileId}`);
      return res.status(404).json({ error: 'Buffered session not found' });
    }

    logger.info(`📤 Received upload POST request for buffered file ${fileId}`);

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: config.maxUploadBytes },
    });

    let fileFound = false;
    let bytesReceived = 0;

    busboy.on('file', (_fieldname, file, info) => {
      fileFound = true;
      logger.info(`🌊 Spool-monitoring upload stream for: ${info.filename}`);

      file.on('data', (chunk) => {
        bytesReceived += chunk.length;
        streamSession.totalBytes = bytesReceived;

        const limit = config.transfer.spoolThresholdBytes || 256 * 1024 * 1024;
        if (!streamSession.spooled && bytesReceived > limit) {
          streamSession.spooled = true;
          streamSession.tempPath = path.join(config.uploadsDir, `spool-${session.id}-${fileId}`);
          logger.info(
            `💾 Spooling threshold reached (${limit} bytes). Spilling buffer to disk: ${streamSession.tempPath}`,
          );
          try {
            streamSession.writeStream = fs.createWriteStream(streamSession.tempPath);
            for (const memChunk of streamSession.memoryBuffer) {
              streamSession.writeStream.write(memChunk);
            }
            streamSession.memoryBuffer = []; // clear RAM
          } catch (err) {
            logger.error('Failed to create spool disk write stream:', err);
          }
        }

        if (streamSession.spooled && streamSession.writeStream) {
          streamSession.writeStream.write(chunk);
        } else {
          streamSession.memoryBuffer.push(chunk);
        }

        const enableBackpressure = config.transfer.enableBufferedBackpressure === true;
        this.writeChunkToBranches(streamSession, chunk, file, enableBackpressure);
      });

      file.on('end', () => {
        logger.info(
          `📥 Sender completed file chunks for buffered file ${fileId}. Bytes: ${bytesReceived}`,
        );
      });

      file.on('error', (err) => {
        logger.error('Buffered upload chunk error:', err);
        this.destroyAllBranches(streamSession);
        if (streamSession.writeStream) {
          try {
            streamSession.writeStream.destroy();
          } catch (_) {}
        }
        if (streamSession.tempPath && fs.existsSync(streamSession.tempPath)) {
          try {
            fs.unlinkSync(streamSession.tempPath);
          } catch (_) {}
        }
        this.activeSessions.delete(fileId);
        if (!res.headersSent) res.status(500).json({ error: 'Upload buffered streaming failed' });
      });
    });

    busboy.on('finish', () => {
      if (!fileFound) {
        this.destroyAllBranches(streamSession);
        this.activeSessions.delete(fileId);
        return res.status(400).json({ error: 'No file uploaded' });
      }

      logger.info(`🏁 Busboy upload finished for buffered session ${fileId}. Finalizing.`);

      const finalPath = streamSession.spooled ? streamSession.tempPath : 'in-memory-buffered';
      const finalMetadata = {
        id: fileId,
        name: sanitizeFilename(streamSession.fileMetadata.name),
        type: streamSession.fileMetadata.type || 'application/octet-stream',
        path: finalPath,
        size: bytesReceived,
        pending: streamSession.downloads.size,
      };
      session.activeFiles.set(fileId, finalMetadata);
      streamSession.fileMetadata = finalMetadata;
      streamSession.uploadCompleted = true;

      const finalize = () => {
        if (!res.headersSent) {
          res.json({ success: true, fileId, bytesReceived });
        }
        this.activeSessions.delete(fileId);
      };

      if (streamSession.writeStream) {
        streamSession.writeStream.end(() => {
          this.endAllBranches(streamSession);
          finalize();
        });
      } else {
        this.endAllBranches(streamSession);
        finalize();
      }
    });

    req.on('error', (err) => {
      logger.error('Upload request stream error:', err);
      this.destroyAllBranches(streamSession);
      this.activeSessions.delete(fileId);
    });

    req.pipe(busboy);
  }

  destroyAllBranches(streamSession) {
    super.destroyAllBranches(streamSession);
    if (streamSession.catchingUpReceivers) {
      for (const catchingUp of streamSession.catchingUpReceivers.values()) {
        try {
          catchingUp.branch.destroy();
        } catch (_) {}
      }
      streamSession.catchingUpReceivers.clear();
    }
  }

  async handleDownload(req, res, session, fileId, receiverPeerId) {
    const streamSession = this.activeSessions.get(fileId);
    if (!streamSession) {
      // Fallback: If upload completed and file was spooled on disk, serve it like a disk file
      const fileMetadata = session.activeFiles.get(fileId);
      if (
        fileMetadata &&
        fileMetadata.path !== 'in-memory-buffered' &&
        fs.existsSync(fileMetadata.path)
      ) {
        logger.info(
          `📥 Lagging receiver ${receiverPeerId} downloading completed spooled file from disk`,
        );
        return this.serveCompletedSpooledFile(req, res, session, fileMetadata, receiverPeerId);
      }

      logger.error(`❌ Buffered session not found during download of ${fileId}`);
      return res.status(404).json({ error: 'Buffered session not found' });
    }

    logger.info(`📥 Receiver ${receiverPeerId} connected to buffered download`);

    streamSession.connectedReceivers.add(receiverPeerId);
    streamSession.downloads.set(receiverPeerId, res);

    const branch = new PassThrough({ highWaterMark: chunkHighWaterMark() });

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

    let fileStream = null;

    // If spooled, feed existing spooled file chunks to this branch first (asynchronously via backpressured pipe)
    if (streamSession.spooled && streamSession.tempPath && fs.existsSync(streamSession.tempPath)) {
      const spooledBytesAtStart = streamSession.totalBytes;
      streamSession.catchingUpReceivers.set(receiverPeerId, {
        branch,
        queue: [],
        spooledBytesAtStart,
      });

      fileStream = fs.createReadStream(streamSession.tempPath, {
        end: Math.max(0, spooledBytesAtStart - 1),
      });
      fileStream.pipe(branch, { end: false });

      fileStream.on('end', () => {
        const catchingUp = streamSession.catchingUpReceivers.get(receiverPeerId);
        if (catchingUp) {
          logger.info(
            `🔄 Lagging receiver ${receiverPeerId} caught up on spooled disk bytes. Flushing live queue.`,
          );
          for (const chunk of catchingUp.queue) {
            if (!branch.destroyed && !branch.writableEnded) {
              branch.write(chunk);
            }
          }
          // Promote to active branch mapping
          streamSession.branches.set(receiverPeerId, branch);
          streamSession.catchingUpReceivers.delete(receiverPeerId);

          if (streamSession.uploadCompleted && !branch.writableEnded && !branch.destroyed) {
            branch.end();
          }
        }
      });

      fileStream.on('error', (err) => {
        logger.error(`Error reading spooled chunks for lagging receiver ${receiverPeerId}:`, err);
        branch.destroy(err);
      });
    } else {
      // Feed memory buffer chunks directly to this branch
      for (const chunk of streamSession.memoryBuffer) {
        branch.write(chunk);
      }
      streamSession.branches.set(receiverPeerId, branch);
    }

    let cleanedUp = false;
    const cleanupDownload = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      streamSession.downloads.delete(receiverPeerId);

      if (fileStream) {
        try {
          fileStream.destroy();
        } catch (_) {}
      }

      const b = streamSession.branches.get(receiverPeerId);
      if (b && !b.destroyed) {
        try {
          b.destroy();
        } catch (_) {}
      }
      streamSession.branches.delete(receiverPeerId);

      if (streamSession.catchingUpReceivers) {
        const catchingUp = streamSession.catchingUpReceivers.get(receiverPeerId);
        if (catchingUp && catchingUp.branch && !catchingUp.branch.destroyed) {
          try {
            catchingUp.branch.destroy();
          } catch (_) {}
        }
        streamSession.catchingUpReceivers.delete(receiverPeerId);
      }

      try {
        const meta = session.activeFiles.get(fileId) || streamSession.fileMetadata;
        decrementPendingDownloads(meta, session, fileId);
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
          `⚠️ All active downloads closed during buffered upload of ${fileId}. Aborting.`,
        );
        this.destroyAllBranches(streamSession);
        if (streamSession.writeStream) {
          try {
            streamSession.writeStream.destroy();
          } catch (_) {}
        }
        if (streamSession.tempPath && fs.existsSync(streamSession.tempPath)) {
          try {
            fs.unlinkSync(streamSession.tempPath);
          } catch (_) {}
        }
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

  async serveCompletedSpooledFile(req, res, session, fileMetadata, receiverPeerId) {
    const stat = fs.statSync(fileMetadata.path);
    const fileSize = stat.size;

    res.status(200);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Type', fileMetadata.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDispositionAttachment(fileMetadata.name));

    const readStream = fs.createReadStream(fileMetadata.path);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        decrementPendingDownloads(fileMetadata, session, fileMetadata.id);
        progressReceiverDownloadQueue(session.id, receiverPeerId, this.deps.io);
      } catch (e) {
        logger.error('Spooled download cleanup error:', e);
      }
    };

    res.on('finish', cleanup);
    res.on('close', () => {
      try {
        readStream.destroy();
      } catch (_) {}
      cleanup();
    });

    readStream.pipe(res);
  }
}
