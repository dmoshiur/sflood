import crypto from 'node:crypto';
import express, { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { config } from '../config.js';
import {
  allFeatureFlags, currentTimestamp, execute, getSiteSetting, insertAudit, primaryTenantId, queryAll, queryOne,
  rowBoolean, rowIsSet, rowText, setFeatureFlag,
} from '../database.js';
import { requireCsrf, findRequestSession } from '../auth.js';
import { isSuperAdmin, type AuthUser } from '../rbac.js';
import { decryptSecret, generateOpsCredential, hashToken, opsCredentialShapeIsValid, safeEqual, verifyTotp } from '../security.js';
import { getSavedProvider } from '../providers.js';
import { setMaintenanceMode } from '../notifications.js';
import { issueBarrierCommand } from '../commands.js';
import { asyncHandler, clientIp, fail, forbidden, unauthorized } from '../http.js';

/**
 * Restricted operations console ("Hackeradmin").
 *
 * Access requires three independent factors:
 *   1. an authenticated super-admin session with verified TOTP
 *   2. the current rotating operations credential (emailed to the configured
 *      security mailbox, stored only as a hash, single use, short lived)
 *   3. a source IP inside OPS_CIDR_ALLOWLIST / ADMIN_CIDR_ALLOWLIST
 *
 * The rotating credential is never placed in a URL, never returned by any API,
 * never written to the frontend bundle and never logged. Only SHA-256 hashes are
 * stored. Attempts are rate limited per credential and per IP.
 */

export const opsRouter = express.Router();

const opsAttemptLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const OPS_SESSION_COOKIE = 'fg_ops_session';
const OPS_SESSION_TTL_MINUTES = config.opsSessionTtlMinutes;

function ipAllowed(address: string): boolean {
  const cidrs = config.opsCidrAllowlist.length ? config.opsCidrAllowlist : config.adminCidrAllowlist;
  if (!cidrs.length) return !config.isProduction;
  try {
    const client = ipaddr.process(address);
    return cidrs.some((cidr) => {
      try { const [range, prefix] = ipaddr.parseCIDR(cidr); return client.kind() === range.kind() && client.match(range, prefix); }
      catch { return false; }
    });
  } catch { return false; }
}

function parseCookies(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const chunk of (req.headers.cookie || '').split(';')) {
    const [name, ...parts] = chunk.trim().split('=');
    if (!name) continue;
    try { result[name] = decodeURIComponent(parts.join('=')); } catch { /* ignore */ }
  }
  return result;
}

async function findOpsSession(req: Request) {
  const token = parseCookies(req)[OPS_SESSION_COOKIE];
  if (!token || token.length < 32 || token.length > 128) return null;
  const row = await queryOne('SELECT * FROM ops_sessions WHERE token_hash=? LIMIT 1', [hashToken(token)]);
  if (!row || rowIsSet(row, 'revoked_at')) return null;
  if (new Date(rowText(row, 'expires_at')).getTime() <= Date.now()) return null;
  if (!safeEqual(hashToken(token), rowText(row, 'token_hash'))) return null;
  return row;
}

