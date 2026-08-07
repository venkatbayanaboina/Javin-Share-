import fs from 'fs';
import path from 'path';
import Busboy from 'busboy';
import { TransferStrategy } from './transfer-strategy.js';
import { config } from '../../../config.js';
import { logger } from '../../../logger.js';
import { sanitizeFilename, contentDispositionAttachment } from '../../../utils/filename.js';
import { isSafeId } from '../../../utils/ids.js';
import {
  decrementPendingDownloads,
  progressReceiverDownloadQueue,
} from '../../download-queue.service.js';

export class RelayDiskStrategy extends TransferStrategy {
  constructor(deps) {
    super();
    this.deps = deps; // contains io socket server
  }

  async handleUpload(req, res, session, fileId) {
    const sessionId = session.id;

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: config.maxUploadBytes,
      },
    });

    let uploadedFileId = fileId;
    let writeStream;
    let fileMetadata;
    let uploadRejected = false;
    let bytesWritten = 0;

    // Check if we are resuming (appending)
    const headerOffset = req.headers['x-upload-offset'] || req.headers['upload-offset'];
    const queryOffset = req.query.offset;
    const clientOffset = parseInt(headerOffset || queryOffset || '0', 10);

    const tempPath = path.join(
      config.uploadsDir,
      `${sessionId}-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    let finalized = false;
    let busboyFinished = false;

    const partialBytesOnDisk = () => {
      if (bytesWritten > 0) return true;
      try {
        return fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0;
      } catch (_) {
        return false;
      }
    };

    const persistPartialUpload = () => {
      if (uploadRejected || finalized || busboyFinished) return;

      const doPersist = () => {
        const resolvedFileId = uploadedFileId || fileId;
        if (!resolvedFileId) return;
        const filePath = path.join(config.uploadsDir, `${sessionId}-${resolvedFileId}`);

        try {
          if (clientOffset === 0 && fs.existsSync(tempPath)) {
            const size = fs.statSync(tempPath).size;
            if (size > 0) {
              if (!fs.existsSync(filePath)) {
                fs.renameSync(tempPath, filePath);
              }
              session.activeFiles.set(resolvedFileId, {
                id: resolvedFileId,
                name: sanitizeFilename(fileMetadata?.name || 'partial.bin'),
                type: fileMetadata?.type || 'application/octet-stream',
                path: filePath,
                size,
              });
              logger.info(
                `Persisted partial upload ${resolvedFileId}: ${size} bytes after disconnect`,
              );
            }
          } else if (clientOffset > 0 && fs.existsSync(filePath)) {
            const size = fs.statSync(filePath).size;
            if (fileMetadata) {
              fileMetadata.size = size;
              session.activeFiles.set(resolvedFileId, fileMetadata);
            }
          }
        } catch (e) {
          logger.error('Failed to persist partial upload:', e);
        }
      };

      if (writeStream && !writeStream.writableEnded) {
        writeStream.end(doPersist);
      } else {
        doPersist();
      }
    };

    const rejectUpload = (status, message, extra = {}) => {
      if (uploadRejected) return;
      uploadRejected = true;
      try {
        if (writeStream) writeStream.destroy();
      } catch (_) {}

      if (clientOffset === 0) {
        try {
          if (!partialBytesOnDisk() && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (e) {
          logger.error('Failed to cleanup rejected upload temp file:', e);
        }
      }

      if (!res.headersSent) res.status(status).json({ error: message, ...extra });
      req.unpipe(busboy);
    };

    req.on('aborted', persistPartialUpload);
    req.on('close', () => {
      if (!finalized && !uploadRejected) persistPartialUpload();
    });
    res.on('close', () => {
      if (!res.writableEnded) persistPartialUpload();
    });

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'fileId' && isSafeId(val)) {
        uploadedFileId = val;
      }
    });

    busboy.on('file', (_fieldname, file, info) => {
      if (uploadRejected) {
        file.resume();
        return;
      }

      const resolvedFileId = uploadedFileId || fileId;
      if (!resolvedFileId && clientOffset > 0) {
        return rejectUpload(400, 'fileId is required for resumable uploads');
      }

      const filePath = path.join(config.uploadsDir, `${sessionId}-${resolvedFileId}`);
      const actualFileWritePath = clientOffset > 0 ? filePath : tempPath;
      const writeFlags = clientOffset > 0 ? 'a' : 'w';

      if (clientOffset > 0) {
        if (!fs.existsSync(filePath)) {
          return rejectUpload(409, 'Cannot resume, target file does not exist');
        }
        const existingSize = fs.statSync(filePath).size;
        if (existingSize !== clientOffset) {
          logger.warn(
            `Resume size mismatch: Client offset ${clientOffset}, existing size ${existingSize}`,
          );
          return rejectUpload(409, 'Resume offset mismatch', { bytesReceived: existingSize });
        }
        bytesWritten = existingSize;
      }

      const safeName = sanitizeFilename(info.filename);

      try {
        writeStream = fs.createWriteStream(actualFileWritePath, { flags: writeFlags });
        writeStream.on('error', (err) => {
          logger.error('Write stream error:', err);
          rejectUpload(500, 'Failed to write file to disk');
        });
      } catch (err) {
        logger.error('Failed to create disk write stream:', err);
        return rejectUpload(500, 'Failed to prepare write destination');
      }

      fileMetadata = {
        id: resolvedFileId,
        name: safeName,
        type: info.mimeType || 'application/octet-stream',
        path: filePath,
        size:
          clientOffset > 0 && session.activeFiles.has(resolvedFileId)
            ? session.activeFiles.get(resolvedFileId).size
            : 0,
      };

      file.on('data', (chunk) => {
        bytesWritten += chunk.length;
        if (bytesWritten > config.maxUploadBytes) {
          rejectUpload(413, `File exceeds maximum size of ${config.maxUploadBytes} bytes`);
          file.resume();
        } else {
          fileMetadata.size = bytesWritten;
          const ok = writeStream.write(chunk);
          if (!ok) {
            file.pause();
            writeStream.once('drain', () => file.resume());
          }
        }
      });

      file.on('limit', () => {
        rejectUpload(413, `File exceeds maximum size of ${config.maxUploadBytes} bytes`);
      });

      file.on('error', (err) => {
        logger.warn('Upload stream error (may be client disconnect):', err.message);
        setImmediate(() => {
          if (partialBytesOnDisk()) persistPartialUpload();
          else if (!uploadRejected && !finalized) rejectUpload(500, 'Upload failed');
        });
      });
    });

    busboy.on('error', (err) => {
      logger.warn('Busboy error (may be client disconnect):', err.message);
      setImmediate(() => {
        if (partialBytesOnDisk()) persistPartialUpload();
        else if (!uploadRejected && !finalized) rejectUpload(400, 'Invalid upload');
      });
    });

    busboy.on('finish', () => {
      busboyFinished = true;
      if (uploadRejected) return;

      const resolvedFileId = uploadedFileId || fileId;
      if (!resolvedFileId) {
        try {
          if (writeStream) writeStream.destroy();
        } catch (_) {}
        if (clientOffset === 0) {
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch (_) {}
        }
        return res.status(400).json({ error: 'Missing or invalid fileId' });
      }

      if (writeStream) {
        writeStream.end(() => {
          finalizeUpload(resolvedFileId);
        });
      } else {
        finalizeUpload(resolvedFileId);
      }
    });

    const finalizeUpload = (resolvedFileId) => {
      finalized = true;
      try {
        const filePath = path.join(config.uploadsDir, `${sessionId}-${resolvedFileId}`);
        if (clientOffset === 0) {
          if (fs.existsSync(tempPath)) {
            fs.renameSync(tempPath, filePath);
          }
        }

        const finalSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

        if (!fileMetadata) {
          fileMetadata = {
            id: resolvedFileId,
            name: 'unknown',
            type: 'application/octet-stream',
            path: filePath,
            size: finalSize,
          };
        }

        fileMetadata.id = resolvedFileId;
        fileMetadata.path = filePath;
        fileMetadata.name = sanitizeFilename(fileMetadata.name);
        fileMetadata.size = finalSize;

        session.activeFiles.set(resolvedFileId, fileMetadata);
        res.json({ success: true, fileId: resolvedFileId, bytesReceived: finalSize });
      } catch (e) {
        logger.error('Failed to finalize upload file path:', e);
        if (clientOffset === 0) {
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch (_) {}
        }
        if (!res.headersSent) res.status(500).json({ error: 'Failed to save file' });
      }
    };

    req.pipe(busboy);
  }

  async handleDownload(req, res, session, fileId, receiverPeerId) {
    const sessionId = session.id;
    const fileMetadata = session.activeFiles.get(fileId);

    if (!fileMetadata || !fs.existsSync(fileMetadata.path)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const expectedPath = path.resolve(path.join(config.uploadsDir, `${sessionId}-${fileId}`));
    const resolved = path.resolve(fileMetadata.path);
    if (resolved !== expectedPath) {
      logger.warn(`Download path mismatch for ${fileId} in ${sessionId}`);
      return res.status(403).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fileMetadata.path);
    const fileSize = stat.size;
    const range = req.headers.range;

    let readStream;

    let cleanedUp = false;
    const cleanupDownload = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        decrementPendingDownloads(fileMetadata, session, fileId);
        progressReceiverDownloadQueue(sessionId, receiverPeerId, this.deps.io);
      } catch (e) {
        logger.error('Post-download cleanup error:', e);
      }
    };

    res.on('finish', cleanupDownload);

    res.on('close', () => {
      try {
        if (readStream) readStream.destroy();
      } catch (_) {}
      cleanupDownload();
    });

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.end();
      }

      const chunksize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunksize);
      res.setHeader('Content-Type', fileMetadata.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDispositionAttachment(fileMetadata.name));

      readStream = fs.createReadStream(fileMetadata.path, { start, end });
    } else {
      res.status(200);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Content-Type', fileMetadata.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDispositionAttachment(fileMetadata.name));

      readStream = fs.createReadStream(fileMetadata.path);
    }

    let bytesSent = 0;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      bytesSent = isNaN(start) ? 0 : start;
    }

    let lastProgressEmitTime = 0;
    readStream.on('data', (chunk) => {
      bytesSent += chunk.length;
      const now = Date.now();
      if (now - lastProgressEmitTime >= 150 || bytesSent === fileSize) {
        lastProgressEmitTime = now;
        try {
          this.deps.io.in(sessionId).emit('download-progress', {
            fileId,
            receiverPeerId,
            loaded: bytesSent,
            total: fileSize,
          });
        } catch (e) {
          logger.error('Failed to emit download progress:', e);
        }
      }
    });

    readStream.on('error', (err) => {
      logger.error('File read stream error:', err);
      if (!res.headersSent) res.status(500).end('File read error');
    });

    readStream.pipe(res);
  }
}
