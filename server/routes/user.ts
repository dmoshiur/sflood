import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import {
  currentTimestamp, execute, getFeatureFlag, insertAudit, primaryTenantId, queryAll, queryOne, randomId, rowText,
} from '../database.js';
import { requireCsrf, requireSession } from '../auth.js';
import type { AuthUser } from '../rbac.js';
import { checkServiceAreaEligibility } from '../service-areas.js';
import { isTrustedPushEndpoint } from '../push-validation.js';
import { asyncHandler, fail, forbidden, unauthorized } from '../http.js';

/**
 * Registered-user surface: profile, avatar upload, notification preferences,
 * browser push subscriptions and the in-app notification centre.
 */

export const userRouter = express.Router();

const pushLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const avatarLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

userRouter.use(requireSession);

userRouter.get('/profile', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const row = await queryOne('SELECT * FROM users WHERE id=?', [user.id]);
  if (!row) { unauthorized(res, 'Account not found.'); return; }
  const prefs = await queryOne('SELECT * FROM notification_preferences WHERE user_id=?', [user.id]);
  const area = rowText(row, 'service_area_id')
    ? await queryOne('SELECT city,country,country_code FROM service_areas WHERE id=?', [rowText(row, 'service_area_id')])
    : null;
  res.json({
    profile: {
      id: rowText(row, 'id'), email: rowText(row, 'email'), displayName: rowText(row, 'display_name'),
      role: rowText(row, 'role', 'MEMBER'), phone: rowText(row, 'phone') || null,
      avatarUrl: rowText(row, 'avatar_url') || null,
      emailVerified: Boolean(rowText(row, 'email_verified_at')), phoneVerified: Boolean(rowText(row, 'phone_verified_at')),
      serviceArea: area ? { city: rowText(area, 'city'), country: rowText(area, 'country'), countryCode: rowText(area, 'country_code') } : null,
      createdAt: rowText(row, 'created_at'), lastLoginAt: rowText(row, 'last_login_at') || null,
    },
    preferences: prefs
      ? {
          emailEnabled: rowText(prefs, 'email_enabled') === '1', smsEnabled: rowText(prefs, 'sms_enabled') === '1',
          pushEnabled: rowText(prefs, 'push_enabled') === '1', inAppEnabled: rowText(prefs, 'in_app_enabled') === '1',
          minSeverity: rowText(prefs, 'min_severity', 'WATCH'), recoveryEnabled: rowText(prefs, 'recovery_enabled') === '1',
        }
      : { emailEnabled: true, smsEnabled: false, pushEnabled: true, inAppEnabled: true, minSeverity: 'WATCH', recoveryEnabled: true },
  });
}));

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(100).optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional().or(z.literal('')),
  serviceAreaId: z.string().min(3).max(64).optional(),
});

userRouter.put('/profile', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the display name, phone number (E.164) and service area.'); return; }
  const row = await queryOne('SELECT * FROM users WHERE id=?', [user.id]);
  if (!row) { unauthorized(res, 'Account not found.'); return; }

  if (parsed.data.serviceAreaId && parsed.data.serviceAreaId !== rowText(row, 'service_area_id')) {
    const eligibility = await checkServiceAreaEligibility({ serviceAreaId: parsed.data.serviceAreaId, ip: req.ip });
    if (!eligibility.allowed) { fail(res, 403, eligibility.reason); return; }
    await execute('UPDATE users SET service_area_id=? WHERE id=?', [parsed.data.serviceAreaId, user.id]);
    await insertAudit({
      tenantId: user.tenantId, actorId: user.id, action: 'PROFILE_SERVICE_AREA_CHANGED', targetType: 'user', targetId: user.id,
      metadata: { serviceAreaId: parsed.data.serviceAreaId, city: eligibility.serviceArea?.city, ipMatches: eligibility.ipMatches },
      ipAddress: req.ip,
    });
  }
  if (parsed.data.displayName) await execute('UPDATE users SET display_name=? WHERE id=?', [parsed.data.displayName, user.id]);
  if (parsed.data.phone !== undefined) {
    await execute('UPDATE users SET phone=?,phone_verified_at=NULL WHERE id=?', [parsed.data.phone || null, user.id]);
  }
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'PROFILE_UPDATED', targetType: 'user', targetId: user.id, metadata: { fields: Object.keys(parsed.data) }, ipAddress: req.ip });
  const updated = await queryOne('SELECT * FROM users WHERE id=?', [user.id]);
  res.json({
    profile: {
      displayName: rowText(updated, 'display_name'), phone: rowText(updated, 'phone') || null,
      serviceAreaId: rowText(updated, 'service_area_id') || null,
    },
    message: 'Profile updated.',
  });
}));

/**
 * Cloudinary avatar upload.
 *
 * The browser uploads directly to Cloudinary with a short-lived, single-purpose
 * signature produced here. The API secret never leaves the server, and the
 * signed payload is bound to this user's folder so it cannot be replayed for
 * somebody else's account.
 */
