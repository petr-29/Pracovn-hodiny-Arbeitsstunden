const express = require('express');
const app = express();
const http = require('http').createServer(app);
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const net = require('net');
const path = require('path');

const MAX_REQUEST_SIZE = '2mb';
const MAX_SIGNATURE_LENGTH = 1_500_000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const COMPLETED_SESSION_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 300;
const ALLOWED_TARGETS = new Set(['kunde', 'ich']);
const ALLOWED_LANGS = new Set(['cs', 'de']);
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const SIGNATURE_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

// GitHub Pages origin for this repository – always allowed
const GITHUB_PAGES_ORIGIN = 'https://petr-29.github.io';
// Optional user-configurable origin for custom frontends (set via env var, exact match only)
const CUSTOM_ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.trim().replace(/\/$/, '') : null;
// Public URL of this backend (used to build absolute sign URLs in production)
const PUBLIC_URL = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.trim().replace(/\/$/, '') : null;

// Úložiště pro relace podpisu
let signatureSessions = {};

app.set('trust proxy', false);
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use('/api', cors({
  origin(origin, callback) {
    if (!origin || origin === 'null' || isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Signature-Token'],
  maxAge: 300
}));

const appRateLimit = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false
  }
});

app.get('/', appRateLimit, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

function isAllowedOrigin(origin) {
  // Allow GitHub Pages origin for this repository
  if (origin === GITHUB_PAGES_ORIGIN) return true;

  // Allow optional user-configurable extra origin (exact match, no wildcards)
  if (CUSTOM_ALLOWED_ORIGIN && origin === CUSTOM_ALLOWED_ORIGIN) return true;

  // Allow localhost and private LAN addresses for local development
  try {
    const { hostname } = new URL(origin);
    return isLocalHostname(hostname);
  } catch (error) {
    return false;
  }
}

function isLocalHostname(hostname) {
  const normalized = hostname.toLowerCase();
  const ipVersion = net.isIP(normalized);

  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized.endsWith('.local')) {
    return true;
  }

  if (ipVersion && ipVersion !== 4) {
    return false;
  }

  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  return octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

function isValidTarget(target) {
  return typeof target === 'string' && ALLOWED_TARGETS.has(target);
}

function isValidLang(lang) {
  return typeof lang === 'undefined' || (typeof lang === 'string' && ALLOWED_LANGS.has(lang));
}

function isValidPcId(pcId) {
  return typeof pcId === 'undefined' || pcId === null || (typeof pcId === 'string' && pcId.trim().length > 0 && pcId.trim().length <= 120);
}

function isValidSignature(signature) {
  return typeof signature === 'string' &&
    signature.length <= MAX_SIGNATURE_LENGTH &&
    SIGNATURE_PATTERN.test(signature);
}

function createSessionId() {
  return crypto.randomUUID();
}

function createUploadToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getSessionLogLabel(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 8
    ? `…${sessionId.slice(-8)}`
    : 'unknown';
}

function removeSession(sessionId) {
  const session = signatureSessions[sessionId];
  if (session && session.cleanupTimeout) {
    clearTimeout(session.cleanupTimeout);
  }

  delete signatureSessions[sessionId];
}

function getSession(sessionId) {
  const session = signatureSessions[sessionId];

  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    removeSession(sessionId);
    return null;
  }

  return session;
}

function matchesToken(expectedToken, providedToken) {
  if (!isValidToken(expectedToken) || !isValidToken(providedToken)) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expectedToken, 'hex'),
    Buffer.from(providedToken, 'hex')
  );
}

function getSessionSignUrl(req, session) {
  const params = new URLSearchParams({
    sessionId: session.id,
    target: session.target,
    token: session.uploadToken
  });

  const relPath = `/sign?${params.toString()}`;

  // Use PUBLIC_URL env var when set – required for cross-origin (Pages + external backend) deployments.
  if (PUBLIC_URL) {
    return `${PUBLIC_URL}${relPath}`;
  }

  // Only build an absolute URL when the requesting hostname is a verified local address,
  // to prevent Host-header injection on public/untrusted deployments.
  if (req && isLocalHostname(req.hostname)) {
    return `${req.protocol}://${req.get('host')}${relPath}`;
  }

  return relPath;
}

// === API ENDPOINTY ===

/**
 * POST /api/signature-session
 * Vytvoří novou relaci pro podpis
 * Body: { target: 'kunde' | 'ich', pcId: string }
 */
