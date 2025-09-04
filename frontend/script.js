// frontend/script.js - Enhanced for 50GB file support
// script.js
function getPeerId() {
  let pid = localStorage.getItem("peerId");
  if (!pid) {
      pid = Math.random().toString(36).substring(2, 10);
      localStorage.setItem("peerId", pid);
  }
  return pid;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 Bytes';
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  // Handle very large files with better precision
  const value = bytes / Math.pow(k, i);
  const decimals = i >= 2 ? 2 : 0; // Show decimals for MB and above
  
  return parseFloat(value.toFixed(decimals)) + ' ' + sizes[i];
}

function getUrlParameter(name) {
  if (!name) return null;
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showNotification(message, type = 'success', duration = 3000) {
  // Remove existing notification
  const existing = document.querySelector('.notification-badge');
  if (existing) existing.remove();
  
  const notification = document.createElement('div');
  notification.className = `notification-badge notification-${type}`;
  notification.textContent = message;
  
  // Add icon based on type
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
  
  if (icons[type]) {
    notification.textContent = `${icons[type]} ${message}`;
  }
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
      if (notification.parentNode) {
          notification.style.animation = 'slideOut 0.3s ease forwards';
          setTimeout(() => {
              if (notification.parentNode) {
                  notification.remove();
              }
          }, 300);
      }
  }, duration);
}

function showError(message) {
  const container = document.querySelector('.container');
  if (container) {
      // Get current page info for proper navigation
      const currentPath = window.location.pathname;
      const sessionId = getUrlParameter('session');
      const role = getUrlParameter('role');
      const peerId = getUrlParameter('peerId');
      
      // Determine proper navigation based on current page
      let homeButton = '';
      if (currentPath.includes('send.html') || currentPath.includes('receive.html')) {
        // For send/receive pages, go back to main page
        homeButton = `<button onclick="window.location.href='/main.html?session=${sessionId}&role=${role}&peerId=${peerId}'" class="btn btn-primary">← Back to Main</button>`;
      } else if (currentPath.includes('main.html')) {
        // For main page, go back to index (host) or show close option (client)
        if (role === 'host') {
          homeButton = `<button onclick="window.location.href='/?session=${sessionId}'" class="btn btn-primary">🏠 Go Home</button>`;
        } else {
          homeButton = `<button onclick="window.close()" class="btn btn-primary">🚪 Close</button>`;
        }
      } else {
        // Default fallback: do NOT show Home for non-hosts (prevents stopping server)
        if (role === 'host') {
          homeButton = `<button onclick="location.href='/'" class="btn btn-primary">🏠 Go Home</button>`;
        } else {
          homeButton = '';
        }
      }
      
      container.innerHTML = `
        <div class="error">
          <h2>❌ Error</h2>
          <p>${escapeHtml(message)}</p>
          ${homeButton}
          <button onclick="location.reload()" class="btn btn-secondary">🔄 Retry</button>
        </div>
      `;
  } else {
      alert('Error: ' + message);
  }
}

