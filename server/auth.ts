import crypto from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { execute, insertAudit, isTursoConfigured, randomId, requireTurso } from './database.js';
import { decryptSecret, encryptSecret, hashPassword, hashToken, safeEqual, totpUri, verifyPassword, verifyTotp, createTotpSecret } from './security.js';

const authRouter = express.Router();
const ownerRouter = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
const bootstrapLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
const inviteLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const totpLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });
const passwordSchema = z.string().min(12).max(128);
const emailSchema = z.string().email().max(254).transform((value) => value.trim().toLowerCase());
const nameSchema = z.string().trim().min(2).max(100);

type AuthUser = {
  id: string; email: string; displayName: string; role: string; tenantId: string;
  emailVerified: boolean; totpEnrolled: boolean; mfaVerified: boolean; sessionId: string;
};
type SessionRow = Record<string, unknown>;

function parseCookies(req: Request) {
  const result: Record<string, string> = {};
  for (const chunk of (req.headers.cookie || '').split(';')) {
    const [rawName, ...parts] = chunk.trim().split('=');
    if (!rawName) continue;
    try { result[rawName] = decodeURIComponent(parts.join('=')); } catch { /* malformed cookie: ignore */ }
  }
  return result;
}
function sameOrigin(req: Request, res: Response) {
  const origin = req.get('origin');
  if (!origin) { res.status(403).json({ error: 'A same-origin request is required.' }); return false; }
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const accepted = new Set([req.get('host')?.toLowerCase() || '']);
    if (process.env.PUBLIC_APP_URL) accepted.add(new URL(process.env.PUBLIC_APP_URL).host.toLowerCase());
    if (!accepted.has(originHost)) { res.status(403).json({ error: 'Cross-origin authentication requests are blocked.' }); return false; }
    return true;
  } catch { res.status(403).json({ error: 'Invalid request origin.' }); return false; }
}
function setSessionCookies(req: Request, res: Response, token: string, csrf: string, expiresAt: Date) {
  const age = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === 'production' || req.secure;
  const securePart = secure ? '; Secure' : '';
  res.append('Set-Cookie', `fg_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${securePart}`);
  res.append('Set-Cookie', `fg_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Strict; Max-Age=${age}${securePart}`);
}
function clearSessionCookies(res: Response) {
  res.append('Set-Cookie', 'fg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.append('Set-Cookie', 'fg_csrf=; Path=/; SameSite=Strict; Max-Age=0');
}
function isAllowedByList(address: string, list: string | undefined, allowDevelopment = true) {
  const cidrs = (list || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!cidrs.length) return allowDevelopment && process.env.NODE_ENV !== 'production';
  try {
    const client = ipaddr.process(address);
    return cidrs.some((cidr) => {
      try { const [range, prefix] = ipaddr.parseCIDR(cidr); return client.kind() === range.kind() && client.match(range, prefix); }
      catch { return false; }
    });
  } catch { return false; }
}
function userResponse(user: AuthUser) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, emailVerified: user.emailVerified, totpEnrolled: user.totpEnrolled, mfaVerified: user.mfaVerified };
}

async function createSession(req: Request, res: Response, user: SessionRow, mfaVerified: boolean) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const sessionId = randomId();
  const lifetimeHours = user.role === 'OWNER' || user.role === 'ADMIN' ? 4 : 12;
  const expiresAt = new Date(Date.now() + lifetimeHours * 60 * 60_000);
  const now = new Date().toISOString();
  await execute('INSERT INTO sessions(id,user_id,token_hash,csrf_hash,mfa_verified,ip_address,user_agent,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [
    sessionId, String(user.id), hashToken(rawToken), hashToken(csrf), mfaVerified ? 1 : 0, req.ip || null, req.get('user-agent')?.slice(0, 300) || null, expiresAt.toISOString(), now,
  ]);
  setSessionCookies(req, res, rawToken, csrf, expiresAt);
  res.locals.csrfToken = csrf;
  return { id: String(user.id), email: String(user.email), displayName: String(user.display_name), role: String(user.role), tenantId: String(user.tenant_id), emailVerified: Boolean(user.email_verified_at), totpEnrolled: Boolean(user.totp_secret_enc), mfaVerified, sessionId } satisfies AuthUser;
}