function opsCookie(token: string, expiresAt: Date): string {
  const age = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const secure = config.isProduction ? '; Secure' : '';
  return `${OPS_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}

async function securityEmailAddress(): Promise<string> {
  const fromEnv = (process.env.OPS_SECURITY_EMAIL || '').trim();
  if (fromEnv) return fromEnv;
  const row = await queryOne("SELECT value_json FROM site_settings WHERE key='ops_email'");
  if (!row) return '';
  try {
    const value = JSON.parse(rowText(row, 'value_json', '""'));
    return typeof value === 'string' ? value.trim() : '';
  } catch { return ''; }
}

/** Rotating credential generation and delivery. */
export async function rotateOpsCredential(actorId: string | null): Promise<{ credentialId: string; expiresAt: string; delivered: boolean }> {
  const tenantId = await primaryTenantId();
  const now = new Date();
  const latest = await queryOne('SELECT id FROM ops_credentials ORDER BY issued_at DESC LIMIT 1');
  const rotationIndex = latest ? Number(String(latest.id || '').replace(/\D/g, '').slice(-4) || 0) + 1 : 1;
  const credential = generateOpsCredential(rotationIndex);
  const ttlMinutes = config.opsCredentialTtlMinutes;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
  const credentialId = crypto.randomUUID();
  await execute(
    'INSERT INTO ops_credentials(id,tenant_id,credential_hash,label,issued_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?)',
    [credentialId, tenantId, hashToken(credential), `rotation-${rotationIndex}`, now.toISOString(), expiresAt.toISOString(), actorId],
  );
  await execute('UPDATE ops_credentials SET revoked_at=? WHERE id<>? AND revoked_at IS NULL AND consumed_at IS NULL', [now.toISOString(), credentialId]);

  const securityEmail = await securityEmailAddress();
  let delivered = false;
  if (securityEmail) {
    const smtp = await getSavedProvider('SMTP');
    if (smtp?.enabled) {
      try {
        const { sendEmail } = await import('../providers.js');
        await sendEmail(securityEmail, {
          title: 'FloodGrid operations credential',
          body: `Your rotating operations credential for the FloodGrid operations console is:\n\n${credential}\n\nIt expires at ${expiresAt.toISOString()} and can be used once. Do not forward it, do not paste it into a URL and do not store it in a browser.`,
        });
        delivered = true;
      } catch (error) {
        console.warn('[floodgrid] operations credential delivery failed:', (error as Error).message);
      }
    }
  }
  await insertAudit({
    tenantId, actorId, action: 'OPS_CREDENTIAL_ROTATED', targetType: 'ops_credential', targetId: credentialId,
    metadata: { expiresAt: expiresAt.toISOString(), delivered, rotation: rotationIndex },
  });
  return { credentialId, expiresAt: expiresAt.toISOString(), delivered };
}

let rotationTimer: NodeJS.Timeout | null = null;
export function startOpsRotation(): void {
  if (rotationTimer) return;
  const intervalMs = Math.max(60_000, config.opsRotationMinutes * 60_000);
  const tick = async () => {
    try {
      await execute('UPDATE ops_credentials SET revoked_at=? WHERE revoked_at IS NULL AND consumed_at IS NULL AND expires_at<=?', [currentTimestamp(), currentTimestamp()]);
      await rotateOpsCredential(null);
    } catch (error) {
      console.warn('[floodgrid] operations credential rotation failed:', (error as Error).message);
    }
  };
  void tick();
  rotationTimer = setInterval(() => void tick(), intervalMs);
  rotationTimer.unref?.();
}

export function stopOpsRotation(): void {
  if (rotationTimer) clearInterval(rotationTimer);
  rotationTimer = null;
}

async function recordFailure(ip: string, reason: string) {
  try {
    await execute('INSERT INTO ops_attempts(id,tenant_id,ip_address,attempt_key,created_at) VALUES (?,?,?,?,?)', [
      crypto.randomUUID(), await primaryTenantId(), ip, reason, currentTimestamp(),
    ]);
  } catch { /* rate-limit bookkeeping must never break the response */ }
}

/* --------------------------------- status -------------------------------- */

opsRouter.get('/status', asyncHandler(async (req, res) => {
  const smtp = await getSavedProvider('SMTP');
  const latest = await queryOne('SELECT issued_at,expires_at,consumed_at,revoked_at FROM ops_credentials ORDER BY issued_at DESC LIMIT 1');
  const session = await findOpsSession(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    available: true,
    securityEmailConfigured: Boolean(await securityEmailAddress()),
    smtpConfigured: Boolean(smtp?.enabled),
    rotationMinutes: config.opsRotationMinutes,
    credentialTtlMinutes: config.opsCredentialTtlMinutes,
    requireMfa: config.opsRequireMfa,
    ipAllowlistConfigured: Boolean(config.opsCidrAllowlist.length || config.adminCidrAllowlist.length),
    currentCredential: latest
      ? {
          issuedAt: rowText(latest, 'issued_at'), expiresAt: rowText(latest, 'expires_at'),
          consumed: Boolean(rowText(latest, 'consumed_at')), revoked: Boolean(rowText(latest, 'revoked_at')),
        }
      : null,
    opsSessionActive: Boolean(session),
    opsSessionExpiresAt: session ? rowText(session, 'expires_at') : null,
    note: 'The credential value is only ever sent to the configured security mailbox. It is never returned by this API.',
  });
}));

/* -------------------------------- sessions ------------------------------- */

const startSchema = z.object({
  credential: z.string().min(8).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

opsRouter.post('/session', opsAttemptLimiter, asyncHandler(async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Enter the operations credential from the security mailbox.'); return; }
  const ip = clientIp(req);
  if (!ipAllowed(ip)) { fail(res, 403, 'Your source IP is not in the operations allowlist.'); return; }

  const user = await findRequestSession(req);
  if (!user || !isSuperAdmin(user)) { unauthorized(res, 'Sign in as a super admin first.'); return; }
  if (!user.mfaVerified) { fail(res, 403, 'Verify your authenticator code before opening the operations console.', { code: 'MFA_REQUIRED' }); return; }

  const credential = parsed.data.credential.trim();
  if (!opsCredentialShapeIsValid(credential)) {
    await recordFailure(ip, 'shape');
    fail(res, 401, 'That operations credential is not valid.'); return;
  }
  const row = await queryOne('SELECT * FROM ops_credentials WHERE credential_hash=? LIMIT 1', [hashToken(credential)]);
  if (!row) {
    await recordFailure(ip, 'unknown');
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_SESSION_DENIED', targetType: 'ops', metadata: { reason: 'unknown-credential' }, ipAddress: ip });
    fail(res, 401, 'That operations credential is not valid.'); return;
  }
  if (rowIsSet(row, 'revoked_at') || rowText(row, 'consumed_at') || new Date(rowText(row, 'expires_at')).getTime() <= Date.now()) {
    await recordFailure(ip, 'expired');
    fail(res, 401, 'That operations credential has expired or was already used. Wait for the next rotation.'); return;
  }
  if (Number(row.failed_attempts || 0) >= config.opsMaxAttempts) {
    fail(res, 429, 'Too many failed attempts for this credential. Wait for the next rotation.'); return;
  }

  if (config.opsRequireMfa) {
    if (!parsed.data.totp) { fail(res, 401, 'Enter the six-digit authenticator code as the second factor.', { code: 'MFA_REQUIRED' }); return; }
    const userRow = await queryOne('SELECT totp_secret_enc FROM users WHERE id=?', [user.id]);
    if (!userRow || !rowText(userRow, 'totp_secret_enc') || !verifyTotp(decryptSecret(rowText(userRow, 'totp_secret_enc')), parsed.data.totp)) {
      await recordFailure(ip, 'mfa');
      fail(res, 401, 'The authenticator code is invalid.'); return;
    }
  }

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + OPS_SESSION_TTL_MINUTES * 60_000);
  const sessionId = crypto.randomUUID();
  const now = currentTimestamp();
  await execute(
    'INSERT INTO ops_sessions(id,tenant_id,user_id,token_hash,credential_id,ip_address,user_agent,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [sessionId, user.tenantId, user.id, hashToken(rawToken), rowText(row, 'id'), ip, (req.get('user-agent') || '').slice(0, 300), expiresAt.toISOString(), now],
  );
  await execute('UPDATE ops_credentials SET consumed_at=?,consumed_ip=? WHERE id=?', [now, ip, rowText(row, 'id')]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_SESSION_OPENED', targetType: 'ops_session', targetId: sessionId, metadata: { expiresAt: expiresAt.toISOString() }, ipAddress: ip });
  res.append('Set-Cookie', opsCookie(rawToken, expiresAt));
  res.json({ opened: true, expiresAt: expiresAt.toISOString(), message: 'Operations console unlocked.' });
}));

opsRouter.post('/session/end', asyncHandler(async (req, res) => {
  const token = parseCookies(req)[OPS_SESSION_COOKIE];
  if (token) await execute('UPDATE ops_sessions SET revoked_at=? WHERE token_hash=?', [currentTimestamp(), hashToken(token)]);
  res.append('Set-Cookie', `${OPS_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ closed: true });
}));

