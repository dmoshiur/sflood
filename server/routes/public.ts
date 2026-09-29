import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import {
  currentTimestamp, execute, getSiteSetting, insertAudit, primaryTenantId, queryAll, queryOne, randomId, rowText,
} from '../database.js';
import { listServiceAreas } from '../service-areas.js';
import { notificationConfig, publicUrl, queueDelivery } from '../notifications.js';
import { hashToken } from '../security.js';
import { STATE_GUIDANCE, STATE_LABELS } from '../../shared/flood-engine.js';
import { asyncHandler, fail } from '../http.js';

/**
 * Public, unauthenticated surface:
 *   - live status page data (no account required)
 *   - service-area allowlist for registration
 *   - public email subscription with double opt-in
 *   - published site-builder pages
 *   - integration configuration that is safe to expose
 */

export const publicRouter = express.Router();

const subscribeLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false });

export async function buildPublicStatus() {
  const tenantId = await primaryTenantId();
  const devices = await queryAll(
    `SELECT d.*, z.name AS zone_name, c.name AS city_name FROM devices d
     JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id
     WHERE d.tenant_id=? AND d.enabled=1 ORDER BY d.created_at ASC`,
    [tenantId],
  );
  const latestByDevice = await Promise.all(devices.map(async (device) => {
    const point = await queryOne('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 1', [rowText(device, 'id')]);
    const previous = await queryOne('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 1 OFFSET 1', [rowText(device, 'id')]);
    return {
      deviceId: rowText(device, 'id'),
      uid: rowText(device, 'uid'),
      name: rowText(device, 'name'),
      board: rowText(device, 'board', 'ESP32'),
      simulation: rowText(device, 'simulation') === '1',
      zoneName: rowText(device, 'zone_name'),
      cityName: rowText(device, 'city_name'),
      approvalState: rowText(device, 'approval_state', 'PENDING'),
      online: Boolean(rowText(device, 'last_heartbeat_at') || rowText(device, 'last_seen_at')),
      levelCm: point ? Number(point.level_cm ?? 0) : null,
      state: point ? rowText(point, 'state', 'NORMAL') : 'NORMAL',
      barrier: rowText(device, 'barrier_state', 'DOWN'),
      sensorHealthy: point ? rowText(point, 'sensor_healthy') === '1' : true,
      rateCmPerMin: point && point.rate_cm_per_min !== null && point.rate_cm_per_min !== undefined ? Number(point.rate_cm_per_min) : null,
      simulated: point ? rowText(point, 'simulated') === '1' : false,
      lastUpdateAt: point ? rowText(point, 'created_at') : rowText(device, 'last_seen_at'),
      trendCm: point && previous ? Math.round((Number(point.level_cm ?? 0) - Number(previous.level_cm ?? 0)) * 10) / 10 : 0,
      limitSwitchLow: rowText(device, 'limit_switch_low') === '1',
      limitSwitchHigh: rowText(device, 'limit_switch_high') === '1',
      emergencyStopActive: rowText(device, 'emergency_stop_active') === '1',
      faultState: rowText(device, 'fault_state', 'NONE'),
    };
  }));

  const highest = latestByDevice.reduce<(typeof latestByDevice)[number] | null>((worst, item) => {
    if (!worst) return item;
    return (item.levelCm ?? 0) > (worst.levelCm ?? 0) ? item : worst;
  }, null);
  const headline = highest;
  const activeState = (headline?.state || 'NORMAL') as keyof typeof STATE_LABELS;
  const lastEvent = await queryOne('SELECT * FROM flood_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT 1', [tenantId]);
  const recentEvents = await queryAll('SELECT * FROM flood_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT 8', [tenantId]);
  const [maintenanceMode, statusEnabled, safetyNotice, safetyInstructions, siteName] = await Promise.all([
    getSiteSetting('maintenance_mode', false),
    getSiteSetting('public_status_enabled', true),
    getSiteSetting('safety_notice', 'Educational prototype. Not a real flood defence or emergency warning service.'),
    getSiteSetting('safety_instructions', []),
    getSiteSetting('site_name', config.publicConfig().projectName),
  ]);

  const history = headline
    ? (await queryAll('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 60', [headline.deviceId])).reverse().map((row) => ({
        seq: Number(row.seq ?? 0), levelCm: Number(row.level_cm ?? 0), state: rowText(row, 'state', 'NORMAL'),
        rateCmPerMin: row.rate_cm_per_min === null || row.rate_cm_per_min === undefined ? null : Number(row.rate_cm_per_min),
        simulated: rowText(row, 'simulated') === '1', createdAt: rowText(row, 'created_at'),
      }))
    : [];

  return {
    projectName: typeof siteName === 'string' ? siteName : config.publicConfig().projectName,
    mode: config.isLocalDatabase ? 'local-database' : 'turso',
    generatedAt: currentTimestamp(),
    maintenanceMode: Boolean(maintenanceMode),
    statusEnabled: Boolean(statusEnabled),
    safetyNotice: typeof safetyNotice === 'string' ? safetyNotice : '',
    safetyInstructions: Array.isArray(safetyInstructions) ? (safetyInstructions as string[]) : [],
    site: {
      city: headline?.cityName || 'Unconfigured',
      zone: headline?.zoneName || 'Unconfigured',
      devices: latestByDevice.length,
      simulationDevices: latestByDevice.filter((item) => item.simulation).length,
    },
    current: {
      state: activeState,
      label: STATE_LABELS[activeState] || 'Unknown',
      guidance: STATE_GUIDANCE[activeState] || '',
      levelCm: headline?.levelCm ?? null,
      trendCm: headline?.trendCm ?? 0,
      rateCmPerMin: headline?.rateCmPerMin ?? null,
      barrier: headline?.barrier || 'DOWN',
      sensorHealthy: headline?.sensorHealthy ?? true,
      emergencyStopActive: headline?.emergencyStopActive ?? false,
      faultState: headline?.faultState || 'NONE',
      simulated: Boolean(headline?.simulated),
      lastUpdateAt: headline?.lastUpdateAt || null,
      lastEvent: lastEvent
        ? { fromState: rowText(lastEvent, 'from_state'), toState: rowText(lastEvent, 'to_state'), reason: rowText(lastEvent, 'reason'), createdAt: rowText(lastEvent, 'created_at'), simulated: rowText(lastEvent, 'simulated') === '1' }
        : null,
    },
    devices: latestByDevice,
    events: recentEvents.map((row) => ({
      id: rowText(row, 'id'), fromState: rowText(row, 'from_state'), toState: rowText(row, 'to_state'),
      levelCm: row.level_cm === null || row.level_cm === undefined ? null : Number(row.level_cm),
      reason: rowText(row, 'reason'), simulated: rowText(row, 'simulated') === '1', createdAt: rowText(row, 'created_at'),
    })),
    history,
  };
}

