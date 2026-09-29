import crypto from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { config } from './config.js';
import {
  currentTimestamp, execute, insertAudit, primaryTenantId, queryAll, queryOne, randomId, rowBoolean, rowIsSet, rowText,
} from './database.js';
import {
  createTotpSecret, encryptSecret, decryptSecret, hashPassword, hashToken, passwordProblem, safeEqual, totpUri, verifyPassword, verifyTotp,
} from './security.js';
import { checkServiceAreaEligibility } from './service-areas.js';
import { publicUrl, queueDelivery } from './notifications.js';
import type { AuthUser } from './rbac.js';

/**
 * Authentication, sessions and account lifecycle.
 *
 * - Passwords: bcrypt (cost 12), policy enforced server-side.
 * - Sessions: 256-bit opaque tokens in HttpOnly, SameSite=Strict, Secure cookies
 *   plus a double-submit CSRF token. Short lifetimes for privileged accounts.
 * - Verification: email confirmation with expiring single-use tokens.
 * - MFA: TOTP (RFC 6238) required for staff accounts.
 */

export const authRouter = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const passwordLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false });
const bootstrapLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
const totpLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const nameSchema = z.string().trim().min(2).max(100);
const MAX_LOGIN_FAILURES = 8;
const LOCK_MINUTES = 15;

function parseCookies(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const chunk of (req.headers.cookie || '').split(';')) {
    const [rawName, ...parts] = chunk.trim().split('=');
    if (!rawName) continue;
    try { result[rawName] = decodeURIComponent(parts.join('=')); } catch { /* malformed cookie ignored */ }
  }
  return result;
}

function sameOrigin(req: Request, res: Response): boolean {
  const origin = req.get('origin');
  if (!origin) { res.status(403).json({ error: 'A same-origin request is required.' }); return false; }
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const accepted = new Set([(req.get('host') || '').toLowerCase()]);
    if (config.publicAppUrl) accepted.add(new URL(config.publicAppUrl).host.toLowerCase());
    if (!accepted.has(originHost)) { res.status(403).json({ error: 'Cross-origin authentication requests are blocked.' }); return false; }
    return true;
  } catch { res.status(403).json({ error: 'Invalid request origin.' }); return false; }
}

function cookieOptions(maxAgeSeconds: number, secure: boolean): string {
  return [`Path=/`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`, secure ? 'Secure' : ''].filter(Boolean).join('; ');
}

function setSessionCookies(req: Request, res: Response, token: string, csrf: string, expiresAt: Date) {
  const age = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const secure = config.isProduction || req.secure;
  res.append('Set-Cookie', `fg_session=${encodeURIComponent(token)}; ${cookieOptions(age, secure)}`);
  res.append('Set-Cookie', `fg_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);
}

function clearSessionCookies(res: Response) {
  res.append('Set-Cookie', `fg_session=; ${cookieOptions(0, true)}`);
  res.append('Set-Cookie', 'fg_csrf=; Path=/; SameSite=Strict; Max-Age=0');
}

function ipAllowedByCidr(address: string, cidrs: string[]): boolean {
  if (!cidrs.length) return !config.isProduction;
  try {
    const client = ipaddr.process(address);
    return cidrs.some((cidr) => {
      try { const [range, prefix] = ipaddr.parseCIDR(cidr); return client.kind() === range.kind() && client.match(range, prefix); }
      catch { return false; }
    });
  } catch { return false; }
}

function publicUser(user: AuthUser) {
  return {
    id: user.id, email: user.email, displayName: user.displayName, role: user.role,
    emailVerified: user.emailVerified, phoneVerified: user.phoneVerified,
    totpEnrolled: user.totpEnrolled, mfaVerified: user.mfaVerified,
    cityId: user.cityId, zoneId: user.zoneId, serviceAreaId: user.serviceAreaId,
  };
}