/** Middleware: super-admin session + live ops session + IP allowlist. */
const requireOpsAccess: express.RequestHandler = async (req, res, next) => {
  try {
    const user = await findRequestSession(req);
    if (!user || !isSuperAdmin(user)) { unauthorized(res, 'Sign in as a super admin first.'); return; }
    if (!user.mfaVerified) { fail(res, 403, 'Verify your authenticator code first.', { code: 'MFA_REQUIRED' }); return; }
    const ip = clientIp(req);
    if (!ipAllowed(ip)) { fail(res, 403, 'Your source IP is not in the operations allowlist.'); return; }
    const session = await findOpsSession(req);
    if (!session) { fail(res, 403, 'Unlock the operations console with the current rotating credential.', { code: 'OPS_LOCKED' }); return; }
    if (rowText(session, 'user_id') !== user.id) { forbidden(res, 'That operations session belongs to another account.'); return; }
    res.locals.authUser = user;
    res.locals.opsSessionId = rowText(session, 'id');
    next();
  } catch (error) { next(error); }
};

opsRouter.use(requireOpsAccess);

/* -------------------------------- console -------------------------------- */

opsRouter.get('/overview', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const [flags, maintenance, sessions, credentials, deployments, commands, audits] = await Promise.all([
    allFeatureFlags(),
    getSiteSetting('maintenance_mode', false),
    queryAll('SELECT s.*, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.revoked_at IS NULL AND s.expires_at>? ORDER BY s.created_at DESC LIMIT 30', [currentTimestamp()]),
    queryAll('SELECT id,issued_at,expires_at,consumed_at,revoked_at,failed_attempts FROM ops_credentials ORDER BY issued_at DESC LIMIT 10'),
    queryAll('SELECT * FROM deployment_info ORDER BY deployed_at DESC LIMIT 5'),
    queryAll('SELECT command_id,action,status,issued_at,device_id FROM barrier_commands ORDER BY issued_at DESC LIMIT 15'),
    queryAll('SELECT * FROM audit_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 60', [user.tenantId]),
  ]);
  res.json({
    version: process.env.APP_VERSION || '1.0.0',
    gitCommit: process.env.GIT_COMMIT || 'unknown',
    environment: config.nodeEnv,
    database: { mode: config.isLocalDatabase ? 'local-database' : 'turso', target: config.isLocalDatabase ? 'file:data/floodgrid.db' : 'turso (managed)' },
    flags,
    maintenanceMode: Boolean(maintenance),
    sessions: sessions.map((row) => ({
      id: rowText(row, 'id'), email: rowText(row, 'email'), ipAddress: rowText(row, 'ip_address') || null,
      mfaVerified: rowBoolean(row, 'mfa_verified'), expiresAt: rowText(row, 'expires_at'), createdAt: rowText(row, 'created_at'),
    })),
    credentials: credentials.map((row) => ({
      id: rowText(row, 'id'), issuedAt: rowText(row, 'issued_at'), expiresAt: rowText(row, 'expires_at'),
      consumed: Boolean(rowText(row, 'consumed_at')), revoked: Boolean(rowText(row, 'revoked_at')),
      failedAttempts: Number(row.failed_attempts || 0),
    })),
    deployments: deployments.map((row) => ({
      id: rowText(row, 'id'), environment: rowText(row, 'environment'), appVersion: rowText(row, 'app_version'),
      gitCommit: rowText(row, 'git_commit'), deployedAt: rowText(row, 'deployed_at'), note: rowText(row, 'note'),
    })),
    commands: commands.map((row) => ({
      commandId: rowText(row, 'command_id'), deviceId: rowText(row, 'device_id'), action: rowText(row, 'action'),
      status: rowText(row, 'status'), issuedAt: rowText(row, 'issued_at'),
    })),
    audit: audits.map((row) => {
      let metadata: unknown = {};
      try { metadata = JSON.parse(rowText(row, 'metadata_json', '{}')); } catch { /* ignore */ }
      return { id: rowText(row, 'id'), action: rowText(row, 'action'), targetType: rowText(row, 'target_type'), metadata, createdAt: rowText(row, 'created_at') };
    }),
  });
}));

