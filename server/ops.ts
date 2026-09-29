/**
 * Rotating operations access for the /hackeradmin operations console.
 *
 * Every hour the server generates a fresh operations credential, stores only its
 * SHA-256 hash, and delivers the plaintext code to OPS_SECURITY_EMAIL through the
 * configured SMTP provider. The code is never written to logs, URLs, API
 * responses or the frontend bundle. Verification is rate-limited and every
 * credential expires automatically; successful use issues a short ops session.
 */
import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { execute, isTursoConfigured, randomId, rowText, currentTimestamp } from './database.js';
import { hashToken, safeEqual } from './security.js';

export const OPS_WINDOW_MS = 60 * 60_000; // rotate every hour
export const OPS_SESSION_MS = 30 * 60_000; // ops sessions are short-lived
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous

export const opsUnlockLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

function generateOpsCode(): string {
  // 12 characters over a 32-symbol alphabet ≈ 60 bits of entropy.
  const bytes = crypto.randomBytes(12);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export function opsSecurityEmail(): string {
  return (process.env.OPS_SECURITY_EMAIL || '').trim();
}

/** Window boundary (epoch ms) for a given time — credentials rotate on the hour. */
export function opsWindowStart(now = Date.now()): number {
  return Math.floor(now / OPS_WINDOW_MS) * OPS_WINDOW_MS;
}

/**
 * Ensure a valid credential exists for the current hourly window. Generates and
 * queues email delivery exactly once per window. Returns delivery metadata only —
 * the plaintext code is never returned to callers.
 */
export async function ensureCurrentOpsCredential(now = Date.now()): Promise<{ generated: boolean; deliveredTo: string | null; active: boolean }> {
  if (!isTursoConfigured) return { generated: false, deliveredTo: null, active: false };
  const windowStart = opsWindowStart(now);
  const expiresAt = windowStart + OPS_WINDOW_MS;
  const existing = await execute('SELECT id,expires_at,delivery_status,delivered_to FROM ops_credentials WHERE expires_at>? ORDER BY created_at DESC LIMIT 1', [new Date(now).toISOString()]);
  if (existing.rows.length) {
    const row = existing.rows[0] as Record<string, unknown>;
    return { generated: false, deliveredTo: rowText(row, 'delivered_to') || null, active: true };
  }
  const code = generateOpsCode();
  const recipient = opsSecurityEmail();
  const id = randomId();
  await execute(
    "INSERT INTO ops_credentials(id,window_start,token_hash,expires_at,delivery_status,delivered_to,attempts,created_at) VALUES(?,?,?,?, 'PENDING',?,0,?)",
    [id, new Date(windowStart).toISOString(), hashToken(code), new Date(expiresAt).toISOString(), recipient || null, new Date(now).toISOString()],
  );
  if (recipient) {
    // Deliver via the notification outbox so failures retry; the body is the only
    // place the plaintext code ever appears, and outbox payloads are cleared after send.
    const tenant = await execute('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
    const tenantId = tenant.rows.length ? rowText(tenant.rows[0], 'id') : null;
    if (tenantId) {
      const payload = JSON.stringify({
        title: 'FloodGuard operations credential (valid 1 hour)',
        body: `Your operations access code is ${code}. It is valid until ${new Date(expiresAt).toISOString()}. Enter it only inside the authenticated /hackeradmin operations console. Never share it; it cannot be recovered after this email.`,
        url: '/hackeradmin',
      });
      try {
        const queued = await execute(
          `INSERT INTO outbox_events(id,dedupe_key,tenant_id,channel,recipient,payload_json,status,attempts,next_attempt_at,created_at)
           VALUES(?,?,?,?,?,?,'PENDING',0,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
          [randomId(), `ops-credential:${id}`, tenantId, 'EMAIL', recipient, payload, new Date(now).toISOString(), new Date(now).toISOString()],
        );
        if (queued.rowsAffected) await execute("UPDATE ops_credentials SET delivery_status='QUEUED' WHERE id=?", [id]);
      } catch { /* delivery will be retried on the next window */ }
    }
  }
  return { generated: true, deliveredTo: recipient || null, active: true };
}

/** Expire old credentials and revoked/expired ops sessions. */
export async function sweepExpiredOps(now = Date.now()): Promise<void> {
  if (!isTursoConfigured) return;
  const iso = new Date(now).toISOString();
  await execute('DELETE FROM ops_credentials WHERE expires_at<=?', [iso]);
  await execute('DELETE FROM ops_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL', [iso]);
}

export async function verifyOpsCode(code: string, now = Date.now()): Promise<{ ok: boolean; reason?: string; credentialId?: string }> {
  if (!isTursoConfigured) return { ok: false, reason: 'Operations access requires the Turso-backed deployment.' };
  const trimmed = (code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(trimmed)) return { ok: false, reason: 'The operations code is not valid.' };
  const iso = new Date(now).toISOString();
  const result = await execute('SELECT id,token_hash,expires_at FROM ops_credentials WHERE expires_at>? ORDER BY created_at DESC LIMIT 5', [iso]);
  const providedHash = hashToken(trimmed);
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    if (safeEqual(providedHash, rowText(row, 'token_hash'))) {
      await execute('UPDATE ops_credentials SET attempts=attempts+1 WHERE id=?', [rowText(row, 'id')]);
      return { ok: true, credentialId: rowText(row, 'id') };
    }
  }
  // Record the failed attempt on the newest active credential without revealing state.
  if (result.rows.length) {
    const newest = result.rows[0] as Record<string, unknown>;
    await execute('UPDATE ops_credentials SET attempts=attempts+1 WHERE id=?', [rowText(newest, 'id')]);
  }
  return { ok: false, reason: 'The operations code is invalid or expired. Use the code from the latest security email.' };
}

export async function createOpsSession(userId: string, ip: string | null, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + OPS_SESSION_MS;
  await execute('INSERT INTO ops_sessions(id,user_id,token_hash,expires_at,ip_address,created_at) VALUES(?,?,?,?,?,?)', [
    randomId(), userId, hashToken(token), new Date(expiresAt).toISOString(), ip, new Date(now).toISOString(),
  ]);
  return { token, expiresAt };
}

export async function findOpsSession(token: string | undefined, now = Date.now()): Promise<{ id: string; userId: string } | null> {
  if (!isTursoConfigured || !token || token.length < 32 || token.length > 128) return null;
  const result = await execute('SELECT id,user_id,expires_at,revoked_at FROM ops_sessions WHERE token_hash=? LIMIT 1', [hashToken(token)]);
  if (!result.rows.length) return null;
  const row = result.rows[0] as Record<string, unknown>;
  if (row.revoked_at || new Date(rowText(row, 'expires_at')).getTime() <= now) return null;
  return { id: rowText(row, 'id'), userId: rowText(row, 'user_id') };
}

export async function revokeOpsSession(token: string | undefined): Promise<void> {
  if (!isTursoConfigured || !token) return;
  await execute('UPDATE ops_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', [currentTimestamp(), hashToken(token)]);
}

export function readOpsCookie(req: Request, res: Response): string | undefined {
  void res;
  for (const chunk of (req.headers.cookie || '').split(';')) {
    const [rawName, ...parts] = chunk.trim().split('=');
    if (rawName === 'fg_ops') {
      try { return decodeURIComponent(parts.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}

export function setOpsCookie(req: Request, res: Response, token: string, expiresAt: number) {
  const age = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === 'production' || req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `fg_ops=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`);
}

export function clearOpsCookie(res: Response) {
  res.append('Set-Cookie', 'fg_ops=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

/** Middleware: requires a valid, unexpired ops session bound to the signed-in user. */
export const requireOps: RequestHandler = async (req, res, next) => {
  try {
    const user = res.locals.authUser as { id: string; role: string } | undefined;
    if (!user) { res.status(401).json({ error: 'Sign in before using operations controls.' }); return; }
    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      res.status(403).json({ error: 'Operations controls require an administrator account.' });
      return;
    }
    const session = await findOpsSession(readOpsCookie(req, res));
    if (!session || session.userId !== user.id) {
      res.status(403).json({ error: 'A current operations credential is required. Request the hourly code from the security mailbox.', code: 'OPS_CODE_REQUIRED' });
      return;
    }
    res.locals.opsSession = session;
    next();
  } catch (error) { next(error); }
};