// Enhanced file validation for large files
function validateFile(file, maxSize = 50 * 1024 * 1024 * 1024) { // 50GB default
  const validations = {
    size: file.size <= maxSize,
    name: file.name && file.name.length > 0 && file.name.length <= 255,
    type: file.type !== undefined // Basic type check
  };
  
  const errors = [];
  
  if (!validations.size) {
    errors.push(`File too large: ${formatFileSize(file.size)}. Maximum allowed: ${formatFileSize(maxSize)}`);
  }
  
  if (!validations.name) {
    errors.push('Invalid file name');
  }
  
  // Check for potentially problematic file names
  const problematicChars = /[<>:"/\\|?*\x00-\x1f]/;
  if (problematicChars.test(file.name)) {
    errors.push('File name contains invalid characters');
  }
  
  return {
    valid: errors.length === 0,
    errors: errors,
    file: file
  };
}



// Connection status monitoring
class ConnectionMonitor {
  constructor(socket) {
    this.socket = socket;
    this.isOnline = navigator.onLine;
    this.callbacks = [];
    this.setupListeners();
  }
  
  setupListeners() {
    // Browser online/offline events
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.notifyCallbacks('online');
    });
    
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.notifyCallbacks('offline');
    });
    
    // Socket connection events
    if (this.socket) {
      this.socket.on('connect', () => {
        this.notifyCallbacks('socket-connected');
      });
      
      this.socket.on('disconnect', () => {
        this.notifyCallbacks('socket-disconnected');
      });
      
      this.socket.on('reconnect', () => {
        this.notifyCallbacks('socket-reconnected');
      });
    }
  }
  
  onStatusChange(callback) {
    this.callbacks.push(callback);
  }
  
  notifyCallbacks(status) {
    this.callbacks.forEach(callback => callback(status, this.isOnline));
  }
  
  getStatus() {
    return {
      online: this.isOnline,
      socketConnected: this.socket?.connected || false
    };
  }
}

// Enhanced error handling with retry logic
class ErrorHandler {
  static handle(error, context = '', retryCallback = null) {
    console.error(`Error in ${context}:`, error);
    
    let userMessage = 'An unexpected error occurred.';
    let canRetry = false;
    
    if (error.name === 'NetworkError' || error.message.includes('fetch')) {
      userMessage = 'Network error. Please check your connection.';
      canRetry = true;
    } else if (error.name === 'AbortError') {
      userMessage = 'Operation was cancelled.';
    } else if (error.message.includes('File too large')) {
      userMessage = error.message;
    } else if (error.message.includes('Session')) {
      userMessage = 'Session expired or invalid. Please reconnect.';
    } else if (error.message) {
      userMessage = error.message;
    }
    
    // Show error notification
    showNotification(userMessage, 'error', 5000);
    
    // Show retry option if applicable
    if (canRetry && retryCallback) {
      setTimeout(() => {
        if (confirm(`${userMessage}\n\nWould you like to retry?`)) {
          retryCallback();
        }
      }, 1000);
    }
  }
}

// Progress tracking utility
class ProgressTracker {
  constructor() {
    this.reset();
  }
  
  reset() {
    this.startTime = null;
    this.lastUpdate = null;
    this.totalBytes = 0;
    this.transferredBytes = 0;
    this.speed = 0;
    this.eta = 0;
  }
  
  start(totalBytes) {
    this.startTime = Date.now();
    this.lastUpdate = this.startTime;
    this.totalBytes = totalBytes;
    this.transferredBytes = 0;
  }
  
  update(transferredBytes) {
    const now = Date.now();
    this.transferredBytes = transferredBytes;
    
    if (this.lastUpdate && now - this.lastUpdate > 0) {
      const timeDiff = (now - this.startTime) / 1000; // seconds
      this.speed = transferredBytes / timeDiff; // bytes per second
      
      const remainingBytes = this.totalBytes - transferredBytes;
      this.eta = remainingBytes / this.speed; // seconds
    }
    
    this.lastUpdate = now;
    
    return {
      progress: (transferredBytes / this.totalBytes) * 100,
      speed: this.speed,
      eta: this.eta,
      transferred: transferredBytes,
      total: this.totalBytes
    };
  }
  
  getStats() {
    return {
      progress: (this.transferredBytes / this.totalBytes) * 100,
      speed: this.speed,
      eta: this.eta,
      transferred: this.transferredBytes,
      total: this.totalBytes,
      elapsed: this.startTime ? (Date.now() - this.startTime) / 1000 : 0
    };
  }
}

// Time formatting utility
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