opsRouter.post('/maintenance', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = z.object({ enabled: z.boolean(), reason: z.string().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Specify enabled and a reason.'); return; }
  await setMaintenanceMode(parsed.data.enabled, parsed.data.reason || 'Operations maintenance', user.id);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_MAINTENANCE_TOGGLED', targetType: 'site', metadata: { enabled: parsed.data.enabled }, ipAddress: clientIp(req) });
  res.json({ maintenanceMode: parsed.data.enabled });
}));

opsRouter.post('/emergency-status', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = z.object({
    status: z.enum(['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY']),
    note: z.string().max(300).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Choose an emergency site status.'); return; }
  const { setSiteSetting } = await import('../database.js');
  await setSiteSetting('emergency_site_status', parsed.data.status, user.id);
  await setSiteSetting('emergency_site_note', parsed.data.note || '', user.id);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_EMERGENCY_STATUS_SET', targetType: 'site', metadata: { status: parsed.data.status }, ipAddress: clientIp(req) });
  res.json({ emergencyStatus: parsed.data.status, message: 'Emergency site status published to the public status page.' });
}));

opsRouter.post('/devices/:deviceId/emergency', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = z.object({ action: z.enum(['EMERGENCY_STOP', 'RESET_FAULT', 'RAISE', 'LOWER', 'HOLD']) }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Choose an emergency device action.'); return; }
  const device = await queryOne('SELECT * FROM devices WHERE id=?', [String(req.params.deviceId)]);
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  const command = await issueBarrierCommand({
    tenantId: user.tenantId, zoneId: rowText(device, 'zone_id') || null, deviceId: String(req.params.deviceId),
    action: parsed.data.action, requestedBy: user.id, requestedByKind: 'OPS',
    reason: 'Emergency control from the operations console',
  });
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_DEVICE_EMERGENCY_COMMAND', targetType: 'device', targetId: String(req.params.deviceId), metadata: { action: parsed.data.action, commandId: command.commandId }, ipAddress: clientIp(req) });
  res.status(201).json({ commandId: command.commandId, action: command.action, expiresAt: command.expiresAt, message: 'Emergency command queued for the device.' });
}));

