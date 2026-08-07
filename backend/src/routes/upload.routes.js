import { Router } from 'express';
import { logger } from '../logger.js';
import { isSafeId } from '../utils/ids.js';
import { getTransferCoordinator } from '../services/transfer/coordinator.service.js';

export function createUploadRouter() {
  const router = Router();

  // Endpoint to check resumable upload status (returns bytes already written)
  router.get('/api/v1/upload/status/:sessionId/:fileId', (req, res) => {
    const { sessionId, fileId } = req.params;
    if (!isSafeId(sessionId) || !isSafeId(fileId)) {
      return res.status(400).json({ error: 'Invalid session or file id' });
    }

    try {
      const coordinator = getTransferCoordinator();
      const status = coordinator.getUploadStatus(sessionId, fileId);
      logger.info(
        `ℹ️ Resumable upload query for ${fileId} in session ${sessionId}: ${status.bytesReceived} bytes received so far.`,
      );
      res.json(status);
    } catch (err) {
      logger.error('Error retrieving upload status:', err);
      res.status(500).json({ error: 'Failed to retrieve upload status' });
    }
  });

  router.post('/upload/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!isSafeId(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    getTransferCoordinator()
      .handleUpload(req, res)
      .catch((err) => {
        logger.error('Upload route delegation error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Upload delegation failed' });
        }
      });
  });

  return router;
}
