// backend/server.js
import express from "express";
import https from "https";
import { Server } from "socket.io";
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import os from "os";
import open from "open";
import Busboy from 'busboy';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
// Migrate to HTTPS
const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
}, app);
const PROTOCOL = 'https';

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e9, // 1GB
    pingTimeout: 120000,
    pingInterval: 25000
});
const PORT = 4000;
const PIN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DEVICE_NAMES_FILE = path.join(__dirname, 'device_names.json');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// 🆕 NEW: Persistent storage for device names
let deviceNamesMap = new Map(); // peerId -> deviceName

// Load device names from file on server start
function loadDeviceNames() {
  try {
    if (fs.existsSync(DEVICE_NAMES_FILE)) {
      const data = fs.readFileSync(DEVICE_NAMES_FILE, 'utf8');
      const parsed = JSON.parse(data);
      deviceNamesMap = new Map(Object.entries(parsed));
      console.log(`📱 Loaded ${deviceNamesMap.size} device names from persistent storage`);
    } else {
      console.log('📱 No existing device names file found, starting with empty map');
    }
  } catch (error) {
    console.error('❌ Error loading device names:', error);
    deviceNamesMap = new Map();
  }
}

// Save device names to file
function saveDeviceNames() {
  try {
    const data = JSON.stringify(Object.fromEntries(deviceNamesMap), null, 2);
    fs.writeFileSync(DEVICE_NAMES_FILE, data, 'utf8');
    console.log(`💾 Saved ${deviceNamesMap.size} device names to persistent storage`);
  } catch (error) {
    console.error('❌ Error saving device names:', error);
  }
}

// Get device name for a peer
function getDeviceName(peerId) {
  return deviceNamesMap.get(peerId) || '';
}

// Set device name for a peer
function setDeviceName(peerId, deviceName) {
  if (deviceName && deviceName.trim()) {
    deviceNamesMap.set(peerId, deviceName.trim());
    saveDeviceNames(); // Save immediately when updated
    return true;
  }
  return false;
}

// Load device names when server starts
loadDeviceNames();

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();
function generatePIN() { return Math.floor(100000 + Math.random() * 900000).toString(); }
const sessions = new Map();
const transferHistory = new Map();
// Recent transfers (global, capped) — one entry per receiver
// { senderId, senderName, receiverId, receiverName, fileName, size, timestamp }
const recentTransfers = [];

// Track active downloads per receiver to control concurrency
const receiverDownloadQueues = new Map(); // sessionId -> Map<receiverPeerId, Array<{file, downloadUrl}>>
const receiverDownloadFlags = new Map(); // sessionId -> Map<receiverPeerId, boolean> (true = downloading, false = ready)
const receiverActiveDownloads = new Map(); // sessionId -> Map<receiverPeerId, number>
const MAX_CONCURRENT_DOWNLOADS_PER_RECEIVER = 3
; // allow multiple parallel downloads per receiver

let currentHostSessionId = null;

const frontendPath = path.join(__dirname, '..', 'frontend');



// Redirect /pin to /pin.html for convenience
app.get('/pin', (req, res) => {
  res.redirect('/pin.html');
});

app.use(express.static(frontendPath));
app.use(express.json());

// Protect index.html - only allow access to current host session
app.get('/index.html', (req, res) => {
  const sessionId = req.query.session;
  if (sessionId && currentHostSessionId && sessionId !== currentHostSessionId) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Access Denied</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>❌ Access Denied</h1>
        <p>This session is not active or you are not the host.</p>
        <p>Only the current session host can access this page.</p>
      </body>
      </html>
    `);
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Protect root path as well
app.get('/', (req, res) => {
  const sessionId = req.query.session;
  if (sessionId && currentHostSessionId && sessionId !== currentHostSessionId) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Access Denied</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>❌ Access Denied</h1>
        <p>This session is not active or you are not the host.</p>
        <p>Only the current session host can access this page.</p>
      </body>
      </html>
    `);
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Protect all main pages from unauthorized session access
const protectedPages = ['main.html', 'pin.html', 'send.html', 'receive.html'];

protectedPages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    const sessionId = req.query.session;
    
    // If no session ID provided, allow access (let frontend handle validation)
    if (!sessionId) {
      return res.sendFile(path.join(frontendPath, page));
    }
    
    // Check if session exists and is valid
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Session Not Found</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Session Not Found</h1>
          <p>This session does not exist or has expired.</p>
          <p>Please scan the QR code again to join a valid session.</p>
        </body>
        </html>
      `);
    }
    
    // Check if session has expired
    if (Date.now() > session.pinExpiry) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Session Expired</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>⏰ Session Expired</h1>
          <p>This session has expired.</p>
          <p>Please scan the QR code again to join a new session.</p>
        </body>
        </html>
      `);
    }
    
    // Session is valid, allow access
    res.sendFile(path.join(frontendPath, page));
  });
});
// Graceful server shutdown endpoint (host-only usage recommended)
app.post('/api/shutdown', (req, res) => {
  // Only allow shutdown if explicitly requested by user (not automatic)
  const { force } = req.body;
  
  if (!force) {
    console.log('Shutdown request rejected - not forced');
    return res.status(403).json({ error: 'Shutdown must be explicitly requested' });
  }
  
  res.json({ ok: true, message: 'Server shutting down' });
  console.log('Received forced shutdown request. Closing server...');
  
  // Close all Socket.IO connections first
  if (io) {
    console.log('Closing Socket.IO connections...');
    io.close(() => {
      console.log('Socket.IO closed. Closing HTTP server...');
      // Close HTTP server after Socket.IO
      server.close(() => {
        console.log('HTTP server closed. Exiting process.');
        process.exit(0);
      });
    });
  } else {
    // Fallback if Socket.IO not available
    server.close(() => {
      console.log('HTTP server closed. Exiting process.');
      process.exit(0);
    });
  }
});

// Logic to reuse session if active, or create a new one if expired/empty
app.get("/get-current-session", async (req, res) => {
  // Check if a specific session is requested
  const requestedSessionId = req.query.session;
  
  if (requestedSessionId) {
    // If a specific session is requested, try to get that session
    const requestedSession = sessions.get(requestedSessionId);
    if (requestedSession && Date.now() <= requestedSession.pinExpiry) {
      // Session exists and is valid
      const pinUrl = `${PROTOCOL}://${LOCAL_IP}:${PORT}/pin`;
      const qrDataUrl = await QRCode.toDataURL(pinUrl);
      res.json({ sessionId: requestedSession.id, pin: requestedSession.pin, url: pinUrl, qrDataUrl, pinExpiry: requestedSession.pinExpiry });
      return;
    } else {
      // Session doesn't exist or has expired
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }
  }

  // If forceNew is requested (host landing on index), always create a new session and invalidate the previous one
  const forceNew = req.query.forceNew === '1';
  let session = currentHostSessionId ? sessions.get(currentHostSessionId) : null;
  const clientsConnected = session ? Array.from(session.peers.values()).some(p => p.role === 'client') : false;

  // If index refresh requested and no clients have connected to the QR yet, start a fresh session
  const refreshRequested = req.query.refresh === '1';

  if (forceNew || !session || Date.now() > session.pinExpiry || (refreshRequested && !clientsConnected)) {
    try {
        const newSessionData = await createSession(forceNew);
        res.json(newSessionData);
    } catch (err) {
        console.error("Error creating session:", err);
        res.status(500).json({ error: "Could not create session." });
    }
  } else {
    // Otherwise, reuse the existing session
    const pinUrl = `${PROTOCOL}://${LOCAL_IP}:${PORT}/pin`;
    const qrDataUrl = await QRCode.toDataURL(pinUrl);
    res.json({ sessionId: session.id, pin: session.pin, url: pinUrl, qrDataUrl, pinExpiry: session.pinExpiry });
  }
});

app.get("/api/session-details/:sessionId", (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (session) {
        // 🆕 NEW: Count only connected peers that are actually on the main page
        const connectedOnMain = Array.from(session.peers.values()).filter(p => 
            !p.isDisconnected && p.inMain === true && p.currentPage === 'main'
        );
        
        res.json({ 
            pinExpiry: session.pinExpiry,
            peerCount: connectedOnMain.length
        });
    } else {
        res.status(404).json({ error: "Session not found" });
    }
});

// Per-user recent transfers API
app.get('/recent/:userId', (req, res) => {
  const userId = req.params.userId;
  const history = recentTransfers.filter(t => t.senderId === userId || t.receiverId === userId);
  res.json(history);
});

async function createSession(forceInvalidatePrevious = false) {
  const sessionId = nanoid(10);
  const pin = generatePIN();
  // If there is an existing host session and we are forcing a new one, invalidate the old session
  if (forceInvalidatePrevious && currentHostSessionId) {
    const prev = sessions.get(currentHostSessionId);
    if (prev) {
      console.log(`Invalidating previous session ${prev.id}`);
      // Notify previous session peers and clear state
      io.in(prev.id).emit('session-ended');
      
      // 🆕 NEW: Clean up device names for peers in the invalidated session
      const peerIds = Array.from(prev.peers.keys());
      peerIds.forEach(peerId => {
        if (deviceNamesMap.has(peerId)) {
          deviceNamesMap.delete(peerId);
          console.log(`🧹 Cleaned up device name for peer ${peerId} (session invalidated)`);
        }
      });
      saveDeviceNames(); // Save the cleaned up map
      
      sessions.delete(prev.id);
      transferHistory.delete(prev.id);
    }
  }
  const session = {
      id: sessionId,
      pin,
      pinExpiry: Date.now() + PIN_EXPIRY_MS,
      peers: new Map(),
      activeFiles: new Map(),
      activeTransfer: null,
      currentSenderPeerId: null,
      exitedPeers: new Set()
  };
  sessions.set(sessionId, session);
  transferHistory.set(sessionId, []);
  currentHostSessionId = sessionId;
  const pinUrl = `${PROTOCOL}://${LOCAL_IP}:${PORT}/pin`;
  const qrDataUrl = await QRCode.toDataURL(pinUrl);
  console.log(`Session created: ${sessionId}, PIN: ${pin}`);
  return { sessionId, pin, url: pinUrl, qrDataUrl, pinExpiry: session.pinExpiry };
}

// New endpoint to get PIN expiry for manual entry page
app.get('/api/get-pin-expiry', (req, res) => {
  // Find the most recent active session (host session)
  let latestSession = null;
  let latestTime = 0;
  
  for (const [sessionId, session] of sessions.entries()) {
    if (session.pinExpiry > latestTime) {
      latestTime = session.pinExpiry;
      latestSession = session;
    }
  }
  
  if (latestSession && Date.now() <= latestSession.pinExpiry) {
    res.json({ 
      pinExpiry: latestSession.pinExpiry,
      sessionId: latestSession.id
    });
  } else {
    res.status(404).json({ error: 'No active session found' });
  }
});

// New endpoint to find session by PIN (for manual entry)
app.post('/api/find-session-by-pin', (req, res) => {
  const { pin } = req.body;
  
  // Find session with this PIN
  for (const [sessionId, session] of sessions.entries()) {
    if (session.pin === pin && Date.now() <= session.pinExpiry) {
      return res.json({ 
        success: true, 
        sessionId: session.id,
        navToken: 'nav_token_main_' + session.id
      });
    }
  }
  
  res.status(400).json({ error: 'Invalid PIN or session expired' });
});

// 🆕 NEW: Get device name for a peer
app.get('/api/device-name/:peerId', (req, res) => {
  const { peerId } = req.params;
  const deviceName = getDeviceName(peerId);
  if (deviceName) {
    res.json({ success: true, deviceName });
  } else {
    res.status(404).json({ error: 'Device name not found' });
  }
});

// 🆕 NEW: Get all stored device names
app.get('/api/device-names', (req, res) => {
  const deviceNames = Object.fromEntries(deviceNamesMap);
  res.json({ success: true, deviceNames });
});