opsRouter.post('/sessions/:sessionId/revoke', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const result = await execute('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', [currentTimestamp(), String(req.params.sessionId)]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_SESSION_REVOKED', targetType: 'session', targetId: String(req.params.sessionId), ipAddress: clientIp(req) });
  res.json({ revoked: result.rowsAffected });
}));

opsRouter.post('/rotate', requireCsrf, asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const result = await rotateOpsCredential(user.id);
  res.json({
    rotated: true, expiresAt: result.expiresAt, delivered: result.delivered,
    message: result.delivered
      ? 'A new credential was generated and emailed to the security mailbox. The value is never returned here.'
      : 'A new credential was generated but could not be emailed: configure SMTP and OPS_SECURITY_EMAIL.',
  });
}));

opsRouter.put('/flags/:key', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Specify enabled as true or false.'); return; }
  await setFeatureFlag(String(req.params.key), parsed.data.enabled, '', user.id);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_FEATURE_FLAG_UPDATED', targetType: 'flag', targetId: String(req.params.key), metadata: { enabled: parsed.data.enabled }, ipAddress: clientIp(req) });
  res.json({ flags: await allFeatureFlags() });
}));

opsRouter.get('/superadmins', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const rows = await queryAll("SELECT id,email,display_name,disabled_at,totp_secret_enc,last_login_at,created_at FROM users WHERE role='OWNER' AND tenant_id=? ORDER BY created_at", [user.tenantId]);
  res.json({
    superAdmins: rows.map((row) => ({
      id: rowText(row, 'id'), email: rowText(row, 'email'), displayName: rowText(row, 'display_name'),
      disabled: Boolean(rowText(row, 'disabled_at')), mfaEnrolled: Boolean(rowText(row, 'totp_secret_enc')),
      lastLoginAt: rowText(row, 'last_login_at') || null, createdAt: rowText(row, 'created_at'),
    })),
  });
}));