async function createSession(req: Request, res: Response, user: Record<string, unknown>, mfaVerified: boolean): Promise<AuthUser> {
  const role = rowText(user, 'role', 'MEMBER') as AuthUser['role'];
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const sessionId = randomId();
  const privileged = role === 'OWNER' || role === 'ADMIN' || role === 'OPERATOR';
  const lifetimeHours = role === 'OWNER' || role === 'ADMIN'
    ? config.adminSessionTtlHours
    : privileged ? 8 : config.sessionTtlHours;
  const expiresAt = new Date(Date.now() + lifetimeHours * 60 * 60_000);
  await execute(
    'INSERT INTO sessions(id,user_id,token_hash,csrf_hash,mfa_verified,ip_address,user_agent,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [sessionId, rowText(user, 'id'), hashToken(rawToken), hashToken(csrf), mfaVerified ? 1 : 0, req.ip || null, (req.get('user-agent') || '').slice(0, 300), expiresAt.toISOString(), currentTimestamp()],
  );
  setSessionCookies(req, res, rawToken, csrf, expiresAt);
  res.locals.csrfToken = csrf;
  return {
    id: rowText(user, 'id'), email: rowText(user, 'email'), displayName: rowText(user, 'display_name'),
    role, tenantId: rowText(user, 'tenant_id'), cityId: user.city_id ? rowText(user, 'city_id') : null,
    zoneId: user.zone_id ? rowText(user, 'zone_id') : null, serviceAreaId: user.service_area_id ? rowText(user, 'service_area_id') : null,
    emailVerified: rowIsSet(user, 'email_verified_at'), phoneVerified: rowIsSet(user, 'phone_verified_at'),
    totpEnrolled: rowIsSet(user, 'totp_secret_enc'), mfaVerified, sessionId, disabled: rowIsSet(user, 'disabled_at'),
  };
}

export async function findRequestSession(req: Request): Promise<AuthUser | null> {
  const token = parseCookies(req).fg_session;
  if (!token || token.length < 32 || token.length > 128) return null;
  const result = await queryOne(
    `SELECT s.id AS session_id, s.token_hash, s.csrf_hash, s.mfa_verified, s.expires_at, s.revoked_at,
            u.id, u.email, u.display_name, u.role, u.tenant_id, u.city_id, u.zone_id, u.service_area_id,
            u.email_verified_at, u.phone_verified_at, u.disabled_at, u.totp_secret_enc
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? LIMIT 1`,
    [hashToken(token)],
  );
  if (!result) return null;
  if (rowIsSet(result, 'revoked_at') || rowIsSet(result, 'disabled_at')) return null;
  if (new Date(rowText(result, 'expires_at')).getTime() <= Date.now()) return null;
  if (!safeEqual(hashToken(token), rowText(result, 'token_hash'))) return null;
  const elevated = ['ADMIN', 'OWNER', 'OPERATOR'].includes(rowText(result, 'role'));
  return {
    id: rowText(result, 'id'), email: rowText(result, 'email'), displayName: rowText(result, 'display_name'),
    role: rowText(result, 'role', 'MEMBER') as AuthUser['role'], tenantId: rowText(result, 'tenant_id'),
    cityId: result.city_id ? rowText(result, 'city_id') : null, zoneId: result.zone_id ? rowText(result, 'zone_id') : null,
    serviceAreaId: result.service_area_id ? rowText(result, 'service_area_id') : null,
    emailVerified: rowIsSet(result, 'email_verified_at'), phoneVerified: rowIsSet(result, 'phone_verified_at'),
    totpEnrolled: rowIsSet(result, 'totp_secret_enc'), mfaVerified: !elevated || rowBoolean(result, 'mfa_verified'),
    sessionId: rowText(result, 'session_id'), disabled: false,
  };
}

export const requireSession: RequestHandler = async (req, res, next) => {
  try {
    const user = await findRequestSession(req);
    if (!user) { res.status(401).json({ error: 'Sign in to continue.' }); return; }
    res.locals.authUser = user;
    next();
  } catch (error) { next(error); }
};

