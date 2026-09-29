import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { config, assertProductionSecrets } from './config.js';
import {
  connectDatabase, currentTimestamp, execute, isMaintenanceMode, isTursoConfigured, migrateDatabase, primaryTenantId,
  queryAll, queryOne, randomId, rowNumber, tableCounts,
} from './database.js';
import { insertAudit } from './database.js';
import { authRouter } from './auth.js';
import { publicRouter } from './routes/public.js';
import { userRouter } from './routes/user.js';
import { devicesRouter } from './routes/devices.js';
import { adminRouter } from './routes/admin.js';
import { siteBuilderRouter } from './routes/sitebuilder.js';
import { opsRouter, startOpsRotation, stopOpsRotation } from './routes/ops.js';
import { simulationRouter, stopAllSimulations } from './routes/simulation.js';
import { startNotificationWorker, stopNotificationWorker, processDeliveryQueue } from './notifications.js';
import { expireStaleCommands } from './commands.js';
import { asyncHandler } from './http.js';

/**
 * FloodGrid API assembly.
 *
 * Everything is served from a single Express process: the JSON API, the built
 * PWA from dist/, and the health endpoints. In development the Vite dev server
 * proxies /api to this process.
 */

const app = express();
const port = config.port;
const host = config.host;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(projectRoot, 'dist');

const startedAt = new Date().toISOString();
let databaseReady = false;
let lastMigrationError: string | null = null;

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy || false);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://res.cloudinary.com",
      "connect-src 'self'",
      "font-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
  );
  next();
});

app.use(express.json({ limit: '32kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 400, standardHeaders: 'draft-8', legacyHeaders: false });
const telemetryLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false });

/* ------------------------------- health ------------------------------- */

app.get('/api/health', asyncHandler(async (_req, res) => {
  const counts = databaseReady ? await tableCounts() : null;
  res.json({
    status: databaseReady ? 'ok' : 'degraded',
    service: 'floodgrid-api',
    version: process.env.APP_VERSION || '1.0.0',
    mode: config.isLocalDatabase ? 'local-database' : 'turso',
    databaseReady,
    database: config.isLocalDatabase ? 'libsql (local file)' : 'libsql (Turso)',
    uptimeSeconds: Math.round(process.uptime()),
    startedAt,
    now: currentTimestamp(),
    counts,
  });
}));

app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'alive', uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/api/health/ready', asyncHandler(async (_req, res) => {
  if (!databaseReady) {
    res.status(503).json({ status: 'not-ready', reason: lastMigrationError || 'Database migrations have not completed.' });
    return;
  }
  try {
    await execute('SELECT 1');
    res.json({ status: 'ready', mode: config.isLocalDatabase ? 'local-database' : 'turso' });
  } catch (error) {
    res.status(503).json({ status: 'not-ready', reason: (error as Error).message });
  }
}));

app.get('/api/health/detailed', asyncHandler(async (_req, res) => {
  const [maintenance, counts] = await Promise.all([isMaintenanceMode(), tableCounts()]);
  res.json({ status: 'ok', maintenanceMode: maintenance, counts, mode: config.isLocalDatabase ? 'local-database' : 'turso' });
}));

/* -------------------------------- routes ------------------------------- */

app.use('/api', apiLimiter);
app.use('/api/public', publicRouter);
app.use('/api/auth', authRouter);
app.use('/api/me', userRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin', siteBuilderRouter);
app.use('/api/ops', opsRouter);
app.use('/api/simulation', simulationRouter);

/**
 * Device-facing aliases at the documented /api/v1/* paths. The handlers live in
 * the devices router; this only rewrites the URL so firmware can use the stable
 * paths documented in docs/API.md.
 */
app.use('/api/v1', telemetryLimiter, (req, _res, next) => {
  req.url = `/v1${req.url}`;
  devicesRouter(req, _res, next);
});

/* ------------------------------ static app ----------------------------- */

if (fs.existsSync(distDirectory)) {
  app.use(
    express.static(distDirectory, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    }),
  );
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDirectory, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(503).type('text').send('FloodGrid: run "npm run build" (or use the Vite dev server on port 5173).');
  });
}

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const candidate = error as { status?: number; type?: string; code?: string; message?: string };
  if (candidate.type === 'entity.too.large') { res.status(413).json({ error: 'Request body exceeds the 32 KB limit.' }); return; }
  if (candidate.type === 'entity.parse.failed') { res.status(400).json({ error: 'Request body must be valid JSON.' }); return; }
  const code = candidate.code || '';
  if (code.startsWith('SQLITE_CONSTRAINT')) { res.status(409).json({ error: 'Duplicate, conflicting or replayed request.' }); return; }
  if (candidate.status && candidate.status >= 400 && candidate.status < 500) { res.status(candidate.status).json({ error: candidate.message || 'The request could not be completed.' }); return; }
  console.error('[floodgrid] unhandled error:', error);
  res.status(500).json({ error: 'The request could not be completed.' });
};
app.use(errorHandler);

/* -------------------------------- startup ------------------------------ */

async function startServer() {
  if (config.isProduction) assertProductionSecrets();
  try {
    await connectDatabase();
    const applied = await migrateDatabase();
    databaseReady = true;
    if (applied.length) console.log(`[floodgrid] applied migrations: ${applied.join(', ')}`);
    await execute(
      `INSERT OR IGNORE INTO deployment_info(id,tenant_id,environment,app_version,git_commit,deployed_at,note) VALUES (?,?,?,?,?,?,?)`,
      ['deploy-current', await primaryTenantId(), config.nodeEnv, process.env.APP_VERSION || '1.0.0', process.env.GIT_COMMIT || 'unknown', currentTimestamp(), 'Current deployment marker.'],
    );
  } catch (error) {
    lastMigrationError = (error as Error).message;
    console.error('[floodgrid] database startup failed:', error);
    process.exitCode = 1;
    return;
  }

  startNotificationWorker(10_000);
  startOpsRotation();

  const maintenanceTimer = setInterval(() => {
    void expireStaleCommands().catch(() => undefined);
  }, 60_000);
  maintenanceTimer.unref?.();

  const server = app.listen(port, host, () => {
    console.log(`[floodgrid] API listening on http://${host}:${port}`);
    console.log(`[floodgrid] mode: ${config.isLocalDatabase ? 'local libSQL database (data/floodgrid.db)' : 'Turso/libSQL'}`);
    console.log('[floodgrid] Public status page: /status · Dashboard: /app · Devices: /devices · Admin: /admin · Operations: /hackeradmin');
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopNotificationWorker();
      stopOpsRotation();
      stopAllSimulations();
      server.close(() => process.exit(0));
    });
  }
}

if (process.env.NODE_ENV !== 'test') void startServer();

export { app, processDeliveryQueue, insertAudit, queryAll, queryOne, randomId, rowNumber, isTursoConfigured };