userRouter.post('/avatar/signature', avatarLimiter, requireCsrf, asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const cloud = config.publicConfig().cloudinary;
  if (!cloud.configured) {
    fail(res, 503, 'Image uploads are not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_SECRET (or an upload preset).');
    return;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `${config.cloudinaryFolder}/${user.id}`;
  const publicId = `avatar-${crypto.randomBytes(6).toString('hex')}`;
  const params: Record<string, string> = { folder, public_id: publicId, timestamp: String(timestamp), overwrite: 'true' };
  if (config.cloudinaryApiSecret) {
    const toSign = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&') + config.cloudinaryApiSecret;
    params.signature = crypto.createHash('sha256').update(toSign).digest('hex');
  }
  res.json({
    cloudName: config.cloudinaryCloudName,
    apiKey: config.cloudinaryApiKey || null,
    uploadPreset: config.cloudinaryUploadPreset || null,
    folder, publicId, timestamp, signature: params.signature || null,
    maxBytes: 2 * 1024 * 1024,
    allowedFormats: ['jpg', 'jpeg', 'png', 'webp'],
  });
}));

userRouter.post('/avatar', avatarLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = z.object({
    publicId: z.string().regex(/^[A-Za-z0-9_\-/]{1,200}$/),
    url: z.string().url().max(1024).refine((value) => value.startsWith('https://res.cloudinary.com/'), 'Avatar URL must be a Cloudinary delivery URL.'),
  }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'A valid Cloudinary public id and delivery URL are required.'); return; }
  if (!parsed.data.publicId.startsWith(`${config.cloudinaryFolder}/${user.id}/`)) {
    forbidden(res, 'That upload does not belong to your account folder.'); return;
  }
  await execute('UPDATE users SET avatar_url=?,avatar_public_id=? WHERE id=?', [parsed.data.url, parsed.data.publicId, user.id]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'PROFILE_AVATAR_UPDATED', targetType: 'user', targetId: user.id, metadata: { publicId: parsed.data.publicId }, ipAddress: req.ip });
  res.json({ avatarUrl: parsed.data.url, message: 'Profile image updated.' });
}));

userRouter.delete('/avatar', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  await execute('UPDATE users SET avatar_url=NULL,avatar_public_id=NULL WHERE id=?', [user.id]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'PROFILE_AVATAR_REMOVED', targetType: 'user', targetId: user.id, ipAddress: req.ip });
  res.json({ removed: true });
}));

const preferencesSchema = z.object({
  emailEnabled: z.boolean().optional(), smsEnabled: z.boolean().optional(), pushEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(), recoveryEnabled: z.boolean().optional(),
  minSeverity: z.enum(['INFO', 'WATCH', 'WARNING', 'CRITICAL']).optional(),
});

userRouter.put('/notifications/preferences', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Choose valid notification preferences.'); return; }
  const data = parsed.data;
  if (data.smsEnabled && !(await getFeatureFlag('sms_channel_enabled', false))) {
    fail(res, 409, 'SMS notifications are not enabled on this deployment.'); return;
  }
  if (data.smsEnabled && !user.phoneVerified) {
    fail(res, 409, 'Verify your phone number before enabling SMS notifications.'); return;
  }
  const existing = await queryOne('SELECT * FROM notification_preferences WHERE user_id=?', [user.id]);
  const now = currentTimestamp();
  const values = {
    emailEnabled: data.emailEnabled ?? (existing ? rowText(existing, 'email_enabled') === '1' : true),
    smsEnabled: data.smsEnabled ?? (existing ? rowText(existing, 'sms_enabled') === '1' : false),
    pushEnabled: data.pushEnabled ?? (existing ? rowText(existing, 'push_enabled') === '1' : true),
    inAppEnabled: data.inAppEnabled ?? (existing ? rowText(existing, 'in_app_enabled') === '1' : true),
    recoveryEnabled: data.recoveryEnabled ?? (existing ? rowText(existing, 'recovery_enabled') === '1' : true),
    minSeverity: data.minSeverity ?? (existing ? rowText(existing, 'min_severity', 'WATCH') : 'WATCH'),
  };
  await execute(
    `INSERT INTO notification_preferences(user_id,email_enabled,sms_enabled,push_enabled,in_app_enabled,min_severity,recovery_enabled,updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled,sms_enabled=excluded.sms_enabled,push_enabled=excluded.push_enabled,
       in_app_enabled=excluded.in_app_enabled,min_severity=excluded.min_severity,recovery_enabled=excluded.recovery_enabled,updated_at=excluded.updated_at`,
    [user.id, values.emailEnabled ? 1 : 0, values.smsEnabled ? 1 : 0, values.pushEnabled ? 1 : 0, values.inAppEnabled ? 1 : 0, values.minSeverity, values.recoveryEnabled ? 1 : 0, now],
  );
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'NOTIFICATION_PREFERENCES_UPDATED', targetType: 'user', targetId: user.id, metadata: values, ipAddress: req.ip });
  res.json({ preferences: values, message: 'Notification preferences saved.' });
}));

