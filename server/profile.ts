/**
 * Signed-in user APIs: profile editing, Cloudinary avatar upload, notification
 * preferences and the in-app notification inbox.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { requireCsrf, requireSession, type AuthUser } from './auth.js';
import { hashPassword, verifyPassword } from './security.js';
import { DatabaseRequestError, execute, insertAudit, isTursoConfigured, randomId, currentTimestamp, rowText } from './database.js';

export const profileRouter = express.Router();

profileRouter.use(requireSession);

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(100).optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).or(z.literal('')).optional(),
  country: z.string().max(80).optional(),
  cityName: z.string().max(80).optional(),
  notificationPrefs: z.object({
    floodAlerts: z.boolean(),
    email: z.boolean(),
    push: z.boolean(),
    sms: z.boolean(),
  }).optional(),
});

profileRouter.get('/', async (_req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  try {
    const result = await execute('SELECT display_name,phone,phone_verified_at,country,city_name,avatar_url,notification_prefs_json,email_verified_at,created_at FROM users WHERE id=?', [user.id]);
    if (!result.rows.length) { res.status(404).json({ error: 'Account not found.' }); return; }
    const row = result.rows[0] as Record<string, unknown>;
    let notificationPrefs: unknown = {};
    try { notificationPrefs = JSON.parse(rowText(row, 'notification_prefs_json') || '{}'); } catch { /* defaults below */ }
    res.json({
      profile: {
        id: user.id,
        email: user.email,
        displayName: rowText(row, 'display_name'),
        phone: rowText(row, 'phone') || '',
        phoneVerified: Boolean(rowText(row, 'phone_verified_at')),
        country: rowText(row, 'country') || '',
        cityName: rowText(row, 'city_name') || '',
        avatarUrl: rowText(row, 'avatar_url') || null,
        emailVerified: Boolean(rowText(row, 'email_verified_at')),
        notificationPrefs: { floodAlerts: true, email: true, push: true, sms: false, ...(notificationPrefs as object) },
        createdAt: rowText(row, 'created_at'),
      },
    });
  } catch (error) { next(error); }
});

profileRouter.put('/', requireCsrf, async (req, res, next) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid profile payload.' }); return; }
  const user = res.locals.authUser as AuthUser;
  try {
    const current = await execute('SELECT notification_prefs_json FROM users WHERE id=?', [user.id]);
    if (!current.rows.length) { res.status(404).json({ error: 'Account not found.' }); return; }
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(rowText(current.rows[0], 'notification_prefs_json') || '{}'); } catch { /* keep empty */ }
    if (parsed.data.notificationPrefs) prefs = { ...prefs, ...parsed.data.notificationPrefs };
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (parsed.data.displayName !== undefined) { sets.push('display_name=?'); args.push(parsed.data.displayName); }
    if (parsed.data.phone !== undefined) {
      sets.push('phone=?'); args.push(parsed.data.phone || null);
      if (!parsed.data.phone) { sets.push('phone_verified_at=NULL'); }
    }
    if (parsed.data.country !== undefined) { sets.push('country=?'); args.push(parsed.data.country); }
    if (parsed.data.cityName !== undefined) { sets.push('city_name=?'); args.push(parsed.data.cityName); }
    sets.push('notification_prefs_json=?'); args.push(JSON.stringify(prefs));
    sets.push('updated_at=?'); args.push(currentTimestamp());
    args.push(user.id);
    await execute(`UPDATE users SET ${sets.join(',')} WHERE id=?`, args);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'PROFILE_UPDATED', targetType: 'user', targetId: user.id, metadata: { fields: Object.keys(parsed.data) }, ipAddress: req.ip });
    res.json({ saved: true, notificationPrefs: prefs });
  } catch (error) { next(error); }
});