opsRouter.post('/superadmins/:userId/reset-mfa', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (String(req.params.userId) === user.id) { fail(res, 400, 'You cannot reset your own MFA from the operations console.'); return; }
  const target = await queryOne("SELECT id,tenant_id FROM users WHERE id=? AND role='OWNER'", [String(req.params.userId)]);
  if (!target || rowText(target, 'tenant_id') !== user.tenantId) { fail(res, 404, 'Super admin not found.'); return; }
  const now = currentTimestamp();
  await execute('UPDATE users SET totp_secret_enc=NULL,totp_pending_enc=NULL,totp_pending_expires_at=NULL WHERE id=?', [String(req.params.userId)]);
  await execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now, String(req.params.userId)]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_SUPERADMIN_MFA_RESET', targetType: 'user', targetId: String(req.params.userId), ipAddress: clientIp(req) });
  res.json({ reset: true, message: 'MFA reset and all sessions revoked for that super admin.' });
}));

opsRouter.get('/audit', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const rows = await queryAll('SELECT * FROM audit_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200', [user.tenantId]);
  res.json({
    entries: rows.map((row) => {
      let metadata: unknown = {};
      try { metadata = JSON.parse(rowText(row, 'metadata_json', '{}')); } catch { /* ignore */ }
      return { id: rowText(row, 'id'), action: rowText(row, 'action'), targetType: rowText(row, 'target_type'), targetId: rowText(row, 'target_id') || null, metadata, ipAddress: rowText(row, 'ip_address') || null, createdAt: rowText(row, 'created_at') };
    }),
  });
}));

opsRouter.post('/backups', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = z.object({ note: z.string().max(300).optional(), kind: z.enum(['MANUAL', 'SCHEDULED']).optional() }).safeParse(req.body || {});
  if (!parsed.success) { fail(res, 400, 'Add an optional note.'); return; }
  const id = crypto.randomUUID();
  const now = currentTimestamp();
  await execute('INSERT INTO backups(id,tenant_id,kind,target,status,note,created_by,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)', [
    id, user.tenantId, parsed.data.kind || 'MANUAL', config.isLocalDatabase ? 'file:data/floodgrid.db' : 'turso', 'COMPLETED', parsed.data.note || '', user.id, now, now,
  ]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_BACKUP_RECORDED', targetType: 'backup', targetId: id, metadata: { kind: parsed.data.kind || 'MANUAL' }, ipAddress: clientIp(req) });
  res.status(201).json({
    id,
    message: config.isLocalDatabase
      ? 'Backup marker recorded. Copy data/floodgrid.db to safe storage; see docs/DEPLOYMENT.md for the full backup procedure.'
      : 'Backup marker recorded. Use the Turso backup tooling described in docs/DEPLOYMENT.md.',
  });
}));

opsRouter.get('/backups', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const rows = await queryAll('SELECT * FROM backups WHERE tenant_id=? ORDER BY created_at DESC LIMIT 30', [user.tenantId]);
  res.json({
    backups: rows.map((row) => ({
      id: rowText(row, 'id'), kind: rowText(row, 'kind'), target: rowText(row, 'target'), status: rowText(row, 'status'),
      note: rowText(row, 'note'), createdAt: rowText(row, 'created_at'), completedAt: rowText(row, 'completed_at') || null,
    })),
  });
}));

export { requireCsrf };
