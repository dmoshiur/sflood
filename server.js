'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_DATA_FILE = path.join(ROOT, 'data', 'store.json');
const MAX_BODY_BYTES = 8 * 1024;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const REPORT_LIMIT = 10;

const STATIONS = [
  {
    id: 'willow-north',
    name: 'North gauge',
    river: 'Willow Creek',
    levelM: 1.82,
    watchLevelM: 2.2,
    status: 'Watch',
    trend: 'Rising',
    rainfallMm: 23,
    updatedMinutesAgo: 2,
    mapPoint: [25, 43],
  },
  {
    id: 'mill-east',
    name: 'Mill bridge',
    river: 'East Fork',
    levelM: 1.26,
    watchLevelM: 1.8,
    status: 'Normal',
    trend: 'Steady',
    rainfallMm: 12,
    updatedMinutesAgo: 3,
    mapPoint: [57, 55],
  },
  {
    id: 'levee-south',
    name: 'Levee 4',
    river: 'South Basin',
    levelM: 2.41,
    watchLevelM: 2.2,
    status: 'Elevated',
    trend: 'Rising',
    rainfallMm: 31,
    updatedMinutesAgo: 1,
    mapPoint: [71, 76],
  },
  {
    id: 'canal-old-town',
    name: 'Canal gate',
    river: 'Old Town Canal',
    levelM: 0.88,
    watchLevelM: 1.4,
    status: 'Normal',
    trend: 'Falling',
    rainfallMm: 7,
    updatedMinutesAgo: 4,
    mapPoint: [45, 30],
  },
  {
    id: 'kestrel-trail',
    name: 'Trail crossing',
    river: 'Kestrel Run',
    levelM: 1.47,
    watchLevelM: 1.8,
    status: 'Watch',
    trend: 'Rising',
    rainfallMm: 16,
    updatedMinutesAgo: 2,
    mapPoint: [82, 42],
  },
  {
    id: 'orchard-riverbend',
    name: 'Orchard reach',
    river: 'Riverbend',
    levelM: 1.13,
    watchLevelM: 1.6,
    status: 'Normal',
    trend: 'Steady',
    rainfallMm: 9,
    updatedMinutesAgo: 5,
    mapPoint: [34, 73],
  },
];

const REPORT_CATEGORIES = new Set([
  'standing-water',
  'road-flooding',
  'river-level',
  'drainage',
  'other',
]);
const CONDITIONS = new Set(['watching', 'concerning', 'urgent']);
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ensureStore(dataFile) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (!fs.existsSync(dataFile)) {
    persistStore(dataFile, { reports: [], subscribers: [] });
  }
}

function readStore(dataFile) {
  ensureStore(dataFile);
  const store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  if (!store || !Array.isArray(store.reports) || !Array.isArray(store.subscribers)) {
    throw new Error(`The data store at ${dataFile} has an invalid format.`);
  }
  return store;
}

function persistStore(dataFile, store) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, dataFile);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, maxLength);
}

function validateReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Please send a valid observation.');
  }

  const location = cleanText(input.location, 100);
  const category = cleanText(input.category, 32);
  const condition = cleanText(input.condition, 24);
  const details = cleanText(input.details, 800);
  const name = cleanText(input.name, 60);

  if (location.length < 2) throw new HttpError(400, 'Add a location with at least 2 characters.');
  if (!REPORT_CATEGORIES.has(category)) throw new HttpError(400, 'Choose an observation type from the list.');
  if (!CONDITIONS.has(condition)) throw new HttpError(400, 'Choose a water condition from the list.');
  if (details.length < 10) throw new HttpError(400, 'Please add at least 10 characters of detail.');
  if (typeof input.name === 'string' && input.name.trim().length > 60) {
    throw new HttpError(400, 'Name must be 60 characters or fewer.');
  }

  return { location, category, condition, details, name };
}

function validateSubscription(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Please enter a valid email address.');
  }
  const email = cleanText(input.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new HttpError(400, 'Please enter a valid email address.');
  }
  return email;
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send this request as JSON.');
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'This request is too large.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'This request is too large.');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
}