publicRouter.get('/status', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const status = await buildPublicStatus();
  if (!status.statusEnabled) { res.status(503).json({ error: 'The public status page is disabled by the site administrator.' }); return; }
  res.json(status);
}));

publicRouter.get('/config', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...config.publicConfig(),
    notifications: await notificationConfig(),
    serviceAreas: (await listServiceAreas()).map((area) => ({
      id: area.id, city: area.city, region: area.region, country: area.country, countryCode: area.countryCode,
      latitude: area.latitude, longitude: area.longitude, requiresReview: area.requiresReview,
    })),
  });
}));

publicRouter.get('/service-areas', asyncHandler(async (_req, res) => {
  res.json({ serviceAreas: await listServiceAreas() });
}));

const subscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  consent: z.literal(true),
  zoneId: z.string().min(3).max(64).optional(),
  locale: z.enum(['en', 'bn']).optional(),
});

publicRouter.post('/subscribe', subscribeLimiter, asyncHandler(async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'A valid email address and explicit consent are required.'); return; }
  const tenantId = await primaryTenantId();
  const zoneId = parsed.data.zoneId || (await queryOne('SELECT z.id FROM zones z JOIN cities c ON c.id=z.city_id WHERE c.tenant_id=? ORDER BY z.created_at LIMIT 1', [tenantId]))?.id as string | undefined;
  if (!zoneId) { fail(res, 503, 'No monitored zone is configured yet.'); return; }

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const unsubscribeToken = crypto.randomBytes(32).toString('base64url');
  const now = currentTimestamp();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const email = parsed.data.email;
  const existing = await queryOne('SELECT id FROM email_subscribers WHERE zone_id=? AND email=? LIMIT 1', [zoneId, email]);
  const id = existing ? rowText(existing, 'id') : randomId();
  await execute(
    `INSERT INTO email_subscribers(id,tenant_id,zone_id,email,locale,consent_at,verification_token_hash,verification_expires_at,verified_at,unsubscribe_token_hash,unsubscribed_at,source,created_at)
     VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,'status-page',?)
     ON CONFLICT(id) DO UPDATE SET consent_at=excluded.consent_at,verification_token_hash=excluded.verification_token_hash,
       verification_expires_at=excluded.verification_expires_at,verified_at=NULL,unsubscribe_token_hash=excluded.unsubscribe_token_hash,
       unsubscribed_at=NULL,locale=excluded.locale`,
    [id, tenantId, zoneId, email, parsed.data.locale || 'en', now, hashToken(rawToken), expiresAt, hashToken(unsubscribeToken), now],
  );
  const verifyUrl = publicUrl('/api/public/verify', { token: rawToken });
  const unsubscribeUrl = publicUrl('/api/public/unsubscribe', { token: unsubscribeToken });
  const queued = await queueDelivery({
    tenantId, zoneId, channel: 'EMAIL', recipient: email, priority: 4,
    payload: {
      title: 'Confirm your FloodGrid status subscription',
      body: `Confirm this address to receive FloodGrid status updates: ${verifyUrl || 'open the status page and subscribe again'}`,
      url: '/status', severity: 'SYSTEM', unsubscribeUrl: unsubscribeUrl || undefined,
    },
  });
  await insertAudit({ tenantId, action: 'PUBLIC_SUBSCRIBER_PENDING', targetType: 'email_subscriber', targetId: id, metadata: { zoneId } });
  res.status(202).json({
    pending: true, verificationQueued: queued,
    message: queued
      ? 'Check your inbox and confirm the subscription link. No updates are sent until you confirm.'
      : 'Consent recorded. Email delivery is not configured on this deployment, so no confirmation message was sent.',
  });
}));