app.post("/api/verify-pin", (req, res) => {
  const { sessionId, pin } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found or expired" });
  if (Date.now() > session.pinExpiry) {
      return res.status(400).json({ error: "PIN has expired" });
  }
  if (session.pin === pin) {
    return res.json({ success: true, sessionId, navToken: `nav_token_main_${sessionId}` });
  }
  res.status(400).json({ error: "Invalid PIN" });
});

app.post('/upload/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const busboy = Busboy({ headers: req.headers });
    let fileId, peerId, filePath, tempPath, writeStream, fileMetadata;

    busboy.on('field', (fieldname, val) => {
        if (fieldname === 'fileId') fileId = val;
        if (fieldname === 'peerId') peerId = val;
    });

    busboy.on('file', (fieldname, file, { filename, mimeType }) => {
        // Write to a temp file first (fileId may not have been parsed yet)
        tempPath = path.join(UPLOADS_DIR, `${sessionId}-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        writeStream = fs.createWriteStream(tempPath);
        fileMetadata = { id: fileId, name: filename, type: mimeType, path: tempPath, size: 0 };
        file.on('data', chunk => { fileMetadata.size += chunk.length; });
        file.pipe(writeStream);
    });

    busboy.on('finish', () => {
        // Ensure we have a fileId; if missing, clean up temp and error out
        if (!fileId) {
            try { if (writeStream) writeStream.end(); } catch (_) {}
            try { if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) { console.error('Failed to cleanup temp upload without fileId:', e); }
            return res.status(400).json({ error: 'Missing fileId' });
        }

        // Rename temp file to final path using fileId
        try {
            filePath = path.join(UPLOADS_DIR, `${sessionId}-${fileId}`);
            if (tempPath && tempPath !== filePath) {
                try { if (writeStream) writeStream.end(); } catch (_) {}
                fs.renameSync(tempPath, filePath);
            }
            fileMetadata.id = fileId;
            fileMetadata.path = filePath;
            session.activeFiles.set(fileId, fileMetadata);
            res.json({ success: true, fileId });
        } catch (e) {
            console.error('Failed to finalize upload file path:', e);
            try { if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
            return res.status(500).json({ error: 'Failed to save file' });
        }
    });
    req.pipe(busboy);
});

app.get('/download/:sessionId/:fileId', (req, res) => {
    const { sessionId, fileId } = req.params;
    const receiverPeerId = req.query.receiver;
    const session = sessions.get(sessionId);
    const fileMetadata = session?.activeFiles.get(fileId);
    if (!session || !fileMetadata || !fs.existsSync(fileMetadata.path)) {
        return res.status(404).json({ error: 'File not found' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${fileMetadata.name}"`);
    res.setHeader('Content-Type', fileMetadata.type || 'application/octet-stream');
    if (typeof fileMetadata.size === 'number' && Number.isFinite(fileMetadata.size)) {
        res.setHeader('Content-Length', fileMetadata.size);
    }
    // Always create a fresh stream per request
    const readStream = fs.createReadStream(fileMetadata.path);

    // Only consider a download successful when response finishes piping
    res.on('finish', () => {
        try {
            // Initialize pending counter if missing
            if (typeof fileMetadata.pending !== 'number' || fileMetadata.pending < 0) {
                fileMetadata.pending = 0;
            }
            // Decrement pending downloads and delete only when all receivers have fetched
            fileMetadata.pending = Math.max(0, (fileMetadata.pending || 0) - 1);

            if (fileMetadata.pending === 0) {
                try {
                    fs.unlinkSync(fileMetadata.path);
                } catch (e) {
                    console.error('Failed to delete file after final download:', e);
                }
                try {
                    session.activeFiles.delete(fileId);
                } catch (_) {}
            }
        } catch (e) {
            console.error('Post-download cleanup error:', e);
        }

        // Drive queue progression for this receiver (if provided)
        if (receiverPeerId) {
            try {
                // Decrement active count for receiver
                if (!receiverActiveDownloads.has(sessionId)) receiverActiveDownloads.set(sessionId, new Map());
                const m = receiverActiveDownloads.get(sessionId);
                m.set(receiverPeerId, Math.max(0, (m.get(receiverPeerId) || 0) - 1));

                const sessionDownloadQueue = receiverDownloadQueues.get(sessionId);
                const receiverQueue = sessionDownloadQueue?.get(receiverPeerId) || [];
                const receiver = session.peers.get(receiverPeerId);

                // Dispatch up to concurrency limit
                while (receiver && receiverQueue && receiverQueue.length > 0 && (m.get(receiverPeerId) || 0) < MAX_CONCURRENT_DOWNLOADS_PER_RECEIVER) {
                    const nextFile = receiverQueue.shift();
                    io.to(receiver.socketId).emit('download-ready', { file: nextFile.file, downloadUrl: nextFile.downloadUrl });
                    m.set(receiverPeerId, (m.get(receiverPeerId) || 0) + 1);
                    console.log(`📥 Active downloads for ${receiverPeerId}: ${m.get(receiverPeerId)}`);
                }
                // If queue emptied, cleanup
                if (receiverQueue.length === 0 && sessionDownloadQueue) {
                    sessionDownloadQueue.delete(receiverPeerId);
                    if (sessionDownloadQueue.size === 0) receiverDownloadQueues.delete(sessionId);
                }

                // If no active downloads remain and queue is empty, notify receiver UI it's safe to go back
                const remaining = m.get(receiverPeerId) || 0;
                const hasQueue = !!(receiverDownloadQueues.get(sessionId)?.get(receiverPeerId)?.length);
                if (receiver && remaining === 0 && !hasQueue) {
                    io.to(receiver.socketId).emit('receiver-downloads-idle');
                }
            } catch (e) {
                console.error('Queue progression error for receiver:', receiverPeerId, e);
            }
        }
    });

    // Handle client aborts/errors
    res.on('close', () => {
        // If the client aborted early, destroy stream; decrement pending as this download ended
        try { readStream.destroy(); } catch (_) {}
        try {
            if (typeof fileMetadata.pending !== 'number' || fileMetadata.pending < 0) {
                fileMetadata.pending = 0;
            }
            fileMetadata.pending = Math.max(0, (fileMetadata.pending || 0) - 1);
            if (fileMetadata.pending === 0) {
                try { fs.unlinkSync(fileMetadata.path); } catch (e) { console.error('Failed to delete file after abort:', e); }
                try { session.activeFiles.delete(fileId); } catch (_) {}
            }
        } catch (e) {
            console.error('Abort cleanup error:', e);
        }

        // On abort also try to progress next queued file for this receiver
        if (receiverPeerId) {
            try {
                if (!receiverActiveDownloads.has(sessionId)) receiverActiveDownloads.set(sessionId, new Map());
                const m = receiverActiveDownloads.get(sessionId);
                m.set(receiverPeerId, Math.max(0, (m.get(receiverPeerId) || 0) - 1));

                const sessionDownloadQueue = receiverDownloadQueues.get(sessionId);
                const receiverQueue = sessionDownloadQueue?.get(receiverPeerId) || [];
                const receiver = session.peers.get(receiverPeerId);

                while (receiver && receiverQueue && receiverQueue.length > 0 && (m.get(receiverPeerId) || 0) < MAX_CONCURRENT_DOWNLOADS_PER_RECEIVER) {
                    const nextFile = receiverQueue.shift();
                    io.to(receiver.socketId).emit('download-ready', { file: nextFile.file, downloadUrl: nextFile.downloadUrl });
                    m.set(receiverPeerId, (m.get(receiverPeerId) || 0) + 1);
                    console.log(`📥 Active downloads for ${receiverPeerId}: ${m.get(receiverPeerId)}`);
                }
                if (receiverQueue.length === 0 && sessionDownloadQueue) {
                    sessionDownloadQueue.delete(receiverPeerId);
                    if (sessionDownloadQueue.size === 0) receiverDownloadQueues.delete(sessionId);
                }

                const remaining = m.get(receiverPeerId) || 0;
                const hasQueue = !!(receiverDownloadQueues.get(sessionId)?.get(receiverPeerId)?.length);
                if (receiver && remaining === 0 && !hasQueue) {
                    io.to(receiver.socketId).emit('receiver-downloads-idle');
                }
            } catch (e) {
                console.error('Queue progression error on abort for receiver:', receiverPeerId, e);
            }
        }
    });

    readStream.on('error', (err) => {
        console.error('File stream error:', err);
        if (!res.headersSent) res.status(500).end('File read error');
    });

    readStream.pipe(res);
});

// Replace the socket handling in server.js with this improved version:

io.on("connection", (socket) => {
  console.log(`New socket connection: ${socket.id}`);
  
  socket.on("join-session", ({ sessionId, role, peerId, deviceName }) => {
    console.log(`Join session request: ${peerId} as ${role} in ${sessionId}`);
    
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`❌ Session ${sessionId} not found`);
      return socket.emit('error', { message: 'Session not found' });
    }

    // Allow peers to rejoin sessions they previously exited
    // Clear the exited status when they rejoin
    if (session.exitedPeers && session.exitedPeers.has(peerId)) {
      console.log(`✅ Peer ${peerId} rejoining after exit. Allowing reconnection.`);
      session.exitedPeers.delete(peerId);
    }

    // Check if peer already exists with different socket
    const existing = session.peers.get(peerId);
    if (existing && existing.socketId !== socket.id) {
      console.log(`🔄 Updating socket for existing peer ${peerId}`);
      // Leave old socket from session if it exists
      const oldSocket = io.sockets.sockets.get(existing.socketId);
      if (oldSocket) {
        oldSocket.leave(sessionId);
      }
      
      // If peer was marked as disconnected, clear the disconnect timeout
      if (existing.disconnectTimeout) {
        clearTimeout(existing.disconnectTimeout);
        console.log(`Cleared disconnect timeout for reconnecting peer ${peerId}`);
      }
    }

    // Update or add peer (preserve disconnect state if reconnecting)
    const isMainPage = socket.handshake.query.page === 'main';
    
    // 🆕 NEW: Use persistent device name storage
    let finalDeviceName = deviceName || '';
    if (!finalDeviceName && existing?.deviceName) {
      finalDeviceName = existing.deviceName;
    }
    if (!finalDeviceName) {
      finalDeviceName = getDeviceName(peerId); // Try to get from persistent storage
    }
    
    // 🆕 NEW: Preserve existing page state on reconnection
    const preservedCurrentPage = existing?.currentPage || (isMainPage ? 'main' : undefined);
    const preservedInMain = existing?.inMain !== undefined ? existing.inMain : isMainPage;
    
    const peerData = { 
      role, 
      socketId: socket.id, 
      peerId, 
      isMainPage, 
      deviceName: finalDeviceName,
      isDisconnected: false, // Mark as reconnected
      disconnectedAt: null, // Clear disconnect timestamp
      currentPage: preservedCurrentPage, // Preserve page state
      inMain: preservedInMain // Preserve main page state
    };
    session.peers.set(peerId, peerData);
    socket.join(sessionId);
    socket.data = { peerId, sessionId, role, isMainPage };
    
    // If this is the host joining the main page, mark them as ready
    if (role === 'host' && isMainPage) {
      console.log(`🌟 Host ${peerId} is now on the main page`);
      // Check and release any stale locks when host joins main page
      checkAndReleaseStaleTransferLocks(sessionId);
    }

    console.log(`✅ Peer ${peerId} joined session ${sessionId} as ${role}`);
    if (role === 'client') {
      console.log(`📱 Client ${peerId} scanned QR code - waiting for PIN verification before redirecting host`);
    }
    console.log(`Current peers in ${sessionId}:`, Array.from(session.peers.values()).map(p => `${p.peerId}(${p.role})`));

    // Emit updates (only include connected peers)
    const connectedPeers = Array.from(session.peers.values()).filter(p => !p.isDisconnected);
    io.in(sessionId).emit('peers-updated', connectedPeers);
    socket.emit("session-joined", { sessionId, role });
    socket.emit('history-updated', transferHistory.get(sessionId) || []);
    
    // Note: Automatic host redirect moved to client-has-verified event to wait for PIN verification
    


  });

  socket.on('client-has-verified', ({ sessionId }) => {
    console.log(`Client verified for session ${sessionId}`);
    const session = sessions.get(sessionId);
    if (!session) return;
    
    // Check if host is connected
    const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host');
    console.log(`Host peer found:`, hostPeer ? `Yes (${hostPeer.peerId})` : 'No');
    
    // Emit session-joined event to the client immediately
    socket.emit('session-joined', { sessionId: sessionId, role: 'client' });
    console.log(`✅ Emitted session-joined event to client for session ${sessionId}`);
    
    // 🎯 HOST REDIRECT BEHAVIOR:
    // - NO automatic redirect when PIN auto-verifies
    // - Host redirects ONLY when:
    //   1. User clicks "Go to Main Immediately" button, OR
    //   2. Grace timer expires (30 seconds)
    // This respects user choice and maintains the grace period system
    console.log(`📱 Client ${socket.id} verified PIN - host stays on index page until user choice or grace timer expires`);
    
    // Initialize grace redirect window once on first verification
    if (!session.graceRedirectTimer) {
      const GRACE_MS = 30000; // 30 seconds to allow others to scan
      session.graceRedirectEndMs = Date.now() + GRACE_MS;
      console.log(`Starting host redirect grace window (${GRACE_MS / 1000}s) for session ${sessionId}`);
      
      // Add a small delay to ensure host has time to join the session
      setTimeout(() => {
        // Check if host is actually in the session before emitting
        const currentSession = sessions.get(sessionId);
        if (!currentSession) return;
        
        const hostPeer = Array.from(currentSession.peers.values()).find(p => p.role === 'host');
        if (!hostPeer) {
          console.log(`No host found in session ${sessionId}, skipping grace timer event`);
          return;
        }
        
        console.log(`Host ${hostPeer.peerId} confirmed in session ${sessionId}, emitting grace timer event`);
        
        // Notify host index page to show countdown
        console.log(`Emitting start-host-redirect-countdown to session ${sessionId} with duration ${Math.ceil(GRACE_MS / 1000)}s`);
        io.in(sessionId).emit('start-host-redirect-countdown', { durationSeconds: Math.ceil(GRACE_MS / 1000) });
        console.log(`Emitted start-host-redirect-countdown to session ${sessionId}`);
        
        // Also emit to all connected sockets in case host is connected but not joined yet
        io.emit('start-host-redirect-countdown', { 
          sessionId: sessionId,
          durationSeconds: Math.ceil(GRACE_MS / 1000) 
        });
        console.log(`Also emitted start-host-redirect-countdown to all sockets for session ${sessionId}`);
      }, 1000); // 1 second delay
      session.graceRedirectTimer = setTimeout(() => {
        const currentSession = sessions.get(sessionId);
        if (!currentSession) return;
        // Clear timer state
        try { if (currentSession.graceRedirectTimer) clearTimeout(currentSession.graceRedirectTimer); } catch (_) {}
        currentSession.graceRedirectTimer = null;
        currentSession.graceRedirectEndMs = null;
        const currentHost = Array.from(currentSession.peers.values()).find(p => p.role === 'host');
        const clientsConnected = Array.from(currentSession.peers.values()).some(p => p.role !== 'host');
        if (currentHost && clientsConnected) {
          console.log(`⏰ Grace window ended. Automatically redirecting host ${currentHost.peerId} to main (clients present).`);
          io.to(currentHost.socketId).emit('redirect-host-to-main');
        } else {
          console.log(`⏰ Grace window ended but no clients connected. Host stays on index for session ${sessionId}.`);
        }
      }, GRACE_MS);
    } else {
      // If a grace window is already running, we do not restart it, but we can keep letting others verify
      console.log(`Client verified while grace window active for session ${sessionId}`);
    }
  });

  // When a client scans QR and verifies PIN, they can request to clear exit status
  socket.on('client-reset-exit', ({ sessionId, peerId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    try {
      if (session.exitedPeers) session.exitedPeers.delete(peerId);
    } catch (_) {}
  });
  
  // Handle device name updates
  socket.on('update-device-name', ({ sessionId, deviceName }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const peer = Array.from(session.peers.values()).find(p => p.socketId === socket.id);
    if (peer) {
      // 🆕 NEW: Update both session and persistent storage
      peer.deviceName = deviceName;
      setDeviceName(peer.peerId, deviceName); // Save to persistent storage
      
      console.log(`📱 Device name updated for ${peer.peerId}: ${deviceName}`);
      console.log(`💾 Device name saved to persistent storage for ${peer.peerId}`);
      
      // Notify other peers about the name update
      io.in(sessionId).emit('peer-name-updated', { 
        peerId: peer.peerId, 
        deviceName: deviceName 
      });
    }
  });

  // Handle host going to main page
  socket.on('host-going-to-main', ({ sessionId }) => {
    console.log(`Host going to main page for session ${sessionId}`);
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host' && p.socketId === socket.id);
    if (hostPeer) {
      hostPeer.currentPage = 'main';
      console.log(`🌟 Host ${hostPeer.peerId} is now on main page`);
      // Check and release any stale locks when host goes to main page
      checkAndReleaseStaleTransferLocks(sessionId);
    }
  });

  // New: allow host/client to prepare other peers by redirecting them to receive page
  socket.on('prepare-receivers', ({ sessionId, senderId }, ack) => {
    console.log(`Prepare receivers requested by ${senderId} in ${sessionId}`);
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`❌ Session ${sessionId} not found for prepare-receivers`);
      if (typeof ack === 'function') ack({ ok: false, reason: 'session_not_found' });
      return;
    }
    const receivers = Array.from(session.peers.values()).filter(p => p.peerId !== senderId);
    receivers.forEach(receiver => {
      console.log(`Preparing receiver ${receiver.peerId} → redirect to receive`);
      // Update receiver's page state immediately
      receiver.currentPage = 'receive';
      session.peers.set(receiver.peerId, receiver);
      io.to(receiver.socketId).emit('force-redirect-to-receive');
    });
    if (typeof ack === 'function') ack({ ok: true, receivers: receivers.length });
  });

  // Host can choose to go to main immediately (only if at least one non-host is connected)
  socket.on('host-go-now', ({ sessionId }, ack) => {
    const session = sessions.get(sessionId);
    if (!session) return typeof ack === 'function' && ack({ ok: false, reason: 'session_not_found' });
    const clientsConnected = Array.from(session.peers.values()).some(p => p.role !== 'host');
    if (!clientsConnected) {
      console.log(`Host requested go-now but no clients connected in session ${sessionId}`);
      return typeof ack === 'function' && ack({ ok: false, reason: 'no_clients', message: 'No clients connected yet.' });
    }
    try { if (session.graceRedirectTimer) clearTimeout(session.graceRedirectTimer); } catch (_) {}
    session.graceRedirectTimer = null;
    session.graceRedirectEndMs = null;
    const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host');
    if (hostPeer) {
      console.log(`🚀 Host ${hostPeer.peerId} clicked "Go to Main Immediately" - redirecting to main.`);
      // Update host's page state to main
      hostPeer.currentPage = 'main';
      session.peers.set(hostPeer.peerId, hostPeer);
      if (typeof ack === 'function') ack({ ok: true });
      io.to(hostPeer.socketId).emit('redirect-host-to-main');
    } else {
      if (typeof ack === 'function') ack({ ok: false, reason: 'no_host' });
    }
  });

  // Host may extend the grace window (adds another 30s, capped at 2 minutes total)
  socket.on('host-extend-redirect', ({ sessionId }, ack) => {
    const session = sessions.get(sessionId);
    if (!session) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'session_not_found' });
      return;
    }
    
    const now = Date.now();
    const MAX_GRACE_MS = 120000; // 2 minutes cap
    const EXTEND_MS = 30000; // 30s per extend
    const startedAt = (session.graceRedirectEndMs ? (session.graceRedirectEndMs - 30000) : now);
    const totalSoFar = Math.max(0, now - (startedAt));
    
    if (totalSoFar >= MAX_GRACE_MS) {
      console.log(`Grace window maxed out for session ${sessionId}`);
      if (typeof ack === 'function') ack({ ok: false, reason: 'max_extended', message: 'Grace period already at maximum (2 minutes).' });
      return;
    }
    
    // Compute new end
    const remaining = Math.max(0, (session.graceRedirectEndMs || now) - now);
    const newDuration = Math.min(MAX_GRACE_MS - totalSoFar, remaining + EXTEND_MS);
    session.graceRedirectEndMs = now + newDuration;
    
    // Reset timer
    try { if (session.graceRedirectTimer) clearTimeout(session.graceRedirectTimer); } catch (_) {}
    session.graceRedirectTimer = setTimeout(() => {
      const current = sessions.get(sessionId);
      if (!current) return;
      try { if (current.graceRedirectTimer) clearTimeout(current.graceRedirectTimer); } catch (_) {}
      current.graceRedirectTimer = null;
      current.graceRedirectEndMs = null;
      const currentHost = Array.from(current.peers.values()).find(p => p.role === 'host');
      if (currentHost) io.to(currentHost.socketId).emit('redirect-host-to-main');
    }, newDuration);
    
    // Inform host to update countdown UI with new remaining seconds
    io.in(sessionId).emit('start-host-redirect-countdown', { durationSeconds: Math.ceil(newDuration / 1000) });
    console.log(`Extended host redirect grace window to ${Math.ceil(newDuration / 1000)}s for session ${sessionId}`);
    
    // Send acknowledgment to frontend
    if (typeof ack === 'function') ack({ ok: true, newDuration: Math.ceil(newDuration / 1000) });
  });

  // Mark the host as being on the main page as soon as they intend to navigate there
  socket.on('host-going-to-main', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host');
    if (hostPeer) {
      hostPeer.currentPage = 'main';
      session.peers.set(hostPeer.peerId, hostPeer);
      console.log(`🌟 Host ${hostPeer.peerId} marked as on main page (pre-navigation)`);
      const connectedPeers = Array.from(session.peers.values()).filter(p => !p.isDisconnected);
      io.in(sessionId).emit('peers-updated', connectedPeers);
      
      // Clear grace timer when host goes to main page
      try { if (session.graceRedirectTimer) clearTimeout(session.graceRedirectTimer); } catch (_) {}
      session.graceRedirectTimer = null;
      session.graceRedirectEndMs = null;
      console.log(`🧹 Grace timer cleared for host going to main page`);
      
      // Notify frontend to clear the timer display
      io.to(hostPeer.socketId).emit('grace-timer-cleared');
      
      // Also release any stale locks now that host is ready
      try { checkAndReleaseStaleTransferLocks(sessionId); } catch (_) {}
    }
  });

  // 🎯 ENHANCED: Send lock system with automatic redirects
  socket.on('request-send-lock', ({ sessionId, senderId }, ack) => {
    const session = sessions.get(sessionId);
    if (!session) return typeof ack === 'function' && ack({ ok: false, reason: 'session_not_found' });
    
    // Check if host is in the main page
    const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host');
    const hostInMainPage = hostPeer && hostPeer.currentPage === 'main';
    
    // If host is not in main page, but exists or grace window is active, proactively move host to main and proceed
    if (!hostInMainPage) {
      if (hostPeer) {
        console.log(`⚠️ Host not on main, proactively redirecting for sender ${senderId}`);
        try {
          // Update host's page state to main
          hostPeer.currentPage = 'main';
          session.peers.set(hostPeer.peerId, hostPeer);
          const connectedPeers = Array.from(session.peers.values()).filter(p => !p.isDisconnected);
          io.in(sessionId).emit('peers-updated', connectedPeers);
          // Trigger host to navigate now
          io.to(hostPeer.socketId).emit('redirect-host-to-main');
          // Clear grace timer if running
          try { if (session.graceRedirectTimer) clearTimeout(session.graceRedirectTimer); } catch (_) {}
          session.graceRedirectTimer = null;
          session.graceRedirectEndMs = null;
          // Release any stale locks
          checkAndReleaseStaleTransferLocks(sessionId);
        } catch (_) {}
      } else {
        console.log(`❌ No host present in session, rejecting send lock request from ${senderId}`);
        return typeof ack === 'function' && ack({ ok: false, reason: 'host_not_ready', message: 'Please wait for the host to connect (30 seconds delay).' });
      }
    }
    
    // 🎯 ENHANCED CHECK: If someone is in send page, lock send button for others AND redirect them to receive
    const peersInSendPage = Array.from(session.peers.values()).filter(p => 
      p.currentPage === 'send' && !p.isDisconnected
    );
    
    if (peersInSendPage.length > 0) {
      const senderInSendPage = peersInSendPage.find(p => p.peerId === senderId);
      if (!senderInSendPage) {
        console.log(`🚫 Blocking send lock for ${senderId} - ${peersInSendPage.length} peer(s) currently in send page`);
        
        // 🆕 NEW: Automatically redirect this peer to receive page since sender is active
        const peer = session.peers.get(senderId);
        if (peer) {
          console.log(`🔄 Automatically redirecting ${senderId} to receive page since sender is active`);
          io.to(peer.socketId).emit('auto-redirect-to-receive', {
            reason: 'sender_already_active',
            senderName: peersInSendPage[0].deviceName || peersInSendPage[0].peerId,
            message: 'Someone is already sending files. You have been redirected to the receive page.',
            sessionId: sessionId,
            role: peer.role,
            peerId: peer.peerId
          });
          
          // Update their page state to receive
          peer.currentPage = 'receive';
          session.peers.set(senderId, peer);
        }
        
        return typeof ack === 'function' && ack({ 
          ok: false, 
          reason: 'send_page_occupied', 
          message: 'Someone is currently sending files. You have been redirected to the receive page.',
          autoRedirect: true
        });
      }
    }

    // Check if there's an active transfer lock
    if (session.currentSenderPeerId && session.currentSenderPeerId !== senderId) {
      console.log(`🚫 Send lock already held by ${session.currentSenderPeerId}, rejecting ${senderId}`);
      return typeof ack === 'function' && ack({ 
        ok: false, 
        reason: 'locked', 
        message: 'Another file transfer is already in progress. Please wait.',
        currentSender: session.currentSenderPeerId
      });
    }

    // Grant send lock
    session.currentSenderPeerId = senderId;
    console.log(`✅ Granted send lock to ${senderId} - no peers currently in send page`);
    
    // 🆕 NEW: Notify all peers that send button is now locked
    io.in(sessionId).emit('send-button-locked', {
      lockedBy: senderId,
      message: 'Send button is now locked. File transfer in progress.',
      timestamp: Date.now()
    });
    
    return typeof ack === 'function' && ack({ ok: true });
  });

  socket.on('release-send-lock', ({ sessionId, senderId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.currentSenderPeerId === senderId) {
      session.currentSenderPeerId = null;
      console.log(`🔓 Send lock released by ${senderId} in session ${sessionId}`);
      
      // 🆕 NEW: Check if there are still senders in send page before unlocking
      const sendersInSendPage = Array.from(session.peers.values()).filter(p => 
        p.currentPage === 'send' && !p.isDisconnected
      );
      
      if (sendersInSendPage.length === 0) {
        console.log(`🔓 No senders in send page, unlocking send button`);
        
        // Notify all peers that send button is now unlocked
        io.in(sessionId).emit('send-button-unlocked', {
          unlockedBy: senderId,
          message: 'Send button is now unlocked. You can start a new file transfer.',
          timestamp: Date.now()
        });
        
        io.in(sessionId).emit('transfer-unlocked');
      } else {
        console.log(`🔒 Send button remains locked - ${sendersInSendPage.length} sender(s) still in send page`);
      }
    }
  });
  
  // Add a function to check and release any stale locks
  function checkAndReleaseStaleTransferLocks(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    // If there's a current sender but no active transfer, release the lock
    if (session.currentSenderPeerId && !session.activeTransfer) {
      console.log(`Releasing stale send lock for ${session.currentSenderPeerId} in session ${sessionId}`);
      session.currentSenderPeerId = null;
      io.in(sessionId).emit('transfer-unlocked');
    }
  }

  // Replace the request-to-send handler in server.js with this corrected version:

socket.on('request-to-send', ({ sessionId, file, senderId }) => {
  console.log(`Send request from ${senderId} for file ${file.id}`);
  
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`❌ Session ${sessionId} not found for send request`);
    return socket.emit('send-rejected', { fileId: file.id, reason: 'Session not found' });
  }
  
  if (session.activeTransfer) {
    console.log(`❌ Active transfer in progress, rejecting ${file.id}`);
    return socket.emit('send-rejected', { fileId: file.id, reason: 'Another transfer is in progress.' });
  }
  
  // FIXED: Find all peers except the sender as potential receivers
  const receivers = Array.from(session.peers.values()).filter(p => p.peerId !== senderId);
  console.log(`Available receivers:`, receivers.map(r => `${r.peerId}(${r.role})`));
  
  if (receivers.length === 0) {
    console.log(`❌ No receivers available for ${file.id}`);
    return socket.emit('send-rejected', { fileId: file.id, reason: 'No receivers available.' });
  }
  
  session.activeTransfer = {
    senderPeerId: senderId,
    fileId: file.id,
    acceptedReceivers: new Set(),
    rejectedReceivers: new Set(),
    receiversSnapshot: receivers.map(r => r.peerId),
    // offerTimer removed - using only responseTimer now
    responseTimer: null,
    responseDeadlineMs: null,
    totalResponses: 0
  };
  console.log(`✅ Send approved for ${file.id}, notifying ${receivers.length} receivers`);
  
  socket.emit('send-approved', { fileId: file.id });
  
  // Add cooldown to prevent abandoned sender check from running immediately
  session.recentSendRequestAt = Date.now();
  
  // Redirect all other peers (receivers) to receive page
  receivers.forEach(receiver => {
    console.log(`Redirecting ${receiver.peerId} to receive page`);
    // Update receiver's page state immediately
    receiver.currentPage = 'receive';
    session.peers.set(receiver.peerId, receiver);
    io.to(receiver.socketId).emit('force-redirect-to-receive', { forced: true });
  });
  
  // Update sender's page state to send
  const sender = session.peers.get(senderId);
  if (sender) {
    sender.currentPage = 'send';
    session.peers.set(senderId, sender);
    console.log(`📤 Updated sender ${senderId} page state to send`);
  }

  // Also immediately offer file metadata to receivers
  const senderName = sender ? sender.deviceName : 'Unknown Device';
  receivers.forEach(receiver => {
    io.to(receiver.socketId).emit('file-offer', { file, senderId, senderName });
  });

  // Start 30-second timer to check if all receivers have responded
  try {
    if (session.activeTransfer.responseTimer) clearTimeout(session.activeTransfer.responseTimer);
  } catch (_) {}
  
  // Emit the timer start event to all clients, including those on the index page
  io.in(sessionId).emit('response-timer-started', { 
    fileId: file.id, 
    duration: 30, 
    totalReceivers: receivers.length 
  });
  
  // Also emit to any sockets in the session that might be on the index page
  const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host');
  const hostSocket = hostPeer ? io.sockets.sockets.get(hostPeer.socketId) : null;
  if (hostSocket) {
    console.log(`Emitting response timer to host on index page`);
    hostSocket.emit('response-timer-started', { 
      fileId: file.id, 
      duration: 30, 
      totalReceivers: receivers.length 
    });
  }
  
  // Track response deadline and timer
  session.activeTransfer.responseDeadlineMs = Date.now() + 30000;
  session.activeTransfer.responseTimer = setTimeout(() => {
    const current = sessions.get(sessionId);
    if (!current || !current.activeTransfer) return;
    if (current.activeTransfer.fileId !== file.id) return;
    
    console.log(`Response timer expired for file ${file.id}`);
    
    const totalReceivers = current.activeTransfer.receiversSnapshot.length;
    const acceptedCount = current.activeTransfer.acceptedReceivers.size;
    const totalResponses = current.activeTransfer.totalResponses;
    
    console.log(`Timer expired - Responses: ${totalResponses}/${totalReceivers}, Accepted: ${acceptedCount}`);
    
    // Timer expired - make decision based on current state
    if (acceptedCount > 0) {
      // At least one receiver accepted, start upload
      const sender = current.peers.get(senderId);
      if (sender) {
        console.log(`Timer expired - Starting upload for ${file.id} (${acceptedCount} accepted)`);
        io.to(sender.socketId).emit('start-upload', { fileId: file.id });
      }
      
      // Inform only accepted receivers that the sender has started preparing upload
      for (const receiverPeerId of current.activeTransfer.acceptedReceivers || []) {
        const receiver = current.peers.get(receiverPeerId);
        if (receiver) {
          io.to(receiver.socketId).emit('upload-started', { fileId: file.id });
        }
      }
    } else {
      // No one accepted, move to next file
      const sender = current.peers.get(senderId);
      if (sender) {
        console.log(`Timer expired - No accepts for ${file.id}, moving to next file`);
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
  console.log(`File uploaded, offering ${file.name} to peers`);
  
  const session = sessions.get(sessionId);
  if (!session) return;
  
  const history = transferHistory.get(sessionId) || [];
  history.unshift({
    id: file.id,
    fileName: file.name,
    fileSize: file.size,
    sender: senderId,
    status: 'pending',
    timestamp: new Date().toISOString()
  });
  transferHistory.set(sessionId, history);
  io.in(sessionId).emit('history-updated', history);

  // FIXED: Offer to all peers except sender (regardless of role)
  const receivers = Array.from(session.peers.values()).filter(p => p.peerId !== senderId);
  console.log(`Offering file to:`, receivers.map(r => `${r.peerId}(${r.role})`));
  
  const sender = session.peers.get(senderId);
  const senderName = sender ? sender.deviceName : 'Unknown Device';
  receivers.forEach(receiver => {
    io.to(receiver.socketId).emit('file-offer', { file, senderId, senderName });
  });
});

  socket.on('file-uploaded-offer-to-peers', ({ sessionId, file, senderId }) => {
    console.log(`File uploaded, offering ${file.name} to peers`);
    
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const history = transferHistory.get(sessionId) || [];
    history.unshift({
      id: file.id,
      fileName: file.name,
      fileSize: file.size,
      sender: senderId,
      status: 'pending',
      timestamp: new Date().toISOString()
    });
    transferHistory.set(sessionId, history);
    io.in(sessionId).emit('history-updated', history);

    // Offer to all clients except sender
    const receivers = Array.from(session.peers.values()).filter(p => p.role === 'client' && p.peerId !== senderId);
    const sender = session.peers.get(senderId);
    const senderName = sender ? sender.deviceName : 'Unknown Device';
    receivers.forEach(receiver => {
      io.to(receiver.socketId).emit('file-offer', { file, senderId, senderName });
    });
  });

  socket.on('accept-file', ({ sessionId, fileId, receiverPeerId }) => {
    console.log(`File ${fileId} accepted by ${receiverPeerId}`);
    const session = sessions.get(sessionId);
    if (!session) return;
    if (!session.activeTransfer || session.activeTransfer.fileId !== fileId) return;
    session.activeTransfer.acceptedReceivers.add(receiverPeerId);
    session.activeTransfer.totalResponses++;
    
    const totalReceivers = session.activeTransfer.receiversSnapshot.length;
    const totalResponses = session.activeTransfer.totalResponses;
    const acceptedCount = session.activeTransfer.acceptedReceivers.size;
    
    console.log(`Accept response: ${totalResponses}/${totalReceivers} responses, ${acceptedCount} accepted`);
    
    // Update all clients with the response count
    io.in(sessionId).emit('response-count-updated', { 
      fileId, 
      totalResponses, 
      totalReceivers 
    });
    
    // Also emit to the host if they're on the index page
    const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host');
    const hostSocket = hostPeer ? io.sockets.sockets.get(hostPeer.socketId) : null;
    if (hostSocket) {
      console.log(`Emitting response count update to host on index page`);
      hostSocket.emit('response-count-updated', {
        fileId,
        totalResponses,
        totalReceivers
      });
    }
    
    // Check if all receivers have responded
    if (totalResponses >= totalReceivers) {
      console.log(`All responses received for ${fileId}: ${totalResponses}/${totalReceivers}`);
      
      // Clear the response timer as all have responded
      try { if (session.activeTransfer.responseTimer) clearTimeout(session.activeTransfer.responseTimer); } catch (_) {}
      
      // Check if at least one accepted
      if (session.activeTransfer.acceptedReceivers.size > 0) {
        // At least one accepted, start upload
        const senderPeerId = session.activeTransfer.senderPeerId;
        const sender = session.peers.get(senderPeerId);
        if (sender) {
          console.log(`All responses received - Starting upload for ${fileId} (${session.activeTransfer.acceptedReceivers.size} accepted)`);
          io.to(sender.socketId).emit('start-upload', { fileId });
        }
        // Inform only accepted receivers that the sender has started preparing upload
        for (const receiverPeerId of session.activeTransfer.acceptedReceivers || []) {
          const receiver = session.peers.get(receiverPeerId);
          if (receiver) {
            io.to(receiver.socketId).emit('upload-started', { fileId });
          }
        }
      } else {
        // All rejected, notify sender and unlock for next file
        const senderPeerId = session.activeTransfer.senderPeerId;
        const sender = session.peers.get(senderPeerId);
        if (sender) {
          console.log(`All responses received - All rejected for ${fileId}, moving to next file`);
          io.to(sender.socketId).emit('all-rejected', { fileId });
        }
        session.activeTransfer = null;
        session.currentSenderPeerId = null; // Release the send lock
        io.in(sessionId).emit('transfer-unlocked');
      }
    } else {
      console.log(`Waiting for more responses: ${totalResponses}/${totalReceivers} received`);
    }
    // Note: We don't start upload on first accept anymore - wait for all responses or timer
  });

  socket.on('reject-file', ({ sessionId, fileId, receiverPeerId }) => {
    console.log(`File ${fileId} rejected by ${receiverPeerId}`);
    const session = sessions.get(sessionId);
    if (!session || !session.activeTransfer) return;
    if (session.activeTransfer.fileId !== fileId) return;
    session.activeTransfer.rejectedReceivers.add(receiverPeerId);
    session.activeTransfer.totalResponses++;
    
    const totalReceivers = session.activeTransfer.receiversSnapshot.length;
    const totalResponses = session.activeTransfer.totalResponses;
    const acceptedCount = session.activeTransfer.acceptedReceivers.size;
    
    console.log(`Reject response: ${totalResponses}/${totalReceivers} responses, ${acceptedCount} accepted`);
    
    // Update all clients with the response count
    io.in(sessionId).emit('response-count-updated', { 
      fileId, 
      totalResponses, 
      totalReceivers 
    });
    
    // Also emit to the host if they're on the index page
    const hostPeer = Array.from(session.peers.values()).find(p => p.role === 'host');
    const hostSocket = hostPeer ? io.sockets.sockets.get(hostPeer.socketId) : null;
    if (hostSocket) {
      console.log(`Emitting response count update to host on index page`);
      hostSocket.emit('response-count-updated', {
        fileId,
        totalResponses,
        totalReceivers
      });
    }
    
    const senderPeerId = session.activeTransfer.senderPeerId;
    const sender = session.peers.get(senderPeerId);
    // Notify sender of a single rejection
    if (sender) io.to(sender.socketId).emit('receiver-rejected', { fileId, receiverPeerId });
    
    // Check if all receivers have responded
    if (totalResponses >= totalReceivers) {
      console.log(`All responses received for ${fileId}: ${totalResponses}/${totalReceivers}`);
      
      // Clear the response timer as all have responded
      try { 
        if (session.activeTransfer.responseTimer) clearTimeout(session.activeTransfer.responseTimer);
      } catch (_) {}
      
      // Check if at least one accepted
      if (session.activeTransfer.acceptedReceivers.size > 0) {
        // At least one accepted, start upload
        if (sender) {
          console.log(`All responses received - Starting upload for ${fileId} (${session.activeTransfer.acceptedReceivers.size} accepted)`);
          io.to(sender.socketId).emit('start-upload', { fileId });
        }
        // Inform only accepted receivers that the sender has started preparing upload
        for (const receiverPeerId of session.activeTransfer.acceptedReceivers || []) {
          const receiver = session.peers.get(receiverPeerId);
          if (receiver) {
            io.to(receiver.socketId).emit('upload-started', { fileId });
          }
        }
      } else {
        // All rejected, notify sender and unlock for next file
        if (sender) {
          console.log(`All responses received - All rejected for ${fileId}, moving to next file`);
          io.to(sender.socketId).emit('all-rejected', { fileId });
        }
        session.activeTransfer = null;
        session.currentSenderPeerId = null; // Release the send lock
        io.in(sessionId).emit('transfer-unlocked');
      }
    } else {
      console.log(`Waiting for more responses: ${totalResponses}/${totalReceivers} received`);
    }
  });

  socket.on('transfer-complete', ({ sessionId }) => {
    console.log(`Transfer complete for session ${sessionId}`);
    const session = sessions.get(sessionId);
    if (session) {
      session.activeTransfer = null;
      session.currentSenderPeerId = null; // Release the send lock
      io.in(sessionId).emit('transfer-unlocked');
    }
  });

  // Sender notifies server when upload completed so we can deliver download URLs
  socket.on('upload-complete', ({ sessionId, file }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.activeTransfer) {
      // If there's no active transfer but we got an upload-complete event,
      // check and release any stale locks
      checkAndReleaseStaleTransferLocks(sessionId);
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
        console.log(`📊 Pending downloads for ${file.name}: ${meta.pending}`);
      }
    } catch (e) {
      console.error('Failed to set pending counter for file:', e);
    }
    
    // Check each receiver's download queue before sending
    for (const receiverPeerId of acceptedReceivers || []) {
      const receiver = session.peers.get(receiverPeerId);
      if (receiver) {
        // Record per-receiver recent transfer with names
        try {
          const senderPeer = session.peers.get(session.activeTransfer.senderPeerId) || {};
          recentTransfers.push({
            senderId: session.activeTransfer.senderPeerId,
            senderName: senderPeer.deviceName || '',
            receiverId: receiverPeerId,
            receiverName: receiver.deviceName || '',
            fileName: file.name,
            size: file.size,
            timestamp: Date.now()
          });
          if (recentTransfers.length > 100) recentTransfers.splice(0, recentTransfers.length - 100);
        } catch (_) {}
        // Check if receiver has an empty download queue
        const sessionDownloadQueue = receiverDownloadQueues.get(sessionId);
        const receiverQueue = sessionDownloadQueue?.get(receiverPeerId) || [];
        
        // Check download flag for this receiver
        // Determine current active count
        let activeCount = 0;
        if (receiverActiveDownloads.has(sessionId)) {
          activeCount = receiverActiveDownloads.get(sessionId).get(receiverPeerId) || 0;
        }

        if (activeCount < MAX_CONCURRENT_DOWNLOADS_PER_RECEIVER) {
          // Download flag is 0 (ready), send file immediately
          const downloadUrl = `${baseDownloadUrl}?receiver=${encodeURIComponent(receiverPeerId)}`;
          console.log(`🚀 SENDING FILE: ${file.name} to ${receiverPeerId} (download flag = 0, browser should start download now)`);
          io.to(receiver.socketId).emit('download-ready', { file, downloadUrl });
          
          // Increment active downloads
          if (!receiverActiveDownloads.has(sessionId)) receiverActiveDownloads.set(sessionId, new Map());
          const m = receiverActiveDownloads.get(sessionId);
          m.set(receiverPeerId, (m.get(receiverPeerId) || 0) + 1);
          console.log(`📥 Active downloads for ${receiverPeerId}: ${m.get(receiverPeerId)}`);
          
          // Queue progression will now be driven by actual download completion in /download route
          
        } else {
          // Download flag is 1 (downloading), add to queue
          console.log(`File ${file.name} waiting for ${receiverPeerId} to finish current download`);
          
          // Add to queue for later processing
          if (!receiverDownloadQueues.has(sessionId)) {
            receiverDownloadQueues.set(sessionId, new Map());
          }
          if (!receiverDownloadQueues.get(sessionId).has(receiverPeerId)) {
            receiverDownloadQueues.get(sessionId).set(receiverPeerId, []);
          }
          const queuedUrl = `${baseDownloadUrl}?receiver=${encodeURIComponent(receiverPeerId)}`;
          receiverDownloadQueues.get(sessionId).get(receiverPeerId).push({ file, downloadUrl: queuedUrl });
          
          // Debug: Show current queue state
          const currentQueue = receiverDownloadQueues.get(sessionId).get(receiverPeerId);
          console.log(`Queue state for ${receiverPeerId}: ${currentQueue.length} files waiting`);
          currentQueue.forEach((item, index) => {
            console.log(`  [${index}] ${item.file.name}`);
          });
        }
      }
    }
    // Notify clients that recent history changed
    try { io.in(sessionId).emit('recent-updated'); } catch (_) {}
    
    // Clear active transfer and release sender lock so new sends can start
    session.activeTransfer = null;
    session.currentSenderPeerId = null;
    session.lastTransferCompletedAt = Date.now(); // Track when transfer completed
    io.in(sessionId).emit('transfer-unlocked');
  });

  // Function to start 5-second timer for checking download flag and sending next file
  function startDownloadTimer(sessionId, receiverPeerId) {
    console.log(`Starting 5-second download timer for ${receiverPeerId}`);
    
    setTimeout(() => {
      console.log(`Download timer fired for ${receiverPeerId}`);
      
      // Check if receiver still exists and has files in queue
      const session = sessions.get(sessionId);
      if (!session) return;
      
      const receiver = session.peers.get(receiverPeerId);
      if (!receiver) return;
      
      const sessionDownloadQueue = receiverDownloadQueues.get(sessionId);
      if (!sessionDownloadQueue) return;
      
      const receiverQueue = sessionDownloadQueue.get(receiverPeerId);
      if (!receiverQueue || receiverQueue.length === 0) return;
      
      // Set download flag to 0 (ready) and send next file
      if (receiverDownloadFlags.has(sessionId)) {
        receiverDownloadFlags.get(sessionId).set(receiverPeerId, false);
        console.log(`📥 Download flag reset to 0 (ready) for ${receiverPeerId}`);
      }
      
      // Get the top file from queue
      const nextFile = receiverQueue.shift();
      console.log(`🚀 SENDING QUEUED FILE: ${nextFile.file.name} to ${receiverPeerId} (download flag was 0, browser should start download now)`);
      
      // Send the file
      io.to(receiver.socketId).emit('download-ready', { 
        file: nextFile.file, 
        downloadUrl: nextFile.downloadUrl 
      });
      
      // Set download flag to 1 (downloading) and start timer again
      if (!receiverDownloadFlags.has(sessionId)) {
        receiverDownloadFlags.set(sessionId, new Map());
      }
      receiverDownloadFlags.get(sessionId).set(receiverPeerId, true);
      
      // If there are more files in queue, start timer again
      if (receiverQueue.length > 0) {
        startDownloadTimer(sessionId, receiverPeerId);
      } else {
        // Queue is empty, clean up
        sessionDownloadQueue.delete(receiverPeerId);
        if (sessionDownloadQueue.size === 0) {
          receiverDownloadQueues.delete(sessionId);
        }
        console.log(`Queue empty for ${receiverPeerId}, cleanup complete`);
      }
    }, 5000); // 5-second timer as requested
  }

  // Relay sender upload progress to receivers for UI updates
  socket.on('sender-progress', ({ sessionId, fileId, loaded, total, speedBps, etaSeconds }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.activeTransfer || session.activeTransfer.fileId !== fileId) return;
    
    // Only send progress to receivers who accepted the file
    const { acceptedReceivers } = session.activeTransfer;
    for (const receiverPeerId of acceptedReceivers || []) {
      const receiver = session.peers.get(receiverPeerId);
      if (receiver) {
        io.to(receiver.socketId).emit('sender-progress', { fileId, loaded, total, speedBps, etaSeconds });
      }
    }
  });

  // Allow sender to extend the response window by 30 seconds (adds to remaining)
  socket.on('extend-response-timer', ({ sessionId, fileId, senderId }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.activeTransfer) return;
    if (session.activeTransfer.fileId !== fileId) return;
    if (session.activeTransfer.senderPeerId !== senderId) return;

    // Compute remaining; add 30s; reset timer to new deadline
    const now = Date.now();
    const remainingMs = Math.max(0, (session.activeTransfer.responseDeadlineMs || now) - now);
    const newRemainingMs = remainingMs + 30000;
    session.activeTransfer.responseDeadlineMs = now + newRemainingMs;

    try { if (session.activeTransfer.responseTimer) clearTimeout(session.activeTransfer.responseTimer); } catch (_) {}
    const totalReceivers = session.activeTransfer.receiversSnapshot.length;
    io.in(sessionId).emit('response-timer-started', { fileId, duration: Math.ceil(newRemainingMs / 1000), totalReceivers });

    session.activeTransfer.responseTimer = setTimeout(() => {
      const current = sessions.get(sessionId);
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
    const session = sessions.get(sessionId);
    if (!session || !session.activeTransfer) return;
    if (session.activeTransfer.fileId !== fileId) return;
    if (session.activeTransfer.senderPeerId !== senderId) return;
    try { if (session.activeTransfer.responseTimer) clearTimeout(session.activeTransfer.responseTimer); } catch (_) {}
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
    const session = sessions.get(sessionId);
    if (!session || !session.activeTransfer) return;
    if (session.activeTransfer.fileId !== fileId) return;
    if (session.activeTransfer.senderPeerId !== senderId) return;
    // Clear timers and active transfer, keep the sender lock so they can immediately send next
    try { if (session.activeTransfer.responseTimer) clearTimeout(session.activeTransfer.responseTimer); } catch (_) {}
    session.activeTransfer = null;
    session.currentSenderPeerId = null; // Release the send lock
    io.in(sessionId).emit('transfer-unlocked');
  });

  // Sender cancels or goes back: unlock and return everyone to main page
  socket.on('cancel-transfer', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.activeTransfer = null;
    session.currentSenderPeerId = null;
    io.in(sessionId).emit('transfer-unlocked');
    io.in(sessionId).emit('return-all-to-main');
  });

  // 📍 NEW: Track when users enter receive page
  socket.on('enter-receive-page', ({ sessionId, peerId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const peer = session.peers.get(peerId);
    if (peer) {
      // Check if peer was already in receive page (page refresh scenario)
      const wasAlreadyInReceivePage = peer.currentPage === 'receive';
      
      peer.currentPage = 'receive';
      session.peers.set(peerId, peer);
      console.log(`📥 Peer ${peerId} entered receive page in session ${sessionId} (was already in receive: ${wasAlreadyInReceivePage})`);
      
      // 🆕 NEW: Add cooldown to prevent abandoned sender check from running immediately after enter-receive-page
      session.recentEnterReceivePageAt = Date.now();
    }
  });

  // 📍 NEW: Track when users navigate to PIN page (browser back scenario)
  socket.on('enter-pin-page', ({ sessionId, peerId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const peer = session.peers.get(peerId);
    if (peer) {
      console.log(`📱 Peer ${peerId} navigated to PIN page in session ${sessionId}`);
      
      // Update peer's page state to indicate they're on PIN page
      peer.currentPage = 'pin';
      peer.inMain = false; // They're not on main page anymore
      session.peers.set(peerId, peer);
      
      // 🆕 NEW: Notify host about peer count change
      const connectedOnMain = Array.from(session.peers.values()).filter(p => 
        !p.isDisconnected && p.inMain === true && p.currentPage === 'main'
      );
      io.in(sessionId).emit("peer-count-updated", { count: connectedOnMain.length });
      
      // 🆕 NEW: Emit peers-updated event to update peer count display
      const connectedPeers = Array.from(session.peers.values()).filter(p => !p.isDisconnected);
      io.in(sessionId).emit('peers-updated', connectedPeers);
      
      // Check if there's a sender in send page with no receivers now
      const sendersInSendPage = Array.from(session.peers.values()).filter(p => 
        p.currentPage === 'send' && !p.isDisconnected
      );
      
      const receiversInReceivePage = Array.from(session.peers.values()).filter(p => 
        p.currentPage === 'receive' && !p.isDisconnected
      );
      
      if (sendersInSendPage.length > 0 && receiversInReceivePage.length === 0) {
        console.log(`🔄 No receivers in receive page after ${peerId} went to PIN page - redirecting sender to main`);
        
        // Redirect sender to main page
        sendersInSendPage.forEach(sender => {
          sender.currentPage = 'main';
          sender.inMain = true;
          session.peers.set(sender.peerId, sender);
          
          io.to(sender.socketId).emit('redirect-to-main-due-to-no-receivers', {
            reason: 'no_receivers_after_pin_navigation',
            message: 'No receivers are waiting. You have been redirected to the main page.',
            sessionId: sessionId,
            role: sender.role,
            peerId: sender.peerId
          });
        });
      }
    }
  });

  // 📍 NEW: Track when users leave receive page
  socket.on('leave-receive-page', ({ sessionId, peerId }) => {
    console.log(`📥 leave-receive-page event received from ${peerId} in session ${sessionId}`);
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`❌ Session ${sessionId} not found for leave-receive-page`);
      return;
    }
    
    const peer = session.peers.get(peerId);
    if (peer) {
      peer.currentPage = 'main';
      session.peers.set(peerId, peer);
      console.log(`📥 Peer ${peerId} left receive page in session ${sessionId}`);
      
      // 🆕 NEW: Check if sender is alone in send page after receiver left
      const senderInSendPage = Array.from(session.peers.values()).find(p => 
        p.currentPage === 'send' && !p.isDisconnected
      );
      
      if (senderInSendPage) {
        const receiversInReceivePage = Array.from(session.peers.values()).filter(p => 
          p.currentPage === 'receive' && !p.isDisconnected
        );
        
        console.log(`🔍 After receiver ${peerId} left: ${receiversInReceivePage.length} receivers still in receive page`);
        
        if (receiversInReceivePage.length === 0) {
          console.log(`🔄 Receiver ${peerId} left receive page, no more receivers waiting for sender ${senderInSendPage.peerId} - redirecting sender to main page`);
          
          // Redirect sender to main page since no receivers are waiting
          io.to(senderInSendPage.socketId).emit('redirect-sender-to-main-no-receivers', {
            reason: 'no_receivers_waiting',
            message: 'No receivers are currently waiting. You have been redirected to the main page.',
            sessionId: sessionId,
            role: senderInSendPage.role,
            peerId: senderInSendPage.peerId
          });
          
          // Update sender's page state to main
          senderInSendPage.currentPage = 'main';
          session.peers.set(senderInSendPage.peerId, senderInSendPage);
          
          // Release the send lock since sender is no longer in send page
          if (session.currentSenderPeerId === senderInSendPage.peerId) {
            session.currentSenderPeerId = null;
            console.log(`🔓 Send lock released for ${senderInSendPage.peerId} - no receivers waiting`);
            
            // Notify all peers that send button is now unlocked
            io.in(sessionId).emit('send-button-unlocked', {
              unlockedBy: senderInSendPage.peerId,
              message: 'Send button is now unlocked. No active sender.',
              timestamp: Date.now()
            });
          }
        } else {
          console.log(`🔄 Receiver ${peerId} left receive page, but sender ${senderInSendPage.peerId} still has ${receiversInReceivePage.length} receivers waiting`);
        }
      } else {
        console.log(`ℹ️ Receiver ${peerId} left receive page, but no sender found in send page`);
      }
    } else {
      console.log(`⚠️ Peer ${peerId} not found in session ${sessionId} when trying to leave receive page`);
    }
  });

  // 📍 NEW: Track when users enter send page
  socket.on('enter-send-page', ({ sessionId, peerId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const peer = session.peers.get(peerId);
    if (peer) {
      // Check if peer was already in send page (page refresh scenario)
      const wasAlreadyInSendPage = peer.currentPage === 'send';
      
      peer.currentPage = 'send';
      session.peers.set(peerId, peer);
      console.log(`📤 Peer ${peerId} entered send page in session ${sessionId} (was already in send: ${wasAlreadyInSendPage})`);
      
      // 🆕 NEW: Add cooldown to prevent abandoned sender check from running immediately after enter-send-page
      session.recentEnterSendPageAt = Date.now();
      
      // Only redirect other peers if this is NOT a page refresh
      if (!wasAlreadyInSendPage) {
        // Redirect all other peers to RECEIVE page
        const otherPeers = Array.from(session.peers.values()).filter(p => 
          p.peerId !== peerId && p.currentPage !== 'send' && !p.isDisconnected
        );
        
        otherPeers.forEach(otherPeer => {
          console.log(`🔄 Redirecting ${otherPeer.peerId} to RECEIVE page (sender ${peerId} is in send page)`);
          
          // Update other peer's page state to receive
          otherPeer.currentPage = 'receive';
          session.peers.set(otherPeer.peerId, otherPeer);
          
          io.to(otherPeer.socketId).emit('force-redirect-to-receive', { 
            reason: 'sender_in_send_page',
            senderName: peer.deviceName || peer.peerId,
            message: 'A sender is active. You have been redirected to the receive page.',
            sessionId: sessionId,
            role: otherPeer.role,
            peerId: otherPeer.peerId,
            forced: true
          });
        });
      } else {
        console.log(`🔄 Send page refresh detected for ${peerId} - not redirecting other peers`);
      }
    }
  });

  // 📍 NEW: Track when users leave send page
  socket.on('leave-send-page', ({ sessionId, peerId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const peer = session.peers.get(peerId);
    if (peer) {
      peer.currentPage = 'main';
      session.peers.set(peerId, peer);
      console.log(`📤 Peer ${peerId} left send page in session ${sessionId}`);
      
      // 🆕 NEW: When sender leaves send page, redirect all receivers back to main page
      const receiversInReceivePage = Array.from(session.peers.values()).filter(p => 
        p.currentPage === 'receive' && !p.isDisconnected
      );
      
      if (receiversInReceivePage.length > 0) {
        console.log(`🔄 Sender ${peerId} left send page, redirecting ${receiversInReceivePage.length} receivers to main page`);
        
        receiversInReceivePage.forEach(receiver => {
          // Clear their receive page state
          receiver.currentPage = 'main';
          session.peers.set(receiver.peerId, receiver);
          
          // Redirect them to main page
          io.to(receiver.socketId).emit('redirect-to-main-due-to-sender-left-send-page', {
            reason: 'sender_left_send_page',
            senderName: peer.deviceName || peer.peerId,
            message: 'The sender has left the send page. You have been redirected to the main page.',
            sessionId: sessionId,
            role: receiver.role,
            peerId: receiver.peerId
          });
        });
      }
      
      // 🆕 NEW: Release the send lock since sender is no longer in send page
      if (session.currentSenderPeerId === peerId) {
        session.currentSenderPeerId = null;
        console.log(`🔓 Send lock released for ${peerId} - sender left send page`);
        
        // Notify all peers that send button is now unlocked
        io.in(sessionId).emit('send-button-unlocked', {
          unlockedBy: peerId,
          message: 'Send button is now unlocked. Sender left send page.',
          timestamp: Date.now()
        });
      }
    }
  });

  // 🆕 NEW: Track when users enter main page
  socket.on('enter-main-page', ({ sessionId, peerId, role }) => {
    console.log(`🔍 enter-main-page event received:`, { sessionId, peerId, role });
    
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`❌ Session ${sessionId} not found for enter-main-page`);
      return;
    }

    const peer = session.peers.get(peerId);
    if (peer) {
      console.log(`🔍 Peer before update:`, {
        peerId: peer.peerId,
        role: peer.role,
        currentPage: peer.currentPage,
        inMain: peer.inMain
      });
      
      peer.inMain = true;
      peer.currentPage = 'main';
      session.peers.set(peerId, peer);
      
      console.log(`✅ Updated peer ${peerId} to inMain=true, currentPage=main`);
      console.log(`🔍 Peer after update:`, {
        peerId: peer.peerId,
        role: peer.role,
        currentPage: peer.currentPage,
        inMain: peer.inMain
      });
    } else {
      console.log(`❌ Peer ${peerId} not found in session ${sessionId}`);
    }

    // 🆕 NEW: Check if this peer was previously in receive page and if sender is still in send page
    const senderInSendPage = Array.from(session.peers.values()).find(p => 
      p.currentPage === 'send' && !p.isDisconnected
    );
    
    if (senderInSendPage && peer.role !== 'host') {
      console.log(`🔄 Peer ${peerId} entered main page, but sender ${senderInSendPage.peerId} is still in send page - redirecting all non-senders to receive`);
      
      // Redirect ALL non-sender peers to receive to keep session aligned with active sender
      const peersToRedirect = Array.from(session.peers.values()).filter(p => 
        p.peerId !== senderInSendPage.peerId && !p.isDisconnected
      );
      
      peersToRedirect.forEach(target => {
        try {
          io.to(target.socketId).emit('force-redirect-to-receive', { 
            reason: 'sender_in_send_page',
            senderName: senderInSendPage.deviceName || senderInSendPage.peerId,
            sessionId: sessionId,
            role: target.role,
            peerId: target.peerId,
            forced: true
          });
          // Update their page state back to receive
          target.currentPage = 'receive';
          session.peers.set(target.peerId, target);
        } catch (e) {
          console.error('Failed to redirect peer to receive:', target.peerId, e);
        }
      });
    }

    // 🆕 NEW: Special handling for host entering main page - prepare navigation blocking
    if (peer.role === 'host') {
      console.log(`🚫 Host ${peerId} entered main page - preparing navigation blocking`);
      
      // Mark host as on main page (but not permanently locked)
      peer.currentPage = 'main';
      session.peers.set(peerId, peer);
      
      // Check if there are other connected peers
      const otherConnectedPeers = Array.from(session.peers.values()).filter(p => 
        p.peerId !== peerId && !p.isDisconnected
      );
      
      if (otherConnectedPeers.length > 0) {
        console.log(`🚫 Host ${peerId} has ${otherConnectedPeers.length} connected peers - navigation will be blocked if they try to leave`);
        
        // Don't emit navigation blocked yet - only when they actually try to leave
        // The blocking will happen in the leave-main-page event handler
      } else {
        console.log(`✅ Host ${peerId} entered main page with no other peers - navigation allowed`);
      }
    }

    // Count only verified clients in main
    const clientCount = Array.from(session.peers.values())
      .filter(p => p.role === "client" && p.inMain && !p.isDisconnected).length;

    console.log(`🔍 Enter main page - Client count in main: ${clientCount}`);
    console.log(`🔍 All peers after enter:`, Array.from(session.peers.values()).map(p => `${p.peerId}(${p.role}, inMain:${p.inMain}, disconnected:${p.isDisconnected})`));
    
    io.in(sessionId).emit("peer-count-updated", { count: clientCount });
  });

  // 🚫 NEW: Track when host leaves main page (navigation blocking)
  socket.on('leave-main-page', ({ sessionId, peerId, reason }) => {
    console.log(`🔍 leave-main-page event received:`, { sessionId, peerId, reason });
    
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`❌ Session ${sessionId} not found for leave-main-page`);
      return;
    }
    
    const peer = session.peers.get(peerId);
    if (!peer) {
      console.log(`❌ Peer ${peerId} not found in session ${sessionId}`);
      return;
    }
    
    console.log(`🔍 Peer details:`, {
      peerId: peer.peerId,
      role: peer.role,
      currentPage: peer.currentPage,
      isDisconnected: peer.isDisconnected,
      socketId: peer.socketId
    });
    
    if (peer.role === 'host') {
      console.log(`🚫 Host ${peerId} attempting to leave main page`);
      
      // 🆕 NEW: Allow auto-redirects and exits (don't block when reason is provided)
      if (reason && (reason === 'auto_redirect_to_send' || reason === 'auto_redirect_to_receive' || reason === 'host_exit_session')) {
        console.log(`✅ Host ${peerId} ${reason} - allowing navigation`);
        
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
        console.log(`✅ Host ${peerId} page state updated to: ${peer.currentPage}`);
        return;
      }
      
      // 🆕 NEW: Block host navigation from main page if they are currently on main page
      if (peer.currentPage === 'main') {
        console.log(`🚫 Host ${peerId} attempted to leave main page - checking if navigation should be blocked`);
        
        // Check current connected peers count
        const otherConnectedPeers = Array.from(session.peers.values()).filter(p => 
          p.peerId !== peerId && !p.isDisconnected
        );
        
        console.log(`🔍 Other connected peers:`, otherConnectedPeers.map(p => ({
          peerId: p.peerId,
          role: p.role,
          currentPage: p.currentPage
        })));
        
        if (otherConnectedPeers.length > 0) {
          console.log(`🚫 Host ${peerId} attempted to leave main page while ${otherConnectedPeers.length} peers are connected - blocking navigation`);
          
          // Block the navigation by keeping host on main page
          peer.currentPage = 'main';
          session.peers.set(peerId, peer);
          
          // Emit warning to host with current peer count
          io.to(peer.socketId).emit('host-navigation-blocked', { 
            reason: 'others_connected', 
            message: `You cannot leave the main page while ${otherConnectedPeers.length} other user(s) are connected. Please use the Exit button to leave the session.`, 
            connectedPeers: otherConnectedPeers.length 
          });
          
          console.log(`🚫 Navigation blocked for host ${peerId} - kept on main page (${otherConnectedPeers.length} peers connected)`);
          return;
        } else {
          // No other peers connected, allow host to leave
          console.log(`✅ Host ${peerId} allowed to leave main page - no other peers connected`);
          
          // Update host's page state
          peer.currentPage = 'index';
          session.peers.set(peerId, peer);
          
          // Notify host that navigation is allowed
          io.to(peer.socketId).emit('host-navigation-allowed', {
            reason: 'no_peers_connected',
            message: 'No other users are connected. You can now leave the main page.',
            connectedPeers: 0
          });
          return;
        }
      } else {
        console.log(`⚠️ Host ${peerId} not on main page (currentPage: ${peer.currentPage}) - navigation blocking not applicable`);
      }
      
      // The navigation blocking logic is now handled above in the currentPage === 'main' check
    } else {
      console.log(`ℹ️ Non-host peer ${peerId} leaving main page - no navigation blocking`);
    }
  });

  // Explicitly allow a peer to leave the session (used by receivers on Exit)
  socket.on('leave-session', ({ sessionId, peerId }, ack) => {
    const session = sessions.get(sessionId);
    if (!session) return typeof ack === 'function' && ack({ ok: false, reason: 'session_not_found' });

    const peer = session.peers.get(peerId);
    if (!peer) {
      try { session.exitedPeers && session.exitedPeers.add(peerId); } catch (_) {}
      return typeof ack === 'function' && ack({ ok: true });
    }

    // Remove peer and update others
    try {
      session.peers.delete(peerId);
      const connectedPeers = Array.from(session.peers.values()).filter(p => !p.isDisconnected);
      io.in(sessionId).emit('peers-updated', connectedPeers);
      
      // If no clients are left, clear the grace timer
      const remainingClients = connectedPeers.filter(p => p.role !== 'host').length;
      if (remainingClients === 0 && session.graceRedirectTimer) {
        console.log(`🧹 Clearing grace timer - last client left session ${sessionId}`);
        try { clearTimeout(session.graceRedirectTimer); } catch (_) {}
        session.graceRedirectTimer = null;
        session.graceRedirectEndMs = null;
        
        // Notify host to clear the timer display
        const hostPeer = connectedPeers.find(p => p.role === 'host');
        if (hostPeer) {
          io.to(hostPeer.socketId).emit('grace-timer-cleared');
          console.log(`Notified host ${hostPeer.peerId} to clear grace timer display`);
        }
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
      const sessionDownloadQueue = receiverDownloadQueues.get(sessionId);
      if (sessionDownloadQueue) {
        sessionDownloadQueue.delete(peerId);
        if (sessionDownloadQueue.size === 0) receiverDownloadQueues.delete(sessionId);
      }
      const sessionDownloadFlags = receiverDownloadFlags.get(sessionId);
      if (sessionDownloadFlags) {
        sessionDownloadFlags.delete(peerId);
        if (sessionDownloadFlags.size === 0) receiverDownloadFlags.delete(sessionId);
      }
      const sessionActive = receiverActiveDownloads.get(sessionId);
      if (sessionActive) {
        sessionActive.delete(peerId);
        if (sessionActive.size === 0) receiverActiveDownloads.delete(sessionId);
      }
    } catch (_) {}

    // Remove from room
    try { socket.leave(sessionId); } catch (_) {}

    if (typeof ack === 'function') ack({ ok: true });
  });

  // Host can announce shutdown so clients can show message and attempt to close
  socket.on('announce-shutdown', () => {
    console.log('Broadcasting server-shutdown to all clients');
    io.emit('server-shutdown');
  });

  socket.on("disconnect", () => {
    const { peerId, sessionId } = socket.data || {};
    console.log(`Socket ${socket.id} disconnected (peer: ${peerId}, session: ${sessionId})`);
    
    if (sessionId && peerId) {
      const session = sessions.get(sessionId);
      if (session) {
        const peer = session.peers.get(peerId);
        // Only remove if this socket was the active one for this peer
        if (peer && peer.socketId === socket.id) {
          // Mark peer as disconnected but don't remove immediately
          peer.disconnectedAt = Date.now();
          peer.isDisconnected = true;
          console.log(`Peer ${peerId} marked as disconnected, waiting for reconnection...`);
          
          // Set a timeout to remove the peer if they don't reconnect
          const disconnectTimeout = setTimeout(() => {
            const currentPeer = session.peers.get(peerId);
            if (currentPeer && currentPeer.isDisconnected && currentPeer.disconnectedAt === peer.disconnectedAt) {
              // Peer still disconnected after timeout, remove them
              session.peers.delete(peerId);
              console.log(`🗑️ Removed peer ${peerId} from session ${sessionId} after timeout`);
              const connectedPeers = Array.from(session.peers.values()).filter(p => !p.isDisconnected);
              io.in(sessionId).emit('peers-updated', connectedPeers);
              
              // If this peer held the send lock or active transfer, release and unlock
              if (session.currentSenderPeerId === peerId) {
                session.currentSenderPeerId = null;
                session.activeTransfer = null;
                io.in(sessionId).emit('transfer-unlocked');
              }
              // Check for stale locks after a peer disconnects
              checkAndReleaseStaleTransferLocks(sessionId);
              
              // Clear download queue and flags for this peer when they disconnect
              const sessionDownloadQueue = receiverDownloadQueues.get(sessionId);
              if (sessionDownloadQueue) {
                sessionDownloadQueue.delete(peerId);
                if (sessionDownloadQueue.size === 0) {
                  receiverDownloadQueues.delete(sessionId);
                }
                console.log(`Cleared download queue for disconnected peer ${peerId}`);
              }
              
              // Clear download flags for this peer
              const sessionDownloadFlags = receiverDownloadFlags.get(sessionId);
              if (sessionDownloadFlags) {
                sessionDownloadFlags.delete(peerId);
                if (sessionDownloadFlags.size === 0) {
                  receiverDownloadFlags.delete(sessionId);
                }
                console.log(`Cleared download flags for disconnected peer ${peerId}`);
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

// Debug endpoint to check download queue state and flags
app.get('/debug/queues', (req, res) => {
  const queueInfo = {};
  for (const [sessionId, sessionQueue] of receiverDownloadQueues.entries()) {
    queueInfo[sessionId] = {};
    for (const [receiverId, fileQueue] of sessionQueue.entries()) {
      queueInfo[sessionId][receiverId] = fileQueue.map(item => ({
        fileName: item.file.name,
        fileId: item.file.id
      }));
    }
  }
  
  const flagInfo = {};
  for (const [sessionId, sessionFlags] of receiverDownloadFlags.entries()) {
    flagInfo[sessionId] = {};
    for (const [receiverId, isDownloading] of sessionFlags.entries()) {
      flagInfo[sessionId][receiverId] = isDownloading ? 1 : 0;
    }
  }
  
  res.json({
    totalSessions: receiverDownloadQueues.size,
    queues: queueInfo,
    downloadFlags: flagInfo
  });
});

// 🚨 NEW: Function to detect abandoned senders and redirect receivers
function checkForAbandonedSenders(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  // Skip check if there was a recent send request (within 5 seconds)
  if (session.recentSendRequestAt && (Date.now() - session.recentSendRequestAt) < 5000) {
    console.log(`⏳ Skipping abandoned-sender check (recent send request)`);
    return;
  }
  
  // 🆕 NEW: Skip check if there was a recent enter-send-page event (within 3 seconds)
  if (session.recentEnterSendPageAt && (Date.now() - session.recentEnterSendPageAt) < 3000) {
    console.log(`⏳ Skipping abandoned-sender check (recent enter-send-page event)`);
    return;
  }
  
  // 🆕 NEW: Skip check if there was a recent enter-receive-page event (within 3 seconds)
  if (session.recentEnterReceivePageAt && (Date.now() - session.recentEnterReceivePageAt) < 3000) {
    console.log(`⏳ Skipping abandoned-sender check (recent enter-receive-page event)`);
    return;
  }
  
  // Check if there are receivers waiting but no active sender
  const receiversInReceivePage = Array.from(session.peers.values()).filter(p => 
    p.currentPage === 'receive' && !p.isDisconnected
  );
  
  const sendersInSendPage = Array.from(session.peers.values()).filter(p => 
    p.currentPage === 'send' && !p.isDisconnected
  );
  
  const hasActiveTransfer = session.activeTransfer !== null;
  
  // Debug logging for abandoned sender detection
  console.log(`🔍 Abandoned sender check for session ${sessionId}:`);
  console.log(`  - Receivers in receive page: ${receiversInReceivePage.length}`);
  console.log(`  - Senders in send page: ${sendersInSendPage.length}`);
  console.log(`  - Active transfer: ${hasActiveTransfer}`);
  console.log(`  - All peers:`, Array.from(session.peers.values()).map(p => 
    `${p.peerId}(${p.role}) - page:${p.currentPage || 'undefined'}, disconnected:${p.isDisconnected}, justLeftSendPage:${p.justLeftSendPage || false}`
  ));
  
  // Additional debug info for page tracking
  if (receiversInReceivePage.length > 0) {
    console.log(`  - Receivers details:`, receiversInReceivePage.map(p => 
      `${p.peerId}(${p.role}) - socketId:${p.socketId}, currentPage:${p.currentPage}`
    ));
  }
  if (sendersInSendPage.length > 0) {
    console.log(`  - Senders details:`, sendersInSendPage.map(p => 
      `${p.peerId}(${p.role}) - socketId:${p.socketId}, currentPage:${p.currentPage}`
    ));
  }
  
  // If there are receivers waiting but no sender in send page and no active transfer
  if (receiversInReceivePage.length > 0 && sendersInSendPage.length === 0 && !hasActiveTransfer) {
    console.log(`🚨 Detected abandoned sender scenario: ${receiversInReceivePage.length} receivers waiting, no sender in send page, no active transfer`);
    
    // Check if this is a post-transfer scenario (sender completed transfer but still on send page)
    const recentTransfer = session.lastTransferCompletedAt && (Date.now() - session.lastTransferCompletedAt) < 10000; // 10 seconds
    
    if (recentTransfer) {
      console.log(`⏳ Recent transfer detected, keeping sender on send page and receivers on receive page`);
      // Do nothing - let sender stay on send page to send more files if they want
      // Receivers stay on receive page to wait for more files
    } else {
      // This is a true abandoned sender scenario - redirect receivers
      console.log(`🔄 Redirecting ${receiversInReceivePage.length} receivers to main page due to no active sender`);
      
      // Redirect all receivers back to main page
      receiversInReceivePage.forEach(receiver => {
        // Clear their receive page state
        receiver.currentPage = 'main';
        session.peers.set(receiver.peerId, receiver);
        
        console.log(`🔄 Redirecting ${receiver.peerId} to main page due to no active sender`);
        
        // Redirect them to main page
        io.to(receiver.socketId).emit('redirect-to-main-due-to-abandoned-sender', {
          reason: 'sender_abandoned_transfer',
          message: 'The sender appears to have left. You have been redirected to the main page.',
          sessionId: sessionId,
          role: receiver.role,
          peerId: receiver.peerId
        });
      });
    }
  } 
  // 🆕 NEW: Check if sender is alone in send page with no receivers waiting
  else if (sendersInSendPage.length > 0 && receiversInReceivePage.length === 0 && !hasActiveTransfer) {
    console.log(`🔄 Detected lonely sender scenario: ${sendersInSendPage.length} sender(s) in send page, no receivers waiting`);
    
    // Redirect senders to main page since no receivers are waiting
    sendersInSendPage.forEach(sender => {
      console.log(`🔄 Redirecting lonely sender ${sender.peerId} to main page - no receivers waiting`);
      
      // Redirect sender to main page
      io.to(sender.socketId).emit('redirect-sender-to-main-no-receivers', {
        reason: 'no_receivers_waiting',
        message: 'No receivers are currently waiting. You have been redirected to the main page.',
        sessionId: sessionId,
        role: sender.role,
        peerId: sender.peerId
      });
      
      // Update sender's page state to main
      sender.currentPage = 'main';
      session.peers.set(sender.peerId, sender);
      
      // Release the send lock since sender is no longer in send page
      if (session.currentSenderPeerId === sender.peerId) {
        session.currentSenderPeerId = null;
        console.log(`🔓 Send lock released for ${sender.peerId} - no receivers waiting (abandoned sender check)`);
        
        // Notify all peers that send button is now unlocked
        io.in(sessionId).emit('send-button-unlocked', {
          unlockedBy: sender.peerId,
          message: 'Send button is now unlocked. No active sender.',
          timestamp: Date.now()
        });
      }
    });
  }
  
  // 🆕 NEW: Check if receivers are stuck in receive page with no active sender
  else if (receiversInReceivePage.length > 0 && sendersInSendPage.length === 0 && !hasActiveTransfer) {
    console.log(`🔄 Detected stuck receivers scenario: ${receiversInReceivePage.length} receiver(s) in receive page, no sender active`);
    
    // Check if this is a recent transfer scenario (within 10 seconds)
    const recentTransfer = session.lastTransferCompletedAt && (Date.now() - session.lastTransferCompletedAt) < 10000;
    
    if (!recentTransfer) {
      console.log(`🔄 Redirecting ${receiversInReceivePage.length} stuck receivers to main page - no active sender`);
      
      // Redirect all receivers back to main page
      receiversInReceivePage.forEach(receiver => {
        console.log(`🔄 Redirecting stuck receiver ${receiver.peerId} to main page - no active sender`);
        
        // Update receiver's page state to main
        receiver.currentPage = 'main';
        session.peers.set(receiver.peerId, receiver);
        
        // Redirect them to main page
        io.to(receiver.socketId).emit('redirect-to-main-due-to-abandoned-sender', {
          reason: 'sender_abandoned_transfer',
          message: 'The sender appears to have left. You have been redirected to the main page.',
          sessionId: sessionId,
          role: receiver.role,
          peerId: receiver.peerId
        });
      });
    } else {
      console.log(`⏳ Recent transfer detected, keeping receivers on receive page`);
    }
  }
  else {
    console.log(`✅ No abandoned sender scenario detected for session ${sessionId}`);
  }
  
  // 🆕 NEW: If sender is active in send page, redirect any users on main page to receive page
  if (sendersInSendPage.length > 0 && !hasActiveTransfer) {
    const usersOnMainPage = Array.from(session.peers.values()).filter(p => 
      p.currentPage === 'main' && !p.isDisconnected && p.peerId !== sendersInSendPage[0].peerId
    );
    
    if (usersOnMainPage.length > 0) {
      console.log(`🔄 Sender active in send page, redirecting ${usersOnMainPage.length} users from main to receive page`);
      
      usersOnMainPage.forEach(user => {
        console.log(`🔄 Redirecting ${user.peerId} from main to receive page (sender active)`);
        
        // Update user's page state to receive
        user.currentPage = 'receive';
        session.peers.set(user.peerId, user);
        
        // Redirect them to receive page
        io.to(user.socketId).emit('force-redirect-to-receive', {
          reason: 'sender_active_in_send_page',
          senderName: sendersInSendPage[0].deviceName || sendersInSendPage[0].peerId,
          message: 'A sender is active. You have been redirected to the receive page.',
          sessionId: sessionId,
          role: user.role,
          peerId: user.peerId,
          forced: true
        });
      });
    }
  }
}

// 🚨 NEW: Set up periodic check for abandoned senders (every 7 seconds)
setInterval(() => {
  try {
    for (const [sessionId, session] of sessions.entries()) {
      checkForAbandonedSenders(sessionId);
    }
  } catch (error) {
    console.error('Error in abandoned sender check:', error);
  }
}, 7000); // Check every 7 seconds

// 🆕 NEW: Periodic cleanup of orphaned device names (every 5 minutes)
setInterval(() => {
  try {
    const activePeerIds = new Set();
    
    // Collect all active peer IDs from current sessions
    for (const [sessionId, session] of sessions.entries()) {
      for (const peerId of session.peers.keys()) {
        activePeerIds.add(peerId);
      }
    }
    
    // Remove device names for peers that are no longer in any active session
    let cleanedCount = 0;
    for (const [peerId] of deviceNamesMap) {
      if (!activePeerIds.has(peerId)) {
        deviceNamesMap.delete(peerId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} orphaned device names`);
      saveDeviceNames(); // Save the cleaned up map
    }
  } catch (error) {
    console.error('Error in device name cleanup:', error);
  }
}, 300000); // Check every 5 minutes

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 FileShare server running on ${PROTOCOL}://${LOCAL_IP}:${PORT}`);
  console.log(`📁 Uploads directory: ${UPLOADS_DIR}`);
  console.log(`🔍 Abandoned sender detection active (checking every 7 seconds)`);
  console.log(`📱 Device names persistence active (${deviceNamesMap.size} names loaded)`);
  console.log(`🧹 Device name cleanup active (every 5 minutes)`);
  
  try {
    await open(`${PROTOCOL}://${LOCAL_IP}:${PORT}`);
    console.log(`🌐 Browser opened automatically`);
  } catch (e) {
    console.log(`⚠️ Could not open browser automatically: ${e.message}`);
  }
});

// Graceful shutdown handlers for process signals
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT (Ctrl+C). Shutting down gracefully...');
  gracefulShutdown();
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM. Shutting down gracefully...');
  gracefulShutdown();
});

// Graceful shutdown function
function gracefulShutdown() {
  console.log('Starting graceful shutdown...');
  
  // Close all Socket.IO connections first
  if (io) {
    console.log('Closing Socket.IO connections...');
    io.close(() => {
      console.log('Socket.IO closed. Closing HTTP server...');
      // Close HTTP server after Socket.IO
      server.close(() => {
        console.log('HTTP server closed. Exiting process.');
        process.exit(0);
      });
    });
  } else {
    // Fallback if Socket.IO not available
    server.close(() => {
      console.log('HTTP server closed. Exiting process.');
      process.exit(0);
    });
  }
}