export async function findRequestSession(req: Request): Promise<AuthUser | null> {
  if (!isTursoConfigured) return null;
  const token = parseCookies(req).fg_session;
  if (!token || token.length < 32 || token.length > 128) return null;
  const result = await execute(`SELECT s.id AS session_id,s.token_hash,s.csrf_hash,s.mfa_verified,s.expires_at,s.revoked_at,
    u.id,u.email,u.display_name,u.role,u.tenant_id,u.email_verified_at,u.disabled_at,u.totp_secret_enc
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? LIMIT 1`, [hashToken(token)]);
  if (!result.rows.length) return null;
  const row = result.rows[0] as SessionRow;
  if (row.revoked_at || row.disabled_at || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
  if (!safeEqual(hashToken(token), String(row.token_hash))) return null;
  const elevated = row.role === 'OWNER' || row.role === 'ADMIN';
  return {
    id: String(row.id), email: String(row.email), displayName: String(row.display_name), role: String(row.role),
    tenantId: String(row.tenant_id), emailVerified: Boolean(row.email_verified_at), totpEnrolled: Boolean(row.totp_secret_enc),
    mfaVerified: !elevated || row.mfa_verified === 1 || row.mfa_verified === 1n, sessionId: String(row.session_id),
  };
}

export const requireSession: RequestHandler = async (req, res, next) => {
  try {
    if (!isTursoConfigured) { res.status(503).json({ error: 'Account access requires a configured Turso database.' }); return; }
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
    const token = parseCookies(req).fg_csrf;
    const header = req.get('x-csrf-token') || '';
    if (!user || !token || !header || !safeEqual(token, header)) { res.status(403).json({ error: 'CSRF token is missing or invalid.' }); return; }
    const result = await execute('SELECT csrf_hash FROM sessions WHERE id=? AND revoked_at IS NULL', [user.sessionId]);
    const csrfHash = result.rows.length ? String((result.rows[0] as SessionRow).csrf_hash) : '';
    if (!csrfHash || !safeEqual(hashToken(token), csrfHash)) { res.status(403).json({ error: 'CSRF session validation failed.' }); return; }
    next();
  } catch (error) { next(error); }
};

export const requireOwner: RequestHandler = (req, res, next) => {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user || user.role !== 'OWNER') { res.status(403).json({ error: 'This action requires the FloodGuard super-admin role.' }); return; }
  if (!user.mfaVerified || !user.totpEnrolled) { res.status(403).json({ error: 'Set up and verify an authenticator code before using super-admin controls.' }); return; }
  const allowlist = process.env.ADMIN_CIDR_ALLOWLIST;
  if (!isAllowedByList(req.ip || req.socket.remoteAddress || '', allowlist)) { res.status(403).json({ error: 'Your source IP is not in ADMIN_CIDR_ALLOWLIST.' }); return; }
  next();
};

async function ownerCount(activeOnly = true) {
  const result = await execute(activeOnly ? "SELECT COUNT(*) AS count FROM users WHERE role='OWNER' AND disabled_at IS NULL" : "SELECT COUNT(*) AS count FROM users WHERE role='OWNER'");
  return Number((result.rows[0] as SessionRow | undefined)?.count || 0);
}

authRouter.get('/status', async (_req, res, next) => {
  try {
    const count = isTursoConfigured ? await ownerCount(false) : 0;
    const tokenReady = Boolean(process.env.OWNER_BOOTSTRAP_TOKEN && process.env.OWNER_BOOTSTRAP_TOKEN.length >= 32);
    res.json({ databaseConfigured: isTursoConfigured, authEnabled: isTursoConfigured, bootstrapAvailable: isTursoConfigured && count === 0 && tokenReady, ownerCount: count });
  } catch (error) { next(error); }
});