const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) });
profileRouter.put('/password', requireCsrf, async (req, res, next) => {
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide the current password and a new password of at least 12 characters.' }); return; }
  const user = res.locals.authUser as AuthUser;
  try {
    const result = await execute('SELECT password_hash FROM users WHERE id=?', [user.id]);
    if (!result.rows.length || !(await verifyPassword(parsed.data.currentPassword, rowText(result.rows[0], 'password_hash')))) { res.status(400).json({ error: 'The current password is incorrect.' }); return; }
    await execute('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [await hashPassword(parsed.data.newPassword), currentTimestamp(), user.id]);
    await execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL', [currentTimestamp(), user.id, user.sessionId]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'PASSWORD_CHANGED', targetType: 'user', targetId: user.id, ipAddress: req.ip });
    res.json({ changed: true, message: 'Password updated. Other active sessions have been signed out.' });
  } catch (error) { next(error); }
});

const avatarSchema = z.object({
  dataUri: z.string().min(64).max(3_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const avatarLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false });

profileRouter.post('/avatar', avatarLimiter, requireCsrf, async (req, res, _next) => {
  const parsed = avatarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Upload a JPEG, PNG or WebP image under 2.5 MB.' }); return; }
  const user = res.locals.authUser as AuthUser;
  const expectedPrefix = `data:${parsed.data.mimeType};base64,`;
  if (!parsed.data.dataUri.startsWith(expectedPrefix)) { res.status(400).json({ error: 'Image data does not match the declared type.' }); return; }
  const base64 = parsed.data.dataUri.slice(expectedPrefix.length);
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > 2_500_000) { res.status(400).json({ error: 'Image is empty or larger than 2.5 MB.' }); return; }
  // Validate real image magic bytes — never trust the declared MIME type alone.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isWebp = bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const matchesType = (parsed.data.mimeType === 'image/jpeg' && isJpeg) || (parsed.data.mimeType === 'image/png' && isPng) || (parsed.data.mimeType === 'image/webp' && isWebp);
  if (!matchesType) { res.status(400).json({ error: 'File content is not a valid image of the declared type.' }); return; }

  const configured = Boolean(process.env.CLOUDINARY_URL || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET));
  if (!configured) {
    res.status(503).json({ error: 'Image upload is not configured. Set CLOUDINARY_URL (or the CLOUDINARY_* variables) server-side.' });
    return;
  }
  if (process.env.CLOUDINARY_URL) cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
  else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
  try {
    const upload = await new Promise<{ secure_url: string }>((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'floodguard/avatars', resource_type: 'image', format: parsed.data.mimeType.split('/')[1] },
        (error, result) => (error || !result ? reject(error || new Error('Upload failed')) : resolve(result as { secure_url: string })),
      ).end(bytes);
    });
    await execute('UPDATE users SET avatar_url=?,updated_at=? WHERE id=?', [upload.secure_url, currentTimestamp(), user.id]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'PROFILE_AVATAR_UPDATED', targetType: 'user', targetId: user.id, metadata: { bytes: bytes.length, mimeType: parsed.data.mimeType }, ipAddress: req.ip });
    res.json({ saved: true, avatarUrl: upload.secure_url });
  } catch (error) {
    res.status(502).json({ error: 'The image could not be uploaded to Cloudinary. Try again.' });
    void error;
  }
});

// ---------------------------------------------------------------------------
// In-app notification inbox
// ---------------------------------------------------------------------------

profileRouter.get('/inbox', async (req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  try {
    const result = await execute('SELECT id,kind,severity,title,body,link,read_at,created_at FROM in_app_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [user.id, limit]);
    const unread = await execute('SELECT COUNT(*) AS count FROM in_app_notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
    res.json({
      notifications: result.rows.map((raw) => ({
        id: rowText(raw, 'id'),
        kind: rowText(raw, 'kind'),
        severity: rowText(raw, 'severity'),
        title: rowText(raw, 'title'),
        body: rowText(raw, 'body'),
        link: rowText(raw, 'link') || null,
        readAt: rowText(raw, 'read_at') || null,
        createdAt: rowText(raw, 'created_at'),
      })),
      unread: Number((unread.rows[0] as Record<string, unknown> | undefined)?.count || 0),
    });
  } catch (error) { next(error); }
});

profileRouter.post('/inbox/:notificationId/read', requireCsrf, async (req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  try {
    await execute('UPDATE in_app_notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL', [currentTimestamp(), String(req.params.notificationId), user.id]);
    res.json({ read: true });
  } catch (error) { next(error); }
});

profileRouter.post('/inbox/read-all', requireCsrf, async (_req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  try {
    await execute('UPDATE in_app_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [currentTimestamp(), user.id]);
    res.json({ read: true });
  } catch (error) { next(error); }
});

/** Test-only helper: create an in-app notification row directly. */
export async function createInAppNotification(input: { userId: string; kind: string; severity: string; title: string; body: string; link?: string }) {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'In-app notifications require the database-backed deployment.');
  await execute('INSERT INTO in_app_notifications(id,user_id,kind,severity,title,body,link,created_at) VALUES(?,?,?,?,?,?,?,?)', [
    randomId(), input.userId, input.kind, input.severity, input.title, input.body, input.link || null, currentTimestamp(),
  ]);
}