export const requireCsrf: RequestHandler = async (req, res, next) => {
  try {
    if (!sameOrigin(req, res)) return;
    const user = res.locals.authUser as AuthUser | undefined;
    const cookieToken = parseCookies(req).fg_csrf;
    const header = req.get('x-csrf-token') || '';
    if (!user || !cookieToken || !header || !safeEqual(cookieToken, header)) { res.status(403).json({ error: 'CSRF token is missing or invalid.' }); return; }
    const session = await queryOne('SELECT csrf_hash FROM sessions WHERE id=? AND revoked_at IS NULL', [user.sessionId]);
    const csrfHash = session ? rowText(session, 'csrf_hash') : '';
    if (!csrfHash || !safeEqual(hashToken(cookieToken), csrfHash)) { res.status(403).json({ error: 'CSRF session validation failed.' }); return; }
    next();
  } catch (error) { next(error); }
};

async function sendVerificationEmail(userId: string, email: string, tenantId: string) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await execute('UPDATE users SET email_verification_token_hash=?,email_verification_expires_at=? WHERE id=?', [hashToken(rawToken), expiresAt, userId]);
  const link = publicUrl('/api/auth/verify-email', { token: rawToken });
  await queueDelivery({
    tenantId, channel: 'EMAIL', recipient: email, priority: 4,
    payload: {
      title: 'Confirm your FloodGrid account',
      body: `Confirm your email address to activate alerts and notifications: ${link || 'open the app and request a new link'}`,
      url: '/app', severity: 'SYSTEM',
    },
  });
}

authRouter.get('/status', async (_req, res, next) => {
  try {
    const owner = await queryOne("SELECT COUNT(*) AS count FROM users WHERE role='OWNER' AND disabled_at IS NULL");
    const ownerCount = Number(owner?.count || 0);
    const tokenReady = Boolean(process.env.OWNER_BOOTSTRAP_TOKEN && process.env.OWNER_BOOTSTRAP_TOKEN.length >= 32);
    res.json({
      databaseConfigured: true,
      bootstrapAvailable: ownerCount === 0 && tokenReady,
      ownerCount,
      registrationOpen: process.env.PUBLIC_REGISTRATION_OPEN !== 'false',
    });
  } catch (error) { next(error); }
});

authRouter.get('/me', requireSession, (req, res) => {
  const user = res.locals.authUser as AuthUser;
  res.json({ user: publicUser(user), csrfToken: parseCookies(req).fg_csrf });
});

