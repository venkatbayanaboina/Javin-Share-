import { PassThrough } from 'node:stream';
import { TransferStrategy } from './transfer-strategy.js';
import { config } from '../../../config.js';
import { logger } from '../../../logger.js';

export const chunkHighWaterMark = () => config.transfer.chunkSizeBytes || 8 * 1024 * 1024;

export class BaseStreamSession {
  constructor(fileId, fileMetadata, expectedReceivers, senderSocketId) {
    this.fileId = fileId;
    this.fileMetadata = fileMetadata;
    this.expectedReceivers = new Set(expectedReceivers);
    this.connectedReceivers = new Set();
    this.senderSocketId = senderSocketId;
    /** @type {Map<string, import('http').ServerResponse>} */
    this.downloads = new Map();
    /** @type {Map<string, PassThrough>} */
    this.branches = new Map();
    this.uploadStarted = false;
    this.uploadCompleted = false;
    this.timeoutTimer = null;
    this.uploadSourcePaused = false;
  }
}

export class BaseStreamStrategy extends TransferStrategy {
  constructor(deps) {
    super();
    this.deps = deps; // contains { io }
    this.activeSessions = new Map(); // fileId -> BaseStreamSession
  }

  /**
   * Helper to trigger sender and receiver upload events.
   */
  triggerUpload(streamSession, session) {
    if (streamSession.uploadStarted) return;
    streamSession.uploadStarted = true;
    if (streamSession.timeoutTimer) {
      clearTimeout(streamSession.timeoutTimer);
      streamSession.timeoutTimer = null;
    }

    if (streamSession.downloads.size === 0) {
      logger.warn(
        `❌ No receivers connected in time for transfer ${streamSession.fileId}. Canceling.`,
      );
      this.deps.io.to(streamSession.senderSocketId).emit('send-rejected', {
        fileId: streamSession.fileId,
        reason: 'No receivers accepted and connected to download the file.',
      });
      this.activeSessions.delete(streamSession.fileId);
      session.activeTransfer = null;
      session.currentSenderPeerId = null;
      this.deps.io.in(session.id).emit('transfer-unlocked');
      return;
    }

    logger.info(
      `🚀 Triggering start-upload for sender socket ${streamSession.senderSocketId} (${streamSession.downloads.size} active receiver(s) connected)`,
    );

    this.deps.io
      .to(streamSession.senderSocketId)
      .emit('start-upload', { fileId: streamSession.fileId });

    for (const receiverPeerId of streamSession.downloads.keys()) {
      const receiver = session.peers.get(receiverPeerId);
      if (receiver) {
        this.deps.io.to(receiver.socketId).emit('upload-started', { fileId: streamSession.fileId });
      }
    }
  }

  /**
   * Check if all receivers connected, triggering upload if so.
   */
  checkAndTriggerUpload(streamSession, session) {
    const allConnected = Array.from(streamSession.expectedReceivers).every((peerId) =>
      streamSession.connectedReceivers.has(peerId),
    );

    if (allConnected && !streamSession.uploadStarted) {
      logger.info(
        `✅ All expected receivers connected for file ${streamSession.fileId}. Triggering upload immediately.`,
      );
      this.triggerUpload(streamSession, session);
    }
  }

  /**
   * Fan-out a chunk to all receiver branch PassThrough streams, handling backpressure.
   */
  writeChunkToBranches(streamSession, chunk, uploadFileStream, enableBackpressure = true) {
    let paused = false;
    for (const branch of streamSession.branches.values()) {
      if (branch.destroyed || branch.writableEnded) continue;
      const ok = branch.write(chunk);
      if (!ok && enableBackpressure) paused = true;
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

  /**
   * Gracefully close all branch streams.
   */
  endAllBranches(streamSession) {
    for (const branch of streamSession.branches.values()) {
      if (!branch.writableEnded && !branch.destroyed) {
        branch.end();
      }
    }
  }

  /**
   * Forcefully destroy all branches.
   */
  destroyAllBranches(streamSession) {
    for (const branch of streamSession.branches.values()) {
      try {
        branch.destroy();
      } catch (_) {}
    }
    streamSession.branches.clear();
  }
}