const pushSchema = z.object({
  consent: z.literal(true),
  zoneId: z.string().min(3).max(64).optional(),
  subscription: z.object({
    endpoint: z.string().url().max(2048).refine(isTrustedPushEndpoint, 'Push endpoint must use HTTPS and a supported browser push service.'),
    keys: z.object({ p256dh: z.string().min(20).max(256), auth: z.string().min(16).max(128) }),
  }),
});

userRouter.post('/push', pushLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Explicit consent and a supported browser push subscription are required.'); return; }
  if (!config.vapidPublicKey || !config.vapidPrivateKey) { fail(res, 503, 'Web Push is not configured on this deployment.'); return; }
  const tenantId = await primaryTenantId();
  const zoneId = parsed.data.zoneId || user.zoneId || (await queryOne('SELECT z.id FROM zones z JOIN cities c ON c.id=z.city_id WHERE c.tenant_id=? ORDER BY z.created_at LIMIT 1', [tenantId]))?.id as string | undefined;
  if (!zoneId) { fail(res, 503, 'No monitored zone is configured.'); return; }
  const { endpoint, keys } = parsed.data.subscription;
  const now = currentTimestamp();
  await execute(
    `INSERT INTO push_subscriptions(id,user_id,tenant_id,zone_id,endpoint,p256dh,auth,user_agent,consent_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,zone_id=excluded.zone_id,p256dh=excluded.p256dh,auth=excluded.auth,
       consent_at=excluded.consent_at,unsubscribed_at=NULL,user_agent=excluded.user_agent`,
    [randomId(), user.id, tenantId, zoneId, endpoint, keys.p256dh, keys.auth, (req.get('user-agent') || '').slice(0, 300), now, now],
  );
  await insertAudit({ tenantId, actorId: user.id, action: 'PUSH_SUBSCRIBED', targetType: 'push_subscription', targetId: endpoint.slice(0, 200), metadata: { zoneId }, ipAddress: req.ip });
  res.status(201).json({ saved: true, zoneId, message: 'Browser notifications are enabled for the monitored zone.' });
}));

userRouter.delete('/push', pushLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = z.object({ endpoint: z.string().url().max(2048) }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'A valid push endpoint is required.'); return; }
  await execute('UPDATE push_subscriptions SET unsubscribed_at=? WHERE endpoint=? AND (user_id=? OR user_id IS NULL)', [currentTimestamp(), parsed.data.endpoint, user.id]);
  res.json({ removed: true });
}));

userRouter.get('/push/subscriptions', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const rows = await queryAll('SELECT id,zone_id,endpoint,consent_at,last_used_at,unsubscribed_at FROM push_subscriptions WHERE user_id=? ORDER BY created_at DESC', [user.id]);
  res.json({ subscriptions: rows.map((row) => ({ id: rowText(row, 'id'), zoneId: rowText(row, 'zone_id'), endpoint: rowText(row, 'endpoint').slice(0, 120), consentAt: rowText(row, 'consent_at'), lastUsedAt: rowText(row, 'last_used_at') || null, active: !rowText(row, 'unsubscribed_at') })) });
}));

userRouter.get('/notifications', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const rows = await queryAll('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 60', [user.id]);
  const unread = rows.filter((row) => !rowText(row, 'read_at')).length;
  res.json({
    unread,
    notifications: rows.map((row) => ({
      id: rowText(row, 'id'), severity: rowText(row, 'severity', 'INFO'), title: rowText(row, 'title'),
      body: rowText(row, 'body'), url: rowText(row, 'url', '/app'), read: Boolean(rowText(row, 'read_at')), createdAt: rowText(row, 'created_at'),
    })),
  });
}));

userRouter.post('/notifications/:id/read', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  await execute('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', [currentTimestamp(), String(req.params.id), user.id]);
  res.json({ read: true });
}));

userRouter.post('/notifications/read-all', requireCsrf, asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const result = await execute('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [currentTimestamp(), user.id]);
  res.json({ read: result.rowsAffected });
}));

userRouter.get('/deliveries', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const rows = await queryAll(
    `SELECT d.* FROM notification_deliveries d WHERE d.channel IN ('EMAIL','SMS')
       AND d.recipient IN (SELECT email FROM users WHERE id=? UNION SELECT phone FROM users WHERE id=? AND phone IS NOT NULL)
     ORDER BY d.created_at DESC LIMIT 50`,
    [user.id, user.id],
  );
  res.json({
    deliveries: rows.map((row) => ({
      id: rowText(row, 'id'), channel: rowText(row, 'channel'), status: rowText(row, 'status'),
      attempts: Number(row.attempts ?? 0), retryCount: Number(row.retry_count ?? 0),
      providerMessageId: rowText(row, 'provider_message_id') || null, failureReason: rowText(row, 'failure_reason') || null,
      sentAt: rowText(row, 'sent_at') || null, createdAt: rowText(row, 'created_at'),
    })),
  });
}));

export { forbidden };