function buildDashboard(store) {
  const elevatedStations = STATIONS.filter((station) => station.status !== 'Normal');
  const activeDate = new Date().toISOString().slice(0, 10);
  const reportsToday = store.reports.filter((report) => report.createdAt.startsWith(activeDate)).length;

  return {
    mode: 'demo',
    updatedAt: new Date().toISOString(),
    summary: {
      stationsOnline: STATIONS.length,
      elevatedStations: elevatedStations.length,
      reportsToday,
      sensorCoverage: 'River + rain',
    },
    stations: STATIONS,
    alerts: elevatedStations.map((station) => ({
      id: station.id,
      level: station.status,
      title: `${station.river} · ${station.name}`,
      message: station.status === 'Elevated'
        ? 'Sample reading is above its illustrative watch level.'
        : 'Sample reading is trending upward; keep an eye on local conditions.',
      trend: station.trend,
      levelM: station.levelM,
      updatedMinutesAgo: station.updatedMinutesAgo,
    })),
    reports: store.reports.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4),
  };
}

function createServer(options = {}) {
  const dataFile = options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE;
  const publicDir = options.publicDir || PUBLIC_DIR;
  const reportAttempts = new Map();

  ensureStore(dataFile);

  return http.createServer(async (req, res) => {
    applySecurityHeaders(res);

    let url;
    try {
      url = new URL(req.url, 'http://sflood.local');
    } catch {
      sendJson(res, 400, { error: 'Invalid request URL.' });
      return;
    }

    const pathname = url.pathname;

    try {
      if (pathname.startsWith('/api/')) {
        if (req.method === 'GET' && pathname === '/api/health') {
          sendJson(res, 200, { status: 'ok', service: 'sflood', mode: 'demo' });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/dashboard') {
          sendJson(res, 200, buildDashboard(readStore(dataFile)));
          return;
        }

        if (req.method === 'GET' && pathname === '/api/reports') {
          const reports = readStore(dataFile).reports
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 50);
          sendJson(res, 200, { reports });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/reports') {
          const ip = req.socket.remoteAddress || 'unknown';
          const now = Date.now();
          const attempts = (reportAttempts.get(ip) || []).filter((time) => now - time < REPORT_WINDOW_MS);
          if (attempts.length >= REPORT_LIMIT) {
            reportAttempts.set(ip, attempts);
            throw new HttpError(429, 'Please wait before sending another observation.');
          }
          attempts.push(now);
          reportAttempts.set(ip, attempts);

          const input = validateReport(await readJsonBody(req));
          const store = readStore(dataFile);
          const report = {
            id: crypto.randomUUID(),
            ...input,
            status: 'Received',
            createdAt: new Date().toISOString(),
          };
          store.reports.push(report);
          persistStore(dataFile, store);
          sendJson(res, 201, { report, message: 'Observation saved.' });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/subscribe') {
          const email = validateSubscription(await readJsonBody(req));
          const store = readStore(dataFile);
          const alreadySaved = store.subscribers.some((subscriber) => subscriber.email === email);
          if (!alreadySaved) {
            store.subscribers.push({ email, createdAt: new Date().toISOString() });
            persistStore(dataFile, store);
          }
          sendJson(res, 201, {
            saved: true,
            alreadySaved,
            message: 'Your address has been saved for this demo.',
          });
          return;
        }

        if (pathname === '/api/dashboard' || pathname === '/api/health' || pathname === '/api/reports' || pathname === '/api/subscribe') {
          res.setHeader('Allow', pathname === '/api/subscribe' ? 'GET, POST' : pathname === '/api/reports' ? 'GET, POST' : 'GET');
          sendJson(res, 405, { error: 'Method not allowed.' });
          return;
        }

        sendJson(res, 404, { error: 'API endpoint not found.' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }

      let requestedPath;
      try {
        requestedPath = decodeURIComponent(pathname);
      } catch {
        sendJson(res, 400, { error: 'Invalid request path.' });
        return;
      }
      if (requestedPath === '/') requestedPath = '/index.html';
      let filePath = path.resolve(publicDir, `.${requestedPath}`);
      const publicRoot = path.resolve(publicDir);
      if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
        sendJson(res, 403, { error: 'Forbidden.' });
        return;
      }

      let stats;
      try {
        stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
          stats = fs.statSync(filePath);
        }
      } catch {
        sendJson(res, 404, { error: 'Page not found.' });
        return;
      }

      const body = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.status : 500;
      if (statusCode >= 500) console.error('[sflood]', error);
      if (!res.headersSent) {
        sendJson(res, statusCode, {
          error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.',
        });
      } else {
        res.destroy();
      }
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`sflood demo is available at http://${host}:${port}`);
    console.log('Using simulated sample readings. Do not rely on this demo for emergency decisions.');
  });
}

module.exports = { createServer, validateReport, validateSubscription, buildDashboard };