authRouter.get('/me', requireSession, (req, res) => {
  res.json({ user: userResponse(res.locals.authUser as AuthUser), csrfToken: parseCookies(req).fg_csrf });
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  if (!isTursoConfigured) { res.status(503).json({ error: 'Account access is disabled until Turso is configured.' }); return; }
  const input = z.object({ email: emailSchema, password: z.string().min(1).max(128), totp: z.string().regex(/^\d{6}$/).optional() }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Enter a valid email and password.' }); return; }
  try {
    const result = await execute('SELECT * FROM users WHERE email=? LIMIT 1', [input.data.email]);
    const user = result.rows.length ? result.rows[0] as SessionRow : null;
    if (!user || user.disabled_at || !user.email_verified_at || !(await verifyPassword(input.data.password, String(user.password_hash)))) { res.status(401).json({ error: 'Email or password is incorrect, or the account is not verified.' }); return; }
    const elevated = user.role === 'OWNER' || user.role === 'ADMIN';
    let mfaVerified = !elevated;
    if (elevated && user.totp_secret_enc) {
      if (!input.data.totp) { res.status(401).json({ error: 'Enter the six-digit authenticator code.', code: 'MFA_REQUIRED' }); return; }
      const secret = decryptSecret(String(user.totp_secret_enc));
      if (!verifyTotp(secret, input.data.totp)) { res.status(401).json({ error: 'The authenticator code is invalid.', code: 'MFA_INVALID' }); return; }
      mfaVerified = true;
    }
    const authUser = await createSession(req, res, user, mfaVerified);
    await insertAudit({ tenantId: authUser.tenantId, actorId: authUser.id, action: 'AUTH_LOGIN', targetType: 'session', targetId: authUser.sessionId, ipAddress: req.ip });
    res.json({ user: userResponse(authUser), mfaSetupRequired: elevated && !authUser.totpEnrolled, csrfToken: res.locals.csrfToken });
  } catch (error) { next(error); }
});

authRouter.post('/bootstrap', bootstrapLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  if (!isTursoConfigured) { res.status(503).json({ error: 'Turso must be configured before creating the first super-admin.' }); return; }
  if (!isAllowedByList(req.ip || req.socket.remoteAddress || '', process.env.OWNER_BOOTSTRAP_CIDR_ALLOWLIST || process.env.ADMIN_CIDR_ALLOWLIST)) { res.status(403).json({ error: 'Bootstrap source IP must be allowlisted before production setup.' }); return; }
  const input = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema, token: z.string().min(32).max(256) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Name, valid email, 12+ character password and bootstrap token are required.' }); return; }
  const expected = process.env.OWNER_BOOTSTRAP_TOKEN || '';
  if (!expected || expected.length < 32 || !safeEqual(input.data.token, expected)) { res.status(401).json({ error: 'Bootstrap token is invalid or not configured.' }); return; }
  try {
    const passwordHash = await hashPassword(input.data.password);
    const tx = await requireTurso().transaction('write');
    let user: { id: string; email: string; display_name: string; role: 'OWNER'; tenant_id: string; email_verified_at: string; totp_secret_enc: null };
    try {
      const ownerResult = await tx.execute("SELECT COUNT(*) AS count FROM users WHERE role='OWNER'");
      if (Number((ownerResult.rows[0] as SessionRow | undefined)?.count || 0) > 0) {
        await tx.rollback();
        res.status(409).json({ error: 'A super-admin already exists; bootstrap is permanently closed.' });
        return;
      }
      const tenantResult = await tx.execute("SELECT id FROM tenants WHERE slug='floodguard-demo' ORDER BY created_at LIMIT 1");
      if (!tenantResult.rows.length) {
        await tx.rollback();
        res.status(503).json({ error: 'Run npm run db:seed before creating the first super-admin.' });
        return;
      }
      const tenantId = String((tenantResult.rows[0] as SessionRow).id);
      const now = new Date().toISOString();
      user = { id: crypto.randomUUID(), email: input.data.email, display_name: input.data.name, role: 'OWNER', tenant_id: tenantId, email_verified_at: now, totp_secret_enc: null };
      await tx.execute({ sql: 'INSERT INTO users(id,tenant_id,email,display_name,password_hash,role,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', args: [user.id, tenantId, user.email, user.display_name, passwordHash, 'OWNER', now, now, now] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
    const authUser = await createSession(req, res, user, false);
    await insertAudit({ tenantId: String(user.tenant_id), actorId: String(user.id), action: 'OWNER_BOOTSTRAP', targetType: 'user', targetId: String(user.id), ipAddress: req.ip });
    res.status(201).json({ user: userResponse(authUser), mfaSetupRequired: true, csrfToken: res.locals.csrfToken, message: 'Super-admin created. Set up an authenticator app before changing providers or users.' });
  } catch (error) { next(error); }
});

authRouter.post('/accept-invite', inviteLimiter, async (req, res, next) => {
  if (!sameOrigin(req, res)) return;
  if (!isTursoConfigured) { res.status(503).json({ error: 'Invitations require a configured Turso database.' }); return; }
  const input = z.object({ token: z.string().min(32).max(128), password: passwordSchema }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'A valid invite link and 12+ character password are required.' }); return; }
  try {
    const inviteResult = await execute('SELECT * FROM admin_invites WHERE token_hash=? AND used_at IS NULL AND expires_at>? LIMIT 1', [hashToken(input.data.token), new Date().toISOString()]);
    if (!inviteResult.rows.length) { res.status(400).json({ error: 'Invite link is invalid, expired, or already used.' }); return; }
    const invite = inviteResult.rows[0] as SessionRow;
    const now = new Date().toISOString();
    const user = { id: randomId(), email: String(invite.email), display_name: String(invite.display_name), role: String(invite.role), tenant_id: String(invite.tenant_id), email_verified_at: now, totp_secret_enc: null };
    const tx = await requireTurso().transaction('write');
    try {
      await tx.execute({ sql: 'INSERT INTO users(id,tenant_id,email,display_name,password_hash,role,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', args: [user.id, user.tenant_id, user.email, user.display_name, await hashPassword(input.data.password), user.role, now, now, now] });
      await tx.execute({ sql: 'UPDATE admin_invites SET used_at=? WHERE id=? AND used_at IS NULL', args: [now, String(invite.id)] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
    const authUser = await createSession(req, res, user, false);
    await insertAudit({ tenantId: user.tenant_id, actorId: user.id, action: 'INVITE_ACCEPTED', targetType: 'user', targetId: user.id, ipAddress: req.ip });
    res.status(201).json({ user: userResponse(authUser), mfaSetupRequired: user.role === 'OWNER' || user.role === 'ADMIN', csrfToken: res.locals.csrfToken, message: 'Invitation accepted. Set up authenticator MFA before using admin controls.' });
  } catch (error) { next(error); }
});

authRouter.post('/logout', requireSession, requireCsrf, async (_req, res, next) => {
  try {
    const user = res.locals.authUser as AuthUser;
    await execute('UPDATE sessions SET revoked_at=? WHERE id=?', [new Date().toISOString(), user.sessionId]);
    clearSessionCookies(res);
    res.json({ loggedOut: true });
  } catch (error) { next(error); }
});

authRouter.post('/totp/start', requireSession, requireCsrf, async (_req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  if (user.role !== 'OWNER' && user.role !== 'ADMIN') { res.status(403).json({ error: 'Authenticator enrollment is only required for admin accounts.' }); return; }
  try {
    const raw = await execute('SELECT email,totp_secret_enc FROM users WHERE id=?', [user.id]);
    if (!raw.rows.length) { res.status(401).json({ error: 'Account not found.' }); return; }
    if ((raw.rows[0] as SessionRow).totp_secret_enc) { res.status(409).json({ error: 'Authenticator MFA is already enabled. Contact another super-admin to reset it.' }); return; }
    const secret = createTotpSecret();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await execute('UPDATE users SET totp_pending_enc=?,totp_pending_expires_at=?,updated_at=? WHERE id=?', [encryptSecret(secret), expiresAt, new Date().toISOString(), user.id]);
    res.json({ secret, otpAuthUri: totpUri(user.email, secret), expiresAt, message: 'Add this secret to an authenticator app, then confirm a current six-digit code. Do not share the secret.' });
  } catch (error) { next(error); }
});

authRouter.post('/totp/confirm', totpLimiter, requireSession, requireCsrf, async (req, res, next) => {
  const user = res.locals.authUser as AuthUser;
  const input = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Enter a six-digit authenticator code.' }); return; }
  try {
    const raw = await execute('SELECT totp_pending_enc,totp_pending_expires_at FROM users WHERE id=?', [user.id]);
    if (!raw.rows.length) { res.status(401).json({ error: 'Account not found.' }); return; }
    const row = raw.rows[0] as SessionRow;
    if (!row.totp_pending_enc || new Date(String(row.totp_pending_expires_at || 0)).getTime() <= Date.now()) { res.status(400).json({ error: 'Authenticator setup expired. Start again.' }); return; }
    const secret = decryptSecret(String(row.totp_pending_enc));
    if (!verifyTotp(secret, input.data.code)) { res.status(400).json({ error: 'Authenticator code did not match. Try the current six-digit code.' }); return; }
    const tx = await requireTurso().transaction('write');
    try {
      await tx.execute({ sql: 'UPDATE users SET totp_secret_enc=?,totp_pending_enc=NULL,totp_pending_expires_at=NULL,updated_at=? WHERE id=?', args: [encryptSecret(secret), new Date().toISOString(), user.id] });
      await tx.execute({ sql: 'UPDATE sessions SET mfa_verified=1 WHERE id=?', args: [user.sessionId] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'MFA_TOTP_ENROLLED', targetType: 'user', targetId: user.id, ipAddress: req.ip });
    res.json({ enrolled: true, message: 'Authenticator MFA is enabled for this session.' });
  } catch (error) { next(error); }
});

ownerRouter.use(requireSession, requireOwner);

ownerRouter.get('/users', async (_req, res, next) => {
  try {
    const user = res.locals.authUser as AuthUser;
    const result = await execute('SELECT id,email,display_name,role,email_verified_at,disabled_at,totp_secret_enc,created_at FROM users WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200', [user.tenantId]);
    res.json({ users: result.rows.map((item) => {
      const row = item as SessionRow;
      return { id: String(row.id), email: String(row.email), displayName: String(row.display_name), role: String(row.role), emailVerified: Boolean(row.email_verified_at), disabled: Boolean(row.disabled_at), totpEnrolled: Boolean(row.totp_secret_enc), createdAt: String(row.created_at) };
    }) });
  } catch (error) { next(error); }
});

ownerRouter.post('/invites', requireCsrf, async (req, res, next) => {
  const input = z.object({ email: emailSchema, name: nameSchema }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Valid email and display name are required.' }); return; }
  const owner = res.locals.authUser as AuthUser;
  try {
    const existing = await execute('SELECT id FROM users WHERE email=? LIMIT 1', [input.data.email]);
    if (existing.rows.length) { res.status(409).json({ error: 'That email already has an account.' }); return; }
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const inviteId = randomId();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    await execute('INSERT INTO admin_invites(id,tenant_id,email,display_name,role,token_hash,invited_by,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [inviteId, owner.tenantId, input.data.email, input.data.name, 'OWNER', hashToken(rawToken), owner.id, expiresAt, now]);
    await insertAudit({ tenantId: owner.tenantId, actorId: owner.id, action: 'SUPERADMIN_INVITE_CREATED', targetType: 'invite', targetId: inviteId, metadata: { email: input.data.email, role: 'OWNER' }, ipAddress: req.ip });
    const publicOrigin = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
    const inviteUrl = new URL('/register', publicOrigin);
    inviteUrl.searchParams.set('invite', rawToken);
    res.status(201).json({ inviteId, inviteUrl: inviteUrl.toString(), expiresAt, message: 'Copy this one-time invite link to the recipient using a secure channel. It is only shown now.' });
  } catch (error) { next(error); }
});

ownerRouter.patch('/users/:userId', requireCsrf, async (req, res, next) => {
  const input = z.object({ disabled: z.boolean() }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: 'Specify disabled as true or false.' }); return; }
  const owner = res.locals.authUser as AuthUser;
  const targetId = String(req.params.userId);
  if (targetId === owner.id) { res.status(400).json({ error: 'You cannot disable your own current owner account.' }); return; }
  try {
    const targetResult = await execute('SELECT id,role,tenant_id,disabled_at FROM users WHERE id=?', [targetId]);
    if (!targetResult.rows.length || String((targetResult.rows[0] as SessionRow).tenant_id) !== owner.tenantId) { res.status(404).json({ error: 'Account not found.' }); return; }
    const target = targetResult.rows[0] as SessionRow;
    if (input.data.disabled && target.role === 'OWNER' && !target.disabled_at && await ownerCount() <= 1) { res.status(409).json({ error: 'The last active super-admin cannot be disabled.' }); return; }
    const now = new Date().toISOString();
    await execute('UPDATE users SET disabled_at=?,updated_at=? WHERE id=?', [input.data.disabled ? now : null, now, targetId]);
    if (input.data.disabled) await execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now, targetId]);
    await insertAudit({ tenantId: owner.tenantId, actorId: owner.id, action: input.data.disabled ? 'ADMIN_ACCOUNT_DISABLED' : 'ADMIN_ACCOUNT_ENABLED', targetType: 'user', targetId, ipAddress: req.ip });
    res.json({ updated: true });
  } catch (error) { next(error); }
});

ownerRouter.post('/users/:userId/mfa/reset', requireCsrf, async (req, res, next) => {
  const owner = res.locals.authUser as AuthUser;
  const targetId = String(req.params.userId);
  if (targetId === owner.id) { res.status(400).json({ error: 'You cannot reset MFA for your own current super-admin session.' }); return; }
  try {
    const targetResult = await execute('SELECT id,tenant_id,role FROM users WHERE id=?', [targetId]);
    if (!targetResult.rows.length || String((targetResult.rows[0] as SessionRow).tenant_id) !== owner.tenantId) { res.status(404).json({ error: 'Account not found.' }); return; }
    const target = targetResult.rows[0] as SessionRow;
    if (target.role !== 'OWNER') { res.status(400).json({ error: 'Only another super-admin account can be reset from Hackeradmin.' }); return; }
    const now = new Date().toISOString();
    const tx = await requireTurso().transaction('write');
    try {
      await tx.execute({ sql: 'UPDATE users SET totp_secret_enc=NULL,totp_pending_enc=NULL,totp_pending_expires_at=NULL,updated_at=? WHERE id=?', args: [now, targetId] });
      await tx.execute({ sql: 'UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', args: [now, targetId] });
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
    await insertAudit({ tenantId: owner.tenantId, actorId: owner.id, action: 'SUPERADMIN_MFA_RESET', targetType: 'user', targetId, ipAddress: req.ip });
    res.json({ reset: true, message: 'MFA was reset and all sessions for that super-admin were revoked. They must enroll a new authenticator at next sign-in.' });
  } catch (error) { next(error); }
});

ownerRouter.get('/audit', async (_req, res, next) => {
  try {
    const owner = res.locals.authUser as AuthUser;
    const result = await execute('SELECT a.id,a.action,a.target_type,a.target_id,a.metadata_json,a.ip_address,a.created_at,u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT 200', [owner.tenantId]);
    res.json({ entries: result.rows.map((item) => {
      const row = item as SessionRow;
      let metadata: unknown = {};
      try { metadata = JSON.parse(String(row.metadata_json || '{}')); } catch { /* audit data stays visible without parsed metadata */ }
      return { id: String(row.id), action: String(row.action), targetType: String(row.target_type), targetId: row.target_id ? String(row.target_id) : null, metadata, ipAddress: row.ip_address ? String(row.ip_address) : null, createdAt: String(row.created_at), actorEmail: row.actor_email ? String(row.actor_email) : 'System' };
    }) });
  } catch (error) { next(error); }
});

export { authRouter, ownerRouter };