app.post('/api/signature-session', appRateLimit, (req, res) => {
  const { target = 'kunde', pcId } = req.body || {};

  if (!isValidTarget(target)) {
    return res.status(400).json({ error: 'Invalid target' });
  }

  if (!isValidPcId(pcId)) {
    return res.status(400).json({ error: 'Invalid pcId' });
  }

  const sessionId = createSessionId();
  const uploadToken = createUploadToken();

  signatureSessions[sessionId] = {
    id: sessionId,
    uploadToken,
    signature: null,
    target,
    pcId: typeof pcId === 'string' ? pcId.trim() : null,
    created: new Date(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    status: 'waiting'
  };

  console.log(`✓ Nová relace podpisu: ${getSessionLogLabel(sessionId)} (${target})`);

  res.json({
    sessionId,
    uploadToken,
    target,
    created: signatureSessions[sessionId].created,
    signUrl: getSessionSignUrl(req, signatureSessions[sessionId])
  });
});

/**
 * GET /api/signature/:sessionId
 * Zjistí stav podpisu - vrací podpis pokud je připraven
 */
app.get('/api/signature/:sessionId', appRateLimit, (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }

  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.signature) {
    console.log(`✓ Podpis přijat pro relaci: ${getSessionLogLabel(sessionId)}`);
    res.json({
      signature: session.signature,
      target: session.target,
      status: 'completed'
    });

    // Smazat relaci po 5 minutách od vyzvednutí podpisu
    if (!session.cleanupTimeout) {
      session.cleanupTimeout = setTimeout(() => {
        removeSession(sessionId);
      }, COMPLETED_SESSION_CLEANUP_DELAY_MS);
    }
  } else {
    res.json({
      signature: null,
      target: session.target,
      status: 'waiting'
    });
  }
});

/**
 * POST /api/signature/:sessionId/upload
 * Telefon odešle podpis
 */
app.post('/api/signature/:sessionId/upload', appRateLimit, (req, res) => {
  const { sessionId } = req.params;
  const { signature } = req.body || {};
  const token = (req.body && req.body.token) || req.get('x-signature-token');

  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }

  if (!isValidToken(token)) {
    return res.status(400).json({ error: 'Missing or invalid token' });
  }

  if (!isValidSignature(signature)) {
    return res.status(400).json({ error: 'Invalid signature payload' });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!matchesToken(session.uploadToken, token)) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  session.signature = signature;
  session.status = 'completed';
  session.uploadedAt = new Date();

  console.log(`✓ Podpis uložen: ${getSessionLogLabel(sessionId)}`);

  res.json({
    success: true,
    message: 'Signature received',
    sessionId
  });
});

/**
 * GET /sign
 * Zobrazit podpisové plátno na základě parametrů
 */
app.get('/sign', appRateLimit, (req, res) => {
  const { sessionId, target, lang, token } = req.query;

  if (!isValidSessionId(sessionId)) {
    return res.status(400).send('Missing or invalid sessionId parameter');
  }

  if (!isValidToken(token)) {
    return res.status(400).send('Missing or invalid token parameter');
  }

  if (typeof target !== 'undefined' && !isValidTarget(target)) {
    return res.status(400).send('Invalid target parameter');
  }

  if (!isValidLang(lang)) {
    return res.status(400).send('Invalid lang parameter');
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).send('Session not found');
  }

  if (!matchesToken(session.uploadToken, token)) {
    return res.status(403).send('Invalid token');
  }

  if (typeof target !== 'undefined' && target !== session.target) {
    return res.status(400).send('Target does not match session');
  }

  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

/**
 * GET /health
 * Kontrola stavu serveru
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date(),
    activeSessions: Object.keys(signatureSessions).length
  });
});

// === ERROR HANDLING ===
app.use((err, req, res, next) => {
  if (err && err.message === 'Origin not allowed by CORS') {
    console.warn(`⚠️ Blokovaný CORS origin: ${req.headers.origin || 'unknown'}`);
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  console.error('Chyba serveru:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// === START SERVERU ===
const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Podpisový server běží na portu ${PORT}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📱 Přístupný na: http://localhost:${PORT}`);
  console.log(`✓ API: /api/signature-session [POST]`);
  console.log(`✓ Podpis: /sign?sessionId=XXX&target=kunde&token=XXX&lang=cs`);
  console.log(`${'='.repeat(50)}\n`);
});

module.exports = http;