require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const { cleanEnv, str, port, url } = require('envalid');

const { ensureDb, DB_PATH } = require('./services/store');
const chatRouter = require('./routes/chat');
const syncRouter = require('./routes/sync');
const fs = require('fs');
const pathLib = require('path');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Validate essential env
const env = cleanEnv(process.env, {
  PORT: port({ default: 3000 }),
  CORS_ORIGIN: str({ default: 'http://localhost:3000' }),
  EMBEDDINGS_PROVIDER: str({ default: 'OPENAI' }),
  OPENAI_API_KEY: str({ default: '' }),
  VOYAGE_API_KEY: str({ default: '' }),
  ANTHROPIC_API_KEY: str({ default: '' }),
  ADMIN_USER: str({ default: '' }),
  ADMIN_PASS: str({ default: '' }),
});

const app = express();
const PORT = env.PORT;

// Helmet with CSP; can be disabled/relaxed for local debugging
const disableCsp = String(process.env.DISABLE_CSP || '').toLowerCase() === 'true';
const cspDirectives = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://accounts.google.com', 'https://apis.google.com'],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", 'data:', 'https:'],
  "connect-src": ["'self'", 'https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://www.googleapis.com'],
  "frame-src": ['https://accounts.google.com', 'https://oauth2.googleapis.com'],
  "form-action": ["'self'", 'https://accounts.google.com'],
};
app.use(helmet({ contentSecurityPolicy: disableCsp ? false : { useDefaults: true, directives: cspDirectives } }));

// CORS allowlist
const allowedOrigins = (env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow same-origin/no-origin
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Static web UI
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Config endpoint to inform UI of mode
const CONTENT_SOURCE = (process.env.CONTENT_SOURCE || 'PDFS').toUpperCase();
const PDFS_DIR = process.env.PDFS_DIR || pathLib.join(__dirname, '..', '..', 'data', 'pdfs');
const COVERS_DIR = process.env.COVERS_DIR || pathLib.join(__dirname, '..', '..', 'data', 'covers');
app.get('/api/config', (req, res) => {
  res.json({ contentSource: CONTENT_SOURCE, pdfsDir: PDFS_DIR, pdfBaseUrl: process.env.PDF_BASE_URL || null, coversDir: COVERS_DIR });
});

// Serve local PDFs in PDFS mode
if (CONTENT_SOURCE === 'PDFS') {
  app.use('/pdfs', express.static(PDFS_DIR));
  app.use('/covers', express.static(COVERS_DIR));

  // Simple covers API: list cover images and link to matching PDFs by basename
  app.get('/api/covers', (req, res) => {
    try {
      if (!fs.existsSync(COVERS_DIR)) return res.json({ items: [] });
      const files = fs.readdirSync(COVERS_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
      const baseUrl = process.env.PDF_BASE_URL ? String(process.env.PDF_BASE_URL).replace(/\/$/, '') : null;
      const items = files.slice(0, 12).map(name => {
        const base = name.replace(/\.[^.]+$/, '');
        // Try exact match in PDFs_DIR
        let pdfRel = null;
        const candidates = [base + '.pdf', base.replace(/\s+/g, '_') + '.pdf', base.replace(/\s+/g, '') + '.pdf'];
        for (const cand of candidates) {
          const p = pathLib.join(PDFS_DIR, cand);
          if (fs.existsSync(p)) { pdfRel = cand; break; }
        }
        const coverUrl = '/covers/' + encodeURIComponent(name);
        const pdfUrl = pdfRel ? (baseUrl ? `${baseUrl}/${encodeURIComponent(pdfRel)}` : `/pdfs/${encodeURIComponent(pdfRel)}`) : null;
        return { name: base, coverUrl, pdfUrl };
      });
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Rate limits
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const syncLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

// API Routes
app.use('/api/chat', chatLimiter, chatRouter);
if (CONTENT_SOURCE === 'GDRIVE') {
  app.use('/api/sync', syncLimiter, syncRouter);
} else if (CONTENT_SOURCE === 'PDFS') {
  app.use('/api/sync-pdfs', syncLimiter, require('./routes/syncPdfs'));
}

// Ensure DB exists and start server
ensureDb();

app.listen(PORT, () => {
  logger.info({ port: PORT, dbPath: DB_PATH, dbDir: process.env.DB_DIR || '(default ./data)' }, '[ralphmagchatbot] listening');
});
