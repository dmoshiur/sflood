import 'dotenv/config';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { execute, isTursoConfigured, requireTurso } from './database.js';
import { readStore, writeStore } from './data.js';
import { getSavedProvider, sendEmail, sendSms } from './providers.js';

const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:project-owner@example.invalid';
const retryDelayMs = [30_000, 120_000, 600_000, 1_800_000];
if (publicKey && privateKey) webpush.setVapidDetails(vapidSubject, publicKey, privateKey);

export function hasCanonicalPublicUrl() {
  const value = process.env.PUBLIC_APP_URL;
  if (!value) return false;
  try {
    const url = new URL(value);
    const secure = url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    return secure && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}

export async function notificationConfig() {
  const [smtp, sms] = isTursoConfigured ? await Promise.all([getSavedProvider('SMTP'), getSavedProvider('SMS_HTTP')]) : [null, null];
  const secretReady = Buffer.byteLength(process.env.SESSION_SECRET || '') >= 32;
  const publicUrlReady = hasCanonicalPublicUrl();
  return {
    webPushAvailable: Boolean(publicKey && privateKey),
    vapidPublicKey: publicKey || null,
    emailAvailable: Boolean(smtp?.enabled && publicUrlReady),
    smsAvailable: Boolean(sms?.enabled && publicUrlReady && secretReady),
    mode: isTursoConfigured ? 'turso' : 'simulation',
  };
}

function payloadCopy(payload: unknown) {
  if (payload && typeof payload === 'object') return payload as { title?: string; body?: string; url?: string; [key: string]: unknown };
  return { title: 'FloodGuard update', body: 'Open FloodGuard to review the latest update.', url: '/app' };
}

async function emailConfigured() {
  const config = await getSavedProvider('SMTP');
  return Boolean(config?.enabled && config.config);
}
async function smsConfigured() {
  const config = await getSavedProvider('SMS_HTTP');
  return Boolean(config?.enabled && config.config);
}

async function deliverTurso(event: { channel: string; recipient: string; payload: unknown }) {
  const payload = payloadCopy(event.payload);
  if (event.channel === 'EMAIL') return sendEmail(event.recipient, payload);
  if (event.channel === 'SMS') return sendSms(event.recipient, payload);
  if (event.channel === 'WEB_PUSH') {
    const result = await execute('SELECT push_endpoint,push_p256dh,push_auth,unsubscribed_at FROM subscriptions WHERE id=? LIMIT 1', [event.recipient]);
    if (!result.rows.length) throw new Error('Push subscription no longer exists.');
    const row = result.rows[0] as Record<string, unknown>;
    if (!row.push_endpoint || !row.push_p256dh || !row.push_auth || row.unsubscribed_at) throw new Error('Push subscription is no longer active.');
    await webpush.sendNotification({ endpoint: String(row.push_endpoint), keys: { p256dh: String(row.push_p256dh), auth: String(row.push_auth) } }, JSON.stringify(payload), { TTL: 60 });
    return;
  }
  throw new Error(`Unsupported notification channel: ${event.channel}`);
}

async function available(channel: string) {
  if (!isTursoConfigured) return channel === 'WEB_PUSH' && Boolean(publicKey && privateKey);
  if (channel === 'WEB_PUSH') return Boolean(publicKey && privateKey);
  if (channel === 'EMAIL') return emailConfigured();
  if (channel === 'SMS') return smsConfigured();
  return false;
}

export async function hasCurrentConsent(channel: string, recipient: string, zoneId: string | null, dedupeKey: string) {
  if (!isTursoConfigured) return false;
  const keyParts = dedupeKey.split(':');
  if (channel === 'WEB_PUSH') {
    const subscriptionId = recipient;
    const result = await execute('SELECT id FROM subscriptions WHERE id=? AND push_endpoint IS NOT NULL AND unsubscribed_at IS NULL LIMIT 1', [subscriptionId]);
    return result.rows.length > 0;
  }
  if (!zoneId) return false;
  if (channel === 'EMAIL' && keyParts[0] === 'email-opt-in') {
    const [, subscriptionId, verificationHash] = keyParts;
    if (!subscriptionId || !verificationHash) return false;
    const result = await execute('SELECT id FROM subscriptions WHERE id=? AND zone_id=? AND email=? AND verification_token_hash=? AND verification_expires_at>? AND unsubscribed_at IS NULL LIMIT 1', [subscriptionId, zoneId, recipient, verificationHash, new Date().toISOString()]);
    return result.rows.length > 0;
  }
  const subscriptionId = keyParts.at(-1) || '';
  if (!subscriptionId) return false;
  if (channel === 'SMS') {
    const result = await execute('SELECT id FROM subscriptions WHERE id=? AND zone_id=? AND phone=? AND phone_verified_at IS NOT NULL AND unsubscribed_at IS NULL LIMIT 1', [subscriptionId, zoneId, recipient]);
    return result.rows.length > 0;
  }
  if (channel === 'EMAIL') {
    const result = await execute('SELECT id FROM subscriptions WHERE id=? AND zone_id=? AND email=? AND verified_at IS NOT NULL AND unsubscribed_at IS NULL LIMIT 1', [subscriptionId, zoneId, recipient]);
    return result.rows.length > 0;
  }
  return false;
}

async function processTursoOutbox() {
  requireTurso();
  const now = new Date().toISOString();
  await execute("UPDATE outbox_events SET status='RETRYING',next_attempt_at=? WHERE status='PROCESSING' AND next_attempt_at<=?", [now, now]);
  const result = await execute("SELECT * FROM outbox_events WHERE status IN ('PENDING','RETRYING') AND next_attempt_at<=? ORDER BY created_at ASC LIMIT 10", [now]);
  for (const raw of result.rows) {
    const item = raw as Record<string, unknown>;
    const id = String(item.id);
    const channel = String(item.channel);
    if (!(await available(channel))) continue;
    const recipient = String(item.recipient);
    const zoneId = item.zone_id === null || item.zone_id === undefined ? null : String(item.zone_id);
    const dedupeKey = String(item.dedupe_key || '');
    if (!(await hasCurrentConsent(channel, recipient, zoneId, dedupeKey))) {
      await execute("UPDATE outbox_events SET status='DEAD_LETTER',last_error='Recipient is no longer opted in or verified',payload_json='{}' WHERE id=? AND status IN ('PENDING','RETRYING')", [id]);
      continue;
    }
    const claimTime = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
    const claim = await execute("UPDATE outbox_events SET status='PROCESSING',attempts=attempts+1,next_attempt_at=? WHERE id=? AND status IN ('PENDING','RETRYING') AND next_attempt_at<=?", [leaseExpiresAt, id, claimTime]);
    if (claim.rowsAffected !== 1) continue;
    const claimedResult = await execute('SELECT * FROM outbox_events WHERE id=?', [id]);
    if (!claimedResult.rows.length) continue;
    const claimed = claimedResult.rows[0] as Record<string, unknown>;
    try {
      let payload: unknown = {};
      try { payload = JSON.parse(String(claimed.payload_json || '{}')); } catch { /* use safe default */ }
      await deliverTurso({ channel: String(claimed.channel), recipient: String(claimed.recipient), payload });
      await execute("UPDATE outbox_events SET status='SENT',sent_at=?,last_error=NULL,payload_json='{}' WHERE id=? AND status='PROCESSING'", [new Date().toISOString(), id]);
    } catch (error) {
      const attempts = Number(claimed.attempts || 1);
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (channel === 'WEB_PUSH' && (statusCode === 404 || statusCode === 410)) {
        await execute('UPDATE subscriptions SET unsubscribed_at=? WHERE id=?', [new Date().toISOString(), String(claimed.recipient)]);
        await execute("UPDATE outbox_events SET status='SENT',last_error='Push endpoint expired',payload_json='{}' WHERE id=?", [id]);
        continue;
      }
      const exhausted = attempts >= 5;
      const delay = retryDelayMs[Math.min(attempts - 1, retryDelayMs.length - 1)]!;
      if (exhausted) {
        await execute("UPDATE outbox_events SET status='DEAD_LETTER',last_error=?,next_attempt_at=?,payload_json='{}' WHERE id=?", [String(error).slice(0, 500), new Date(Date.now() + delay).toISOString(), id]);
      } else {
        await execute("UPDATE outbox_events SET status='RETRYING',last_error=?,next_attempt_at=? WHERE id=?", [String(error).slice(0, 500), new Date(Date.now() + delay).toISOString(), id]);
      }
      console.warn(`[FloodGuard outbox] ${id} ${exhausted ? 'dead-lettered' : `retry in ${Math.round(delay / 1000)}s`}:`, error);
    }
  }
}

async function processLocalOutbox() {
  const store = readStore();
  const now = Date.now();
  let changed = false;
  for (const item of store.outbox) {
    const entry = item as { id?: string; dedupeKey?: string; channel?: string; recipient?: string; payload?: unknown; status?: string; attempts?: number; nextAttemptAt?: string; lastError?: string };
    if (entry.status !== 'PENDING' && entry.status !== 'RETRYING') continue;
    if (!entry.channel || !(await available(entry.channel))) continue;
    if (entry.nextAttemptAt && new Date(entry.nextAttemptAt).getTime() > now) continue;
    entry.status = 'PROCESSING'; entry.attempts = (entry.attempts || 0) + 1; changed = true;
    const sub = entry.channel === 'WEB_PUSH' ? store.pushSubscriptions.find((subscription) => subscription.endpoint === entry.recipient) : null;
    try {
      if (entry.channel === 'WEB_PUSH') {
        if (!sub) throw new Error('Push subscription is no longer active.');
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payloadCopy(entry.payload)), { TTL: 60 });
      } else throw new Error('SMTP and SMS providers can only be configured in protected Turso-backed Hackeradmin.');
      entry.status = 'SENT';
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        store.pushSubscriptions = store.pushSubscriptions.filter((subscription) => subscription.endpoint !== entry.recipient);
        entry.status = 'SENT';
      } else {
        const attempts = entry.attempts || 1;
        entry.lastError = String(error).slice(0, 500);
        entry.status = attempts >= 5 ? 'DEAD_LETTER' : 'RETRYING';
        entry.nextAttemptAt = new Date(now + retryDelayMs[Math.min(attempts - 1, retryDelayMs.length - 1)]!).toISOString();
      }
    }
  }
  if (changed) writeStore(store);
}

let workerTimer: NodeJS.Timeout | undefined;
let isWorking = false;
let lastOpsSweep = 0;
export function startNotificationWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    if (isWorking) return;
    isWorking = true;
    try {
      if (isTursoConfigured) await processTursoOutbox(); else await processLocalOutbox();
      // Rotate the hourly operations credential and expire stale commands/sessions.
      if (isTursoConfigured && Date.now() - lastOpsSweep > 30_000) {
        lastOpsSweep = Date.now();
        const { ensureCurrentOpsCredential, sweepExpiredOps } = await import('./ops.js');
        const { sweepExpiredCommands } = await import('./commands.js');
        await ensureCurrentOpsCredential();
        await sweepExpiredOps();
        await sweepExpiredCommands();
      }
    }
    catch (error) { console.error('[FloodGuard outbox]', error); }
    finally { isWorking = false; }
  }, 5_000);
  workerTimer.unref();
}

export const retryScheduleSeconds = [30, 120, 600, 1800, 'dead-letter after attempt 5'] as const;
export function endpointFingerprint(endpoint: string) { return crypto.createHash('sha256').update(endpoint).digest('hex'); }
