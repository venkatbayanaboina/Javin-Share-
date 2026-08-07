import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { config } from '../../src/config.js';
import { store } from '../../src/state/store.js';
import { createSession } from '../../src/services/session.service.js';
import { createTestApp } from '../helpers/test-app.mjs';
import { resetStoreForTests, ensureUploadsDir, cleanUploadsDir } from '../helpers/reset-store.mjs';
import { getTransferCoordinator } from '../../src/services/transfer/coordinator.service.js';

describe('Transfer Optimization Integration Tests', () => {
  let app;
  let io;
  let sessionId;
  const fileId = 'peer1-test-file-123';
  const fileMetadata = {
    id: fileId,
    name: 'large_test.txt',
    size: 20,
    type: 'text/plain',
  };

  const originalUploadsDir = config.uploadsDir;
  const testUploadsDir = path.join(originalUploadsDir, 'transfer-optimization-test');

  beforeEach(async () => {
    resetStoreForTests();
    config.uploadsDir = testUploadsDir;
    ensureUploadsDir(testUploadsDir);
    cleanUploadsDir(testUploadsDir);

    // Default to relay-disk for disk tests, we will flip to relay-stream in stream tests
    config.transfer.defaultStrategy = 'relay-disk';

    ({ app, io } = createTestApp());
    ({ sessionId } = await createSession(io, true));
  });

  after(() => {
    cleanUploadsDir(testUploadsDir);
    config.uploadsDir = originalUploadsDir; // Restore
    config.transfer.defaultStrategy = 'relay-disk';
    config.transfer.enableStreamRelay = false;
  });

  describe('Resumable Upload & Append (relay-disk)', () => {
    it('appends uploaded chunks and finalizes the file correctly', async () => {
      // Chunk 1: "hello" (length 5)
      const chunk1Res = await request(app)
        .post(`/upload/${sessionId}?fileId=${fileId}`)
        .set('X-File-Id', fileId)
        .attach('file', Buffer.from('hello'), 'large_test.txt');

      assert.equal(chunk1Res.status, 200);
      assert.equal(chunk1Res.body.success, true);
      assert.equal(chunk1Res.body.bytesReceived, 5);

      // Check upload status query
      const statusRes = await request(app).get(`/api/v1/upload/status/${sessionId}/${fileId}`);
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.bytesReceived, 5);

      // Chunk 2: " world!" (length 7)
      const chunk2Res = await request(app)
        .post(`/upload/${sessionId}?fileId=${fileId}`)
        .set('X-File-Id', fileId)
        .set('X-Upload-Offset', '5')
        .attach('file', Buffer.from(' world!'), 'large_test.txt');

      assert.equal(chunk2Res.status, 200);
      assert.equal(chunk2Res.body.success, true);
      assert.equal(chunk2Res.body.bytesReceived, 12);

      // Check final file content
      const session = store.sessions.get(sessionId);
      const meta = session.activeFiles.get(fileId);
      assert.ok(meta);
      assert.equal(meta.name, 'large_test.txt');
      assert.equal(meta.size, 12);

      const onDisk = fs.readFileSync(meta.path, 'utf8');
      assert.equal(onDisk, 'hello world!');
    });

    it('rejects resume if client offset does not match disk size', async () => {
      // Upload 5 bytes
      await request(app)
        .post(`/upload/${sessionId}?fileId=${fileId}`)
        .set('X-File-Id', fileId)
        .attach('file', Buffer.from('hello'), 'large_test.txt');

      // Attempt to append with incorrect offset (e.g. 10 instead of 5)
      const badRes = await request(app)
        .post(`/upload/${sessionId}?fileId=${fileId}`)
        .set('X-File-Id', fileId)
        .set('X-Upload-Offset', '10')
        .attach('file', Buffer.from(' world!'), 'large_test.txt');

      assert.equal(badRes.status, 409);
      assert.equal(badRes.body.error, 'Resume offset mismatch');
    });
  });

  describe('Range-based serving for downloads (relay-disk)', () => {
    beforeEach(async () => {
      // Pre-upload a full file "hello world!"
      await request(app)
        .post(`/upload/${sessionId}?fileId=${fileId}`)
        .set('X-File-Id', fileId)
        .attach('file', Buffer.from('hello world!'), 'large_test.txt');
    });

    it('handles Range query for partial download (start and end)', async () => {
      const res = await request(app)
        .get(`/download/${sessionId}/${fileId}`)
        .set('Range', 'bytes=0-4');

      assert.equal(res.status, 206);
      assert.equal(res.headers['content-range'], 'bytes 0-4/12');
      assert.equal(res.headers['content-length'], '5');
      assert.equal(res.text, 'hello');
    });

    it('handles Range query for partial download (start to end of file)', async () => {
      const res = await request(app)
        .get(`/download/${sessionId}/${fileId}`)
        .set('Range', 'bytes=6-');

      assert.equal(res.status, 206);
      assert.equal(res.headers['content-range'], 'bytes 6-11/12');
      assert.equal(res.headers['content-length'], '6');
      assert.equal(res.text, 'world!');
    });

    it('rejects out of bounds Range query with 416', async () => {
      const res = await request(app)
        .get(`/download/${sessionId}/${fileId}`)
        .set('Range', 'bytes=20-30');

      assert.equal(res.status, 416);
    });
  });

  describe('Stream-through Relay (relay-stream)', () => {
    it('pipes uploaded bytes directly to receiver download request with zero disk usage', async () => {
      config.transfer.defaultStrategy = 'relay-stream';
      const coordinator = getTransferCoordinator();
      const session = store.sessions.get(sessionId);

      // Add a receiver peer to session
      session.peers.set('peer1', {
        peerId: 'peer1',
        socketId: 'peer1-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });

      // Initialize the stream session
      coordinator.initializeStreamSession(
        fileId,
        { id: fileId, name: 'stream_test.bin', size: 14, type: 'application/octet-stream' },
        ['peer1'],
        'sender-socket',
        session,
      );

      // Listen on a random ephemeral port
      const server = app.listen(0);
      const port = server.address().port;

      // Async fetch /download - this sends the GET request immediately
      const downloadPromise = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${fileId}?receiver=peer1`,
      );

      // Poll until the receiver is registered in the stream session
      const streamStrategy = coordinator.strategies.get('relay-stream');
      for (let i = 0; i < 50; i++) {
        const streamSession = streamStrategy.activeSessions.get(fileId);
        if (streamSession && streamSession.connectedReceivers.has('peer1')) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const payload = Buffer.from('stream payload');
      const boundary = '----javin-stream-test';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stream_test.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        payload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/upload/${sessionId}?fileId=${fileId}`,
        {
          method: 'POST',
          headers: {
            'X-File-Id': fileId,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
          },
          body,
        },
      );

      assert.equal(uploadRes.status, 200);
      const uploadJson = await uploadRes.json();
      assert.equal(uploadJson.success, true);

      const downloadRes = await downloadPromise;
      assert.equal(downloadRes.status, 200);
      const downloadText = await downloadRes.text();
      assert.equal(downloadText, 'stream payload');

      // No disk artifact for stream relay (metadata may be removed after download cleanup)
      const diskPath = path.join(config.uploadsDir, `${sessionId}-${fileId}`);
      assert.ok(!fs.existsSync(diskPath));
      assert.equal(streamStrategy.activeSessions.has(fileId), false);

      // Close the server
      await new Promise((resolve) => server.close(resolve));
    });

    it('fans out uploaded bytes to multiple receivers', async () => {
      config.transfer.defaultStrategy = 'relay-stream';
      const multiFileId = 'stream-multi-file';
      const coordinator = getTransferCoordinator();
      const session = store.sessions.get(sessionId);
      const payload = Buffer.from('multi-receiver-stream');

      session.peers.set('peer1', {
        peerId: 'peer1',
        socketId: 'peer1-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });
      session.peers.set('peer2', {
        peerId: 'peer2',
        socketId: 'peer2-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });

      coordinator.initializeStreamSession(
        multiFileId,
        {
          id: multiFileId,
          name: 'multi.bin',
          size: payload.length,
          type: 'application/octet-stream',
        },
        ['peer1', 'peer2'],
        'sender-socket',
        session,
      );

      const server = app.listen(0);
      const port = server.address().port;
      const streamStrategy = coordinator.strategies.get('relay-stream');

      const download1 = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${multiFileId}?receiver=peer1`,
      );
      const download2 = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${multiFileId}?receiver=peer2`,
      );

      for (let i = 0; i < 50; i++) {
        const streamSession = streamStrategy.activeSessions.get(multiFileId);
        if (
          streamSession?.connectedReceivers.has('peer1') &&
          streamSession.connectedReceivers.has('peer2')
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const boundary = '----javin-stream-multi';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="multi.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        payload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/upload/${sessionId}?fileId=${multiFileId}`,
        {
          method: 'POST',
          headers: {
            'X-File-Id': multiFileId,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
          },
          body,
        },
      );
      assert.equal(uploadRes.status, 200);

      const [res1, res2] = await Promise.all([download1, download2]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      assert.equal(await res1.text(), 'multi-receiver-stream');
      assert.equal(await res2.text(), 'multi-receiver-stream');

      await new Promise((resolve) => server.close(resolve));
    });
  });

  describe('Buffered-through Relay (relay-buffered)', () => {
    it('spills to disk when file exceeds spoolThresholdBytes', async () => {
      config.transfer.defaultStrategy = 'relay-buffered';
      config.transfer.enableStreamRelay = true;
      config.transfer.spoolThresholdBytes = 1024; // 1 KB threshold

      const bufferedFileId = 'buffered-spill-file';
      const coordinator = getTransferCoordinator();
      const session = store.sessions.get(sessionId);

      // Create a 5 KB payload (exceeds 1 KB threshold)
      const payload = Buffer.alloc(5120, 'b');

      session.peers.set('peer1', {
        peerId: 'peer1',
        socketId: 'peer1-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });

      coordinator.initializeStreamSession(
        bufferedFileId,
        {
          id: bufferedFileId,
          name: 'spill.bin',
          size: payload.length,
          type: 'application/octet-stream',
        },
        ['peer1'],
        'sender-socket',
        session,
      );

      const server = app.listen(0);
      const port = server.address().port;
      const streamStrategy = coordinator.strategies.get('relay-buffered');

      const downloadPromise = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${bufferedFileId}?receiver=peer1`,
      );

      for (let i = 0; i < 50; i++) {
        const streamSession = streamStrategy.activeSessions.get(bufferedFileId);
        if (streamSession?.connectedReceivers.has('peer1')) {
          streamSession.downloads.set('dummy', {}); // Keep activeFiles from being deleted by download completion
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const boundary = '----javin-buffered-spill';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="spill.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        payload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/upload/${sessionId}?fileId=${bufferedFileId}`,
        {
          method: 'POST',
          headers: {
            'X-File-Id': bufferedFileId,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
          },
          body,
        },
      );
      try {
        assert.equal(uploadRes.status, 200);

        const finalMeta = session.activeFiles.get(bufferedFileId);
        assert.ok(finalMeta, 'finalMeta should be defined');
        // Assert that it spilled to disk (path is a physical path, not in-memory)
        assert.notEqual(finalMeta.path, 'in-memory-buffered');
        assert.ok(fs.existsSync(finalMeta.path), 'spilled file should exist on disk');
        assert.equal(fs.statSync(finalMeta.path).size, 5120);

        const downloadRes = await downloadPromise;
        assert.equal(downloadRes.status, 200);
        const downloadBuf = await downloadRes.arrayBuffer();
        assert.equal(downloadBuf.byteLength, 5120);

        // Clean up spilled file
        if (fs.existsSync(finalMeta.path)) {
          fs.unlinkSync(finalMeta.path);
        }
      } finally {
        session.activeFiles.delete(bufferedFileId);
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('keeps transfer in memory when file is below spoolThresholdBytes', async () => {
      config.transfer.defaultStrategy = 'relay-buffered';
      config.transfer.enableStreamRelay = true;
      config.transfer.spoolThresholdBytes = 10240; // 10 KB threshold

      const bufferedFileId = 'buffered-mem-file';
      const coordinator = getTransferCoordinator();
      const session = store.sessions.get(sessionId);

      // Create a 500 byte payload (below 10 KB threshold)
      const payload = Buffer.alloc(500, 'm');

      session.peers.set('peer1', {
        peerId: 'peer1',
        socketId: 'peer1-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });

      coordinator.initializeStreamSession(
        bufferedFileId,
        {
          id: bufferedFileId,
          name: 'mem.bin',
          size: payload.length,
          type: 'application/octet-stream',
        },
        ['peer1'],
        'sender-socket',
        session,
      );

      const server = app.listen(0);
      const port = server.address().port;
      const streamStrategy = coordinator.strategies.get('relay-buffered');

      const downloadPromise = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${bufferedFileId}?receiver=peer1`,
      );

      for (let i = 0; i < 50; i++) {
        const streamSession = streamStrategy.activeSessions.get(bufferedFileId);
        if (streamSession?.connectedReceivers.has('peer1')) {
          streamSession.downloads.set('dummy', {}); // Keep activeFiles from being deleted by the download completion
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const boundary = '----javin-buffered-mem';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="mem.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        payload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const uploadRes = await fetch(
        `http://127.0.0.1:${port}/upload/${sessionId}?fileId=${bufferedFileId}`,
        {
          method: 'POST',
          headers: {
            'X-File-Id': bufferedFileId,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
          },
          body,
        },
      );
      try {
        assert.equal(uploadRes.status, 200);

        const finalMeta = session.activeFiles.get(bufferedFileId);
        assert.ok(finalMeta, 'finalMeta should be defined');
        // Assert that it remained in-memory
        assert.equal(finalMeta.path, 'in-memory-buffered');

        const downloadRes = await downloadPromise;
        assert.equal(downloadRes.status, 200);
        const downloadBuf = await downloadRes.arrayBuffer();
        assert.equal(downloadBuf.byteLength, 500);
      } finally {
        session.activeFiles.delete(bufferedFileId);
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('late-connecting lagging receiver receives the entire file in correct order', async () => {
      config.transfer.defaultStrategy = 'relay-buffered';
      config.transfer.enableStreamRelay = true;
      config.transfer.spoolThresholdBytes = 500; // Spill to disk quickly
      config.transfer.streamRelayTimeoutMs = 50; // Trigger upload quickly after timeout

      const bufferedFileId = 'buffered-late-file';
      const coordinator = getTransferCoordinator();
      const session = store.sessions.get(sessionId);

      session.peers.set('peer1', {
        peerId: 'peer1',
        socketId: 'peer1-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });
      session.peers.set('peer2', {
        peerId: 'peer2',
        socketId: 'peer2-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });

      const streamSession = coordinator.initializeStreamSession(
        bufferedFileId,
        {
          id: bufferedFileId,
          name: 'late.bin',
          size: 4000,
          type: 'application/octet-stream',
        },
        ['peer1', 'peer2'],
        'sender-socket',
        session,
      );

      const server = app.listen(0);
      const port = server.address().port;
      const streamStrategy = coordinator.strategies.get('relay-buffered');

      // 1. Connect first receiver peer1
      const downloadPromise1 = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${bufferedFileId}?receiver=peer1`,
      );

      // Wait for peer1 to connect and the upload timeout to fire (which starts the upload)
      for (let i = 0; i < 50; i++) {
        const s = streamStrategy.activeSessions.get(bufferedFileId);
        if (s?.uploadStarted) {
          s.downloads.set('dummy', {}); // Keep activeFiles from deletion
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      // 2. Start upload via raw http.request
      const http = await import('node:http');
      const boundary = '----javin-buffered-late';
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: `/upload/${sessionId}?fileId=${bufferedFileId}`,
        method: 'POST',
        headers: {
          'X-File-Id': bufferedFileId,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Transfer-Encoding': 'chunked',
        },
      });

      req.write(header);
      const partA = Buffer.alloc(2000, 'a');
      req.write(partA);

      // Wait for it to spool to disk
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 3. Connect late receiver peer2
      const downloadPromise2 = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${bufferedFileId}?receiver=peer2`,
      );

      // Wait for peer2 connection
      for (let i = 0; i < 50; i++) {
        const s = streamStrategy.activeSessions.get(bufferedFileId);
        if (s?.connectedReceivers.has('peer2')) {
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      // 4. Write second part of upload
      const partB = Buffer.alloc(2000, 'b');
      req.write(partB);
      req.write(footer);
      req.end();

      const uploadResPromise = new Promise((resolve, reject) => {
        req.on('response', (res) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Upload status ${res.statusCode}`));
        });
        req.on('error', reject);
      });

      try {
        await uploadResPromise;

        // Verify both receivers download the correct, uncorrupted file
        const downloadRes1 = await downloadPromise1;
        assert.equal(downloadRes1.status, 200);
        const downloadBuf1 = Buffer.from(await downloadRes1.arrayBuffer());
        assert.equal(downloadBuf1.length, 4000);
        assert.equal(downloadBuf1.subarray(0, 2000).toString(), partA.toString());
        assert.equal(downloadBuf1.subarray(2000, 4000).toString(), partB.toString());

        const downloadRes2 = await downloadPromise2;
        assert.equal(downloadRes2.status, 200);
        const downloadBuf2 = Buffer.from(await downloadRes2.arrayBuffer());
        assert.equal(downloadBuf2.length, 4000);
        assert.equal(downloadBuf2.subarray(0, 2000).toString(), partA.toString());
        assert.equal(downloadBuf2.subarray(2000, 4000).toString(), partB.toString());
      } finally {
        session.activeFiles.delete(bufferedFileId);
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('stalled receiver exceeding memory limit is dropped', async () => {
      config.transfer.defaultStrategy = 'relay-buffered';
      config.transfer.enableStreamRelay = true;
      config.transfer.spoolThresholdBytes = 100;
      config.transfer.maxReceiverBufferSize = 500; // Small limit for testing

      const bufferedFileId = 'buffered-stall-file';
      const coordinator = getTransferCoordinator();
      const session = store.sessions.get(sessionId);

      session.peers.set('peer1', {
        peerId: 'peer1',
        socketId: 'peer1-socket',
        role: 'receiver',
        currentPage: 'receive',
        isDisconnected: false,
      });

      const streamSession = coordinator.initializeStreamSession(
        bufferedFileId,
        {
          id: bufferedFileId,
          name: 'stall.bin',
          size: 10000,
          type: 'application/octet-stream',
        },
        ['peer1'],
        'sender-socket',
        session,
      );

      const server = app.listen(0);
      const port = server.address().port;
      const streamStrategy = coordinator.strategies.get('relay-buffered');

      const downloadPromise = fetch(
        `http://127.0.0.1:${port}/download/${sessionId}/${bufferedFileId}?receiver=peer1`,
      );

      // Wait for receiver to connect
      for (let i = 0; i < 50; i++) {
        const s = streamStrategy.activeSessions.get(bufferedFileId);
        if (s?.connectedReceivers.has('peer1')) {
          s.downloads.set('dummy', {});
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      // Send upload that exceeds the 500 bytes buffer cap, but receiver is not reading the fetch stream
      const boundary = '----javin-buffered-stall';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stall.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        Buffer.alloc(2000, 'x'), // Exceeds the 500 bytes safety limit
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      await fetch(`http://127.0.0.1:${port}/upload/${sessionId}?fileId=${bufferedFileId}`, {
        method: 'POST',
        headers: {
          'X-File-Id': bufferedFileId,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });

      try {
        const downloadRes = await downloadPromise;
        // The download connection should have been aborted or closed prematurely by server branch destruction
        let errorCaught = false;
        try {
          await downloadRes.arrayBuffer();
        } catch (_) {
          errorCaught = true;
        }
        assert.ok(
          errorCaught || downloadRes.status !== 200,
          'Download stream should have failed/aborted due to stall destruction',
        );
      } finally {
        session.activeFiles.delete(bufferedFileId);
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