publicRouter.get('/verify', asyncHandler(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
  const result = await execute(
    'UPDATE email_subscribers SET verified_at=?,verification_token_hash=NULL,verification_expires_at=NULL WHERE verification_token_hash=? AND verification_expires_at>? AND unsubscribed_at IS NULL',
    [currentTimestamp(), hashToken(token), currentTimestamp()],
  );
  if (!result.rowsAffected) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
  res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Subscription confirmed</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>Subscription confirmed</h1><p>You will receive FloodGrid status updates for the monitored zone. FloodGrid is an educational prototype, not an emergency warning service.</p><a href="/status">Open the live status page</a></main>');
}));

publicRouter.get('/unsubscribe', asyncHandler(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid unsubscribe link.'); return; }
  const result = await execute(
    'UPDATE email_subscribers SET unsubscribed_at=?,verification_token_hash=NULL,verification_expires_at=NULL,unsubscribe_token_hash=NULL WHERE unsubscribe_token_hash=? AND unsubscribed_at IS NULL',
    [currentTimestamp(), hashToken(token)],
  );
  if (!result.rowsAffected) { res.status(400).type('text').send('Invalid or already used unsubscribe link.'); return; }
  res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>You are unsubscribed</h1><p>No further optional FloodGrid status updates will be sent to this address.</p></main>');
}));

/** Published site-builder page blocks. Rendered by the frontend block renderer. */
publicRouter.get('/page/:slug', asyncHandler(async (req, res) => {
  const row = await queryOne("SELECT * FROM site_pages WHERE slug=? AND status='PUBLISHED' LIMIT 1", [String(req.params.slug)]);
  if (!row) { fail(res, 404, 'That page is not published.'); return; }
  const versionId = rowText(row, 'published_version_id');
  const version = versionId ? await queryOne('SELECT * FROM site_page_versions WHERE id=?', [versionId]) : null;
  let blocks: unknown[] = [];
  try { blocks = JSON.parse(version ? rowText(version, 'blocks_json') : rowText(row, 'draft_json', '{"blocks":[]}')); } catch { blocks = []; }
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({
    slug: rowText(row, 'slug'),
    title: version ? rowText(version, 'title') : rowText(row, 'title'),
    version: version ? Number(version.version ?? 1) : 1,
    publishedAt: version ? rowText(version, 'published_at') : null,
    blocks,
  });
}));
