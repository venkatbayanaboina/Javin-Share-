import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.join(__dirname, '..');

// Load environment variables from .env if present
const envPath = path.join(backendRoot, '..', '.env');
if (fs.existsSync(envPath)) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    });
  } catch (err) {
    console.error('Error loading .env file:', err);
  }
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  host: process.env.HOST || '0.0.0.0',
  customHost: process.env.CUSTOM_HOST || null,
  protocol: 'https',
  pinExpiryMs: Number(process.env.PIN_EXPIRY_MS) || 5 * 60 * 1000,
  gracePeriodMs: Number(process.env.GRACE_PERIOD_MS) || 30 * 1000,
  maxGraceMs: Number(process.env.MAX_GRACE_MS) || 120 * 1000,
  maxConcurrentDownloadsPerReceiver: Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 3,
  maxUploadBytes: Number(process.env.MAX_FILE_SIZE_BYTES) || 50 * 1024 * 1024 * 1024,
  transfer: {
    // Safe default per Section 23: disk relay until stream mode is explicitly enabled
    defaultStrategy: process.env.TRANSFER_DEFAULT_STRATEGY || 'relay-disk',
    enableStreamRelay: process.env.TRANSFER_ENABLE_STREAM_RELAY !== 'false',
    streamRelayTimeoutMs: Number(process.env.TRANSFER_STREAM_RELAY_TIMEOUT_MS) || 30000,
    chunkSizeBytes: Number(process.env.TRANSFER_CHUNK_SIZE_BYTES) || 8 * 1024 * 1024,
    spoolThresholdBytes: Number(process.env.TRANSFER_SPOOL_THRESHOLD_BYTES) || 256 * 1024 * 1024,
    maxReceiverBufferSize: Number(process.env.TRANSFER_MAX_RECEIVER_BUFFER_SIZE) || 16 * 1024 * 1024,
    enableBufferedBackpressure: process.env.TRANSFER_ENABLE_BUFFERED_BACKPRESSURE === 'true',
  },
  pinMaxAttempts: Number(process.env.PIN_MAX_ATTEMPTS) || 8,
  pinRateWindowMs: Number(process.env.PIN_RATE_WINDOW_MS) || 15 * 60 * 1000,
  pinLockoutMs: Number(process.env.PIN_LOCKOUT_MS) || 5 * 60 * 1000,
  uploadsDir: process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(backendRoot, 'uploads'),
  certsDir: process.env.CERTS_DIR
    ? path.resolve(process.env.CERTS_DIR)
    : path.join(backendRoot, 'certs'),
  deviceNamesFile: path.join(backendRoot, 'device_names.json'),
  frontendPath: path.join(backendRoot, '..', 'frontend'),
  logLevel: process.env.LOG_LEVEL || 'info',
  openBrowser: process.env.OPEN_BROWSER !== 'false',
};

export const paths = {
  backendRoot,
  certKey: path.join(config.certsDir, 'key.pem'),
  certPem: path.join(config.certsDir, 'cert.pem'),
};