authRouter.post('/register', registerLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  const input = z.object({
    displayName: nameSchema,
    email: emailSchema,
    password: z.string().min(1).max(128),
    serviceAreaId: z.string().min(3).max(64),
    city: z.string().trim().min(2).max(100).optional(),
    countryCode: z.string().trim().length(2).optional(),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Enter your name, a valid email, a password and a service area.' }); return; }
  const problem = passwordProblem(input.data.password, config.passwordMinLength);
  if (problem) { res.status(400).json({ error: problem }); return; }
  try {
    const eligibility = await checkServiceAreaEligibility({
      serviceAreaId: input.data.serviceAreaId, city: input.data.city, countryCode: input.data.countryCode, ip: req.ip,
    });
    if (!eligibility.allowed) { res.status(403).json({ error: eligibility.reason }); return; }

    const existing = await queryOne('SELECT id FROM users WHERE email=? LIMIT 1', [input.data.email]);
    if (existing) { res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' }); return; }

    const tenantId = await primaryTenantId();
    const area = eligibility.serviceArea!;
    const city = await queryOne('SELECT id FROM cities WHERE tenant_id=? AND name=? LIMIT 1', [tenantId, area.city]);
    const zone = city ? await queryOne('SELECT id FROM zones WHERE city_id=? ORDER BY created_at LIMIT 1', [rowText(city, 'id')]) : null;
    const userId = randomId();
    const now = currentTimestamp();
    const passwordHash = await hashPassword(input.data.password);
    await execute(
      `INSERT INTO users(id,tenant_id,city_id,zone_id,email,display_name,password_hash,role,phone,service_area_id,created_at,updated_at,password_updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, tenantId, city ? rowText(city, 'id') : null, zone ? rowText(zone, 'id') : null, input.data.email, input.data.displayName, passwordHash, 'MEMBER', input.data.phone || null, area.id, now, now, now],
    );
    await execute(
      `INSERT INTO notification_preferences(user_id,email_enabled,sms_enabled,push_enabled,in_app_enabled,min_severity,recovery_enabled,updated_at)
       VALUES (?,1,0,1,1,'WATCH',1,?)`,
      [userId, now],
    );
    const user = await queryOne('SELECT * FROM users WHERE id=?', [userId]);
    const authUser = await createSession(req, res, user as Record<string, unknown>, false);
    await insertAudit({
      tenantId, actorId: userId, action: 'AUTH_REGISTER', targetType: 'user', targetId: userId,
      metadata: { serviceAreaId: area.id, city: area.city, country: area.country, ipCountry: eligibility.ipCountryCode, ipMatches: eligibility.ipMatches, requiresReview: eligibility.requiresReview },
      ipAddress: req.ip,
    });
    await sendVerificationEmail(userId, input.data.email, tenantId);
    res.status(201).json({
      user: publicUser(authUser), csrfToken: res.locals.csrfToken, verificationEmailQueued: true,
      message: eligibility.ipMatches === false
        ? 'Account created. Your network location differs from the service area you selected; this was recorded for review.'
        : 'Account created. Check your email to confirm the address.',
    });
  } catch (error) { next(error); }
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  const input = z.object({
    email: emailSchema, password: z.string().min(1).max(128), totp: z.string().regex(/^\d{6}$/).optional(),
  }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Enter a valid email and password.' }); return; }
  try {
    const user = await queryOne('SELECT * FROM users WHERE email=? LIMIT 1', [input.data.email]);
    if (!user || rowIsSet(user, 'disabled_at')) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      res.status(401).json({ error: 'Email or password is incorrect.' }); return;
    }
    if (rowText(user, 'locked_until') && new Date(rowText(user, 'locked_until')).getTime() > Date.now()) {
      res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' }); return;
    }
    if (!rowIsSet(user, 'email_verified_at')) { res.status(403).json({ error: 'Confirm your email address before signing in.' }); return; }
    const valid = await verifyPassword(input.data.password, rowText(user, 'password_hash'));
    if (!valid) {
      const failures = Number(user.failed_login_count || 0) + 1;
      await execute('UPDATE users SET failed_login_count=?,locked_until=? WHERE id=?', [
        failures, failures >= MAX_LOGIN_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null, rowText(user, 'id'),
      ]);
      await insertAudit({ tenantId: rowText(user, 'tenant_id'), actorId: rowText(user, 'id'), action: 'AUTH_LOGIN_FAILED', targetType: 'user', targetId: rowText(user, 'id'), metadata: { failures }, ipAddress: req.ip });
      res.status(401).json({ error: 'Email or password is incorrect.' }); return;
    }
    const role = rowText(user, 'role', 'MEMBER');
    const elevated = ['ADMIN', 'OWNER', 'OPERATOR'].includes(role);
    let mfaVerified = !elevated;
    if (elevated && rowIsSet(user, 'totp_secret_enc')) {
      if (!input.data.totp) { res.status(401).json({ error: 'Enter the six-digit authenticator code.', code: 'MFA_REQUIRED' }); return; }
      const secret = decryptSecret(rowText(user, 'totp_secret_enc'));
      if (!verifyTotp(secret, input.data.totp)) {
        await insertAudit({ tenantId: rowText(user, 'tenant_id'), actorId: rowText(user, 'id'), action: 'AUTH_MFA_FAILED', targetType: 'user', targetId: rowText(user, 'id'), ipAddress: req.ip });
        res.status(401).json({ error: 'The authenticator code is invalid.', code: 'MFA_INVALID' }); return;
      }
      mfaVerified = true;
    }
    await execute('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=? WHERE id=?', [currentTimestamp(), rowText(user, 'id')]);
    const authUser = await createSession(req, res, user, mfaVerified);
    await insertAudit({ tenantId: authUser.tenantId, actorId: authUser.id, action: 'AUTH_LOGIN', targetType: 'session', targetId: authUser.sessionId, ipAddress: req.ip });
    res.json({ user: publicUser(authUser), csrfToken: res.locals.csrfToken, mfaSetupRequired: elevated && !authUser.totpEnrolled });
  } catch (error) { next(error); }
});

authRouter.post('/logout', requireSession, requireCsrf, async (_req, res, next) => {
  try {
    const user = res.locals.authUser as AuthUser;
    await execute('UPDATE sessions SET revoked_at=? WHERE id=?', [currentTimestamp(), user.sessionId]);
    clearSessionCookies(res);
    res.json({ loggedOut: true });
  } catch (error) { next(error); }
});

authRouter.post('/verify-email/resend', requireSession, requireCsrf, async (_req, res, next) => {
  try {
    const user = res.locals.authUser as AuthUser;
    if (user.emailVerified) { res.json({ queued: false, message: 'Your email is already confirmed.' }); return; }
    await sendVerificationEmail(user.id, user.email, user.tenantId);
    res.json({ queued: true, message: 'A new confirmation link was sent.' });
  } catch (error) { next(error); }
});

authRouter.get('/verify-email', verifyLimiter, async (req, res, next) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
  try {
    const result = await execute(
      'UPDATE users SET email_verified_at=?,email_verification_token_hash=NULL,email_verification_expires_at=NULL WHERE email_verification_token_hash=? AND email_verification_expires_at>? AND email_verified_at IS NULL',
      [currentTimestamp(), hashToken(token), currentTimestamp()],
    );
    if (!result.rowsAffected) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
    res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Email confirmed</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>Email confirmed</h1><p>Your FloodGrid account is verified. FloodGrid is an educational prototype, not an emergency warning service.</p><a href="/app">Open the dashboard</a></main>');
  } catch (error) { next(error); }
});

authRouter.post('/password/forgot', passwordLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  const input = z.object({ email: emailSchema }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Enter a valid email address.' }); return; }
  try {
    const user = await queryOne('SELECT id,tenant_id,email,disabled_at FROM users WHERE email=? LIMIT 1', [input.data.email]);
    if (user && !rowIsSet(user, 'disabled_at')) {
      const rawToken = crypto.randomBytes(32).toString('base64url');
      await execute('UPDATE users SET password_reset_token_hash=?,password_reset_expires_at=? WHERE id=?', [
        hashToken(rawToken), new Date(Date.now() + 60 * 60_000).toISOString(), rowText(user, 'id'),
      ]);
      const link = publicUrl('/reset-password', { token: rawToken });
      await queueDelivery({
        tenantId: rowText(user, 'tenant_id'), channel: 'EMAIL', recipient: rowText(user, 'email'), priority: 4,
        payload: { title: 'Reset your FloodGrid password', body: `Reset your password: ${link || 'open the app and request a new link'}`, url: '/reset-password', severity: 'SYSTEM' },
      });
      await insertAudit({ tenantId: rowText(user, 'tenant_id'), actorId: rowText(user, 'id'), action: 'AUTH_PASSWORD_RESET_REQUESTED', targetType: 'user', targetId: rowText(user, 'id'), ipAddress: req.ip });
    }
    res.json({ queued: true, message: 'If that address has an account, a reset link is on its way.' });
  } catch (error) { next(error); }
});

authRouter.post('/password/reset', passwordLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  const input = z.object({ token: z.string().min(32).max(128), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'A valid reset token and a new password are required.' }); return; }
  const problem = passwordProblem(input.data.password, config.passwordMinLength);
  if (problem) { res.status(400).json({ error: problem }); return; }
  try {
    const user = await queryOne('SELECT id,tenant_id,disabled_at FROM users WHERE password_reset_token_hash=? AND password_reset_expires_at>? LIMIT 1', [hashToken(input.data.token), currentTimestamp()]);
    if (!user || rowIsSet(user, 'disabled_at')) { res.status(400).json({ error: 'That reset link is invalid or expired.' }); return; }
    const passwordHash = await hashPassword(input.data.password);
    const now = currentTimestamp();
    await execute('UPDATE users SET password_hash=?,password_reset_token_hash=NULL,password_reset_expires_at=NULL,password_updated_at=?,failed_login_count=0,locked_until=NULL WHERE id=?', [passwordHash, now, rowText(user, 'id')]);
    await execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now, rowText(user, 'id')]);
    await insertAudit({ tenantId: rowText(user, 'tenant_id'), actorId: rowText(user, 'id'), action: 'AUTH_PASSWORD_RESET', targetType: 'user', targetId: rowText(user, 'id'), ipAddress: req.ip });
    res.json({ reset: true, message: 'Password updated. Sign in with your new password.' });
  } catch (error) { next(error); }
});

authRouter.post('/password/change', requireSession, requireCsrf, passwordLimiter, async (req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Enter your current password and a new password.' }); return; }
  const problem = passwordProblem(input.data.newPassword, config.passwordMinLength);
  if (problem) { res.status(400).json({ error: problem }); return; }
  try {
    const row = await queryOne('SELECT password_hash FROM users WHERE id=?', [user.id]);
    if (!row || !(await verifyPassword(input.data.currentPassword, rowText(row, 'password_hash')))) {
      res.status(401).json({ error: 'Your current password is incorrect.' }); return;
    }
    const passwordHash = await hashPassword(input.data.newPassword);
    await execute('UPDATE users SET password_hash=?,password_updated_at=? WHERE id=?', [passwordHash, currentTimestamp(), user.id]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'AUTH_PASSWORD_CHANGED', targetType: 'user', targetId: user.id, ipAddress: req.ip });
    res.json({ changed: true, message: 'Password updated.' });
  } catch (error) { next(error); }
});

authRouter.post('/totp/start', requireSession, requireCsrf, async (_req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  if (!['ADMIN', 'OWNER', 'OPERATOR'].includes(user.role)) { res.status(403).json({ error: 'Authenticator MFA is required for staff accounts.' }); return; }
  try {
    const row = await queryOne('SELECT email,totp_secret_enc FROM users WHERE id=?', [user.id]);
    if (!row) { res.status(401).json({ error: 'Account not found.' }); return; }
    if (rowText(row, 'totp_secret_enc')) { res.status(409).json({ error: 'Authenticator MFA is already enabled.' }); return; }
    const secret = createTotpSecret();
    await execute('UPDATE users SET totp_pending_enc=?,totp_pending_expires_at=? WHERE id=?', [
      encryptSecret(secret), new Date(Date.now() + 10 * 60_000).toISOString(), user.id,
    ]);
    res.json({ secret, otpAuthUri: totpUri(user.email, secret), expiresInSeconds: 600, message: 'Add this secret to an authenticator app, then confirm a current six-digit code.' });
  } catch (error) { next(error); }
});

authRouter.post('/totp/confirm', totpLimiter, requireSession, requireCsrf, async (req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  const input = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Enter a six-digit authenticator code.' }); return; }
  try {
    const row = await queryOne('SELECT totp_pending_enc,totp_pending_expires_at FROM users WHERE id=?', [user.id]);
    if (!row) { res.status(401).json({ error: 'Account not found.' }); return; }
    if (!rowText(row, 'totp_pending_enc') || new Date(rowText(row, 'totp_pending_expires_at')).getTime() <= Date.now()) {
      res.status(400).json({ error: 'Authenticator setup expired. Start again.' }); return;
    }
    const secret = decryptSecret(rowText(row, 'totp_pending_enc'));
    if (!verifyTotp(secret, input.data.code)) { res.status(400).json({ error: 'Authenticator code did not match.' }); return; }
    await execute('UPDATE users SET totp_secret_enc=?,totp_pending_enc=NULL,totp_pending_expires_at=NULL WHERE id=?', [encryptSecret(secret), user.id]);
    await execute('UPDATE sessions SET mfa_verified=1 WHERE id=?', [user.sessionId]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'MFA_TOTP_ENROLLED', targetType: 'user', targetId: user.id, ipAddress: req.ip });
    res.json({ enrolled: true, message: 'Authenticator MFA is enabled for this session.' });
  } catch (error) { next(error); }
});

/** First super-admin creation. One-time, out-of-band, IP restricted. */
authRouter.post('/bootstrap', bootstrapLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  const input = z.object({ displayName: nameSchema, email: emailSchema, password: z.string().min(1).max(128), token: z.string().min(32).max(256) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Name, email, password and the bootstrap token are required.' }); return; }
  const problem = passwordProblem(input.data.password, config.passwordMinLength);
  if (problem) { res.status(400).json({ error: problem }); return; }
  const expected = process.env.OWNER_BOOTSTRAP_TOKEN || '';
  if (!expected || expected.length < 32 || !safeEqual(input.data.token, expected)) {
    res.status(401).json({ error: 'Bootstrap token is invalid or not configured.' }); return;
  }
  if (!ipAllowedByCidr(req.ip || req.socket.remoteAddress || '', config.adminCidrAllowlist)) {
    res.status(403).json({ error: 'Bootstrap source IP is not in ADMIN_CIDR_ALLOWLIST.' }); return;
  }
  try {
    const owners = await queryOne("SELECT COUNT(*) AS count FROM users WHERE role='OWNER'");
    if (Number(owners?.count || 0) > 0) { res.status(409).json({ error: 'A super-admin already exists. Bootstrap is permanently closed.' }); return; }
    const tenantId = await primaryTenantId();
    const now = currentTimestamp();
    const userId = randomId();
    await execute(
      `INSERT INTO users(id,tenant_id,email,display_name,password_hash,role,email_verified_at,created_at,updated_at,password_updated_at)
       VALUES (?,?,?,?,?,'OWNER',?,?,?,?)`,
      [userId, tenantId, input.data.email, input.data.displayName, await hashPassword(input.data.password), now, now, now, now],
    );
    await execute(
      'INSERT INTO notification_preferences(user_id,email_enabled,sms_enabled,push_enabled,in_app_enabled,min_severity,recovery_enabled,updated_at) VALUES (?,1,1,1,1,1,?,?)',
      [userId, now, now],
    );
    const user = await queryOne('SELECT * FROM users WHERE id=?', [userId]);
    const authUser = await createSession(req, res, user as Record<string, unknown>, false);
    await insertAudit({ tenantId, actorId: userId, action: 'OWNER_BOOTSTRAP', targetType: 'user', targetId: userId, ipAddress: req.ip });
    res.status(201).json({ user: publicUser(authUser), csrfToken: res.locals.csrfToken, mfaSetupRequired: true, message: 'Super-admin created. Enrol an authenticator app before using admin controls.' });
  } catch (error) { next(error); }
});

/** Local-admin / operator invitations are created by an admin and accepted here. */
authRouter.post('/accept-invite', registerLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  const input = z.object({ token: z.string().min(32).max(128), password: z.string().min(1).max(128), displayName: nameSchema.optional() }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'A valid invitation token and password are required.' }); return; }
  const problem = passwordProblem(input.data.password, config.passwordMinLength);
  if (problem) { res.status(400).json({ error: problem }); return; }
  try {
    const invite = await queryOne('SELECT * FROM admin_invites WHERE token_hash=? AND used_at IS NULL AND expires_at>? LIMIT 1', [hashToken(input.data.token), currentTimestamp()]);
    if (!invite) { res.status(400).json({ error: 'Invitation is invalid, expired or already used.' }); return; }
    const now = currentTimestamp();
    const userId = randomId();
    await execute(
      `INSERT INTO users(id,tenant_id,city_id,zone_id,email,display_name,password_hash,role,email_verified_at,created_at,updated_at,password_updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, rowText(invite, 'tenant_id'), invite.city_id ? rowText(invite, 'city_id') : null, invite.zone_id ? rowText(invite, 'zone_id') : null,
        rowText(invite, 'email'), input.data.displayName || rowText(invite, 'display_name'), await hashPassword(input.data.password), rowText(invite, 'role', 'ADMIN'), now, now, now, now],
    );
    await execute('UPDATE admin_invites SET used_at=? WHERE id=? AND used_at IS NULL', [now, rowText(invite, 'id')]);
    const user = await queryOne('SELECT * FROM users WHERE id=?', [userId]);
    const authUser = await createSession(req, res, user as Record<string, unknown>, false);
    await insertAudit({ tenantId: authUser.tenantId, actorId: userId, action: 'INVITE_ACCEPTED', targetType: 'user', targetId: userId, metadata: { role: authUser.role }, ipAddress: req.ip });
    res.status(201).json({ user: publicUser(authUser), csrfToken: res.locals.csrfToken, mfaSetupRequired: true, message: 'Invitation accepted. Enrol an authenticator app before using admin controls.' });
  } catch (error) { next(error); }
});

authRouter.get('/sessions', requireSession, async (_req, res, next) => {
  try {
    const user = res.locals.authUser as AuthUser;
    const rows = await queryAll('SELECT id,ip_address,user_agent,mfa_verified,created_at,expires_at,revoked_at FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 20', [user.id]);
    res.json({
      sessions: rows.map((row) => ({
        id: rowText(row, 'id'), current: rowText(row, 'id') === user.sessionId,
        ipAddress: rowText(row, 'ip_address') || null, userAgent: rowText(row, 'user_agent') || null,
        mfaVerified: rowBoolean(row, 'mfa_verified'), createdAt: rowText(row, 'created_at'),
        expiresAt: rowText(row, 'expires_at'), revoked: rowIsSet(row, 'revoked_at'),
      })),
    });
  } catch (error) { next(error); }
});

authRouter.post('/sessions/revoke-others', requireSession, requireCsrf, async (_req, res, next) => {
  try {
    const user = res.locals.authUser as AuthUser;
    const result = await execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL', [currentTimestamp(), user.id, user.sessionId]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'AUTH_SESSIONS_REVOKED', targetType: 'user', targetId: user.id, metadata: { revoked: result.rowsAffected }, ipAddress: _req.ip });
    res.json({ revoked: result.rowsAffected });
  } catch (error) { next(error); }
});

/** Used by the admin console to list accounts. */
export async function listUsers(tenantId: string, limit = 200) {
  const rows = await queryAll(
    `SELECT u.id,u.email,u.display_name,u.role,u.city_id,u.zone_id,u.service_area_id,u.email_verified_at,u.phone_verified_at,u.disabled_at,u.last_login_at,u.created_at,
            s.city AS service_city, s.country AS service_country
     FROM users u LEFT JOIN service_areas s ON s.id = u.service_area_id
     WHERE u.tenant_id=? ORDER BY u.created_at DESC LIMIT ?`,
    [tenantId, limit],
  );
  return rows.map((row) => ({
    id: rowText(row, 'id'), email: rowText(row, 'email'), displayName: rowText(row, 'display_name'),
    role: rowText(row, 'role', 'MEMBER'), cityId: rowText(row, 'city_id') || null, zoneId: rowText(row, 'zone_id') || null,
    serviceAreaId: rowText(row, 'service_area_id') || null,
    serviceCity: rowText(row, 'service_city') || null, serviceCountry: rowText(row, 'service_country') || null,
    emailVerified: rowIsSet(row, 'email_verified_at'), phoneVerified: rowIsSet(row, 'phone_verified_at'),
    disabled: rowIsSet(row, 'disabled_at'), lastLoginAt: rowText(row, 'last_login_at') || null, createdAt: rowText(row, 'created_at'),
  }));
}

export async function countActiveOwners(): Promise<number> {
  const row = await queryOne("SELECT COUNT(*) AS count FROM users WHERE role='OWNER' AND disabled_at IS NULL");
  return Number(row?.count || 0);
}