// Enhanced speed formatting
function formatSpeed(bytesPerSecond) {
  if (!isFinite(bytesPerSecond) || bytesPerSecond < 0) return '-- B/s';
  // Show both MB/s (binary) and Mbps (decimal) for clarity
  const mbPerSec = bytesPerSecond / (1024 * 1024); // MiB/s
  const mbitPerSec = (bytesPerSecond * 8) / 1_000_000; // Mb/s (decimal megabits)
  return `${mbPerSec.toFixed(2)} MB/s (${mbitPerSec.toFixed(2)} Mbps)`;
}

// Device detection
function getDeviceInfo() {
  const userAgent = navigator.userAgent;
  let deviceType = 'desktop';
  let os = 'unknown';
  
  // Detect device type
  if (/tablet|ipad|playbook|silk/i.test(userAgent)) {
    deviceType = 'tablet';
  } else if (/mobile|iphone|ipod|android|blackberry|opera|mini|windows\sce|palm|smartphone|iemobile/i.test(userAgent)) {
    deviceType = 'mobile';
  }
  
  // Detect OS
  if (/windows/i.test(userAgent)) os = 'windows';
  else if (/macintosh|mac os x/i.test(userAgent)) os = 'macos';
  else if (/linux/i.test(userAgent)) os = 'linux';
  else if (/android/i.test(userAgent)) os = 'android';
  else if (/iphone|ipad|ipod/i.test(userAgent)) os = 'ios';
  
  return { deviceType, os, userAgent };
}

// Global error handler for unhandled promises





// Global error handler for unhandled promises
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  ErrorHandler.handle(event.reason, 'Unhandled Promise');
  event.preventDefault();
});

// Global error handler for JavaScript errors
window.addEventListener('error', (event) => {
  console.error('Global JavaScript error:', event.error);
  ErrorHandler.handle(event.error, 'Global Error');
});

// Export utilities for use in other scripts
if (typeof window !== 'undefined') {
  window.FileShareUtils = {
    getPeerId,
    formatFileSize,
    formatTime,
    formatSpeed,
    validateFile,
    showNotification,
    showError,
    escapeHtml,
    getUrlParameter,
    ConnectionMonitor,
    ErrorHandler,
    ProgressTracker,
    getDeviceInfo
  };
}
// =============================
// Socket.IO Connection Handling
// =============================
let socket;
let socketInitialized = false;

async function initSocket(role = "client") {
  if (socketInitialized) return;
  socketInitialized = true;

  try {
    // Get or create session first
    const res = await fetch("/get-current-session");
    if (!res.ok) throw new Error("Failed to get session");
    const sessionData = await res.json();

    const sessionId = sessionData.sessionId;
    const peerId = FileShareUtils.getPeerId();

    // Init socket
    socket = io();

    socket.on("connect", () => {
      console.log(`🔌 Connected, joining ${sessionId} as ${role}`);
      socket.emit("join-session", { sessionId, role, peerId });
    });

    // Debug log peers
    socket.on("peers-updated", (peers) => {
      console.log("👥 Current peers:", peers.map(p => `${p.peerId}(${p.role})`));
    });

    // History updates
    socket.on("history-updated", (history) => {
      console.log("📜 Transfer history:", history);
    });

    // Redirect events
    socket.on("redirect-host-to-main", () => {
      console.log("➡️ Redirecting host to main.html");
      if (role === "host") window.location.href = `/main.html?session=${sessionId}`;
    });

    socket.on("force-redirect-to-receive", () => {
      console.log("⬇️ Redirecting to receive.html (global listener)");
      if (role === "client") {
        window.location.href = `/receive.html?session=${sessionId}`;
      }
    });

    new FileShareUtils.ConnectionMonitor(socket).onStatusChange((status) => {
      console.log("📡 Connection status:", status);
    });
  } catch (err) {
    FileShareUtils.ErrorHandler.handle(err, "Socket Init", () => initSocket(role));
  }
}

// Auto-start socket depending on page
document.addEventListener("DOMContentLoaded", () => {
  const path = window.location.pathname;
  if (path.includes("pin")) {
    initSocket("client");
  }
});