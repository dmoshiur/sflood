import 'dotenv/config';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { isPostgresConfigured, prisma } from './database.js';
import { readStore, writeStore } from './data.js';

const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:project-owner@example.invalid';
const retryDelayMs = [30_000, 120_000, 600_000, 1_800_000];

if (publicKey && privateKey) webpush.setVapidDetails(vapidSubject, publicKey, privateKey);

function hasSafePublicAppUrl() {
  try {
    const url = new URL(process.env.PUBLIC_APP_URL || '');
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function notificationConfig() {
  return {
    webPushAvailable: Boolean(publicKey && privateKey),
    vapidPublicKey: publicKey || null,
    emailAvailable: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM && hasSafePublicAppUrl()),
    smsAvailable: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
    mode: isPostgresConfigured ? 'postgres' : 'simulation',
  };
}

function eligibleForDelivery(channel: string) {
  if (channel === 'WEB_PUSH') return Boolean(publicKey && privateKey);
  if (channel === 'EMAIL') return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM && hasSafePublicAppUrl());
  if (channel === 'SMS') return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  return false;
}

function payloadCopy(payload: unknown) {
  if (payload && typeof payload === 'object') return payload as { title?: string; body?: string; url?: string; [key: string]: unknown };
  return { title: 'FloodGuard update', body: 'Open FloodGuard to review the latest update.', url: '/app' };
}

async function deliverEmail(recipient: string, payload: ReturnType<typeof payloadCopy>) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [recipient],
      subject: payload.title || 'FloodGuard demo update',
      text: `${payload.body || 'Open FloodGuard to review the latest update.'}\n\nEducational prototype only. Not an emergency service.`,
    }),
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
}

async function deliverSms(recipient: string, payload: ReturnType<typeof payloadCopy>) {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
  const body = new URLSearchParams({ From: process.env.TWILIO_FROM!, To: recipient, Body: `${payload.title || 'FloodGuard update'}: ${payload.body || ''} Demo only.` });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new Error(`SMS provider returned HTTP ${response.status}.`);
}

async function deliverPostgres(event: {
  id: string; channel: string; recipient: string; payload: unknown; attempts: number;
}) {
  if (!prisma) return;
  const payload = payloadCopy(event.payload);
  if (event.channel === 'WEB_PUSH') {
    const subscription = await prisma.subscription.findUnique({ where: { id: event.recipient } });
    if (!subscription?.pushEndpoint || !subscription.pushP256dh || !subscription.pushAuth || subscription.unsubscribedAt) {
      throw new Error('Verified push subscription is no longer active.');
    }
    try {
      await webpush.sendNotification({ endpoint: subscription.pushEndpoint, keys: { p256dh: subscription.pushP256dh, auth: subscription.pushAuth } }, JSON.stringify(payload), { TTL: 60 });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await prisma.subscription.update({ where: { id: subscription.id }, data: { unsubscribedAt: new Date() } });
        return;
      }
      throw error;
    }
    return;
  }
  if (event.channel === 'EMAIL') return deliverEmail(event.recipient, payload);
  if (event.channel === 'SMS') return deliverSms(event.recipient, payload);
  throw new Error(`Unsupported notification channel: ${event.channel}`);
}

async function processPostgresOutbox() {
  if (!prisma) return;
  const now = new Date();
  const candidates = await prisma.outboxEvent.findMany({
    where: { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' }, take: 10,
  });
  for (const candidate of candidates) {
    if (!eligibleForDelivery(candidate.channel)) continue;
    const claim = await prisma.outboxEvent.updateMany({
      where: { id: candidate.id, status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: new Date() } },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    const claimed = await prisma.outboxEvent.findUnique({ where: { id: candidate.id } });
    if (!claimed) continue;
    try {
      await deliverPostgres(claimed);
      await prisma.outboxEvent.update({ where: { id: claimed.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
    } catch (error) {
      const attempts = claimed.attempts;
      const exhausted = attempts >= 5;
      const delay = retryDelayMs[Math.min(attempts - 1, retryDelayMs.length - 1)];
      await prisma.outboxEvent.update({ where: { id: claimed.id }, data: {
        status: exhausted ? 'DEAD_LETTER' : 'RETRYING',
        lastError: String(error).slice(0, 500),
        nextAttemptAt: exhausted ? new Date() : new Date(Date.now() + delay),
      } });
      console.warn(`[FloodGuard outbox] ${claimed.id} ${exhausted ? 'dead-lettered' : `retry in ${Math.round(delay / 1000)}s`}:`, error);
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
    if (!entry.channel || !eligibleForDelivery(entry.channel)) continue;
    if (entry.nextAttemptAt && new Date(entry.nextAttemptAt).getTime() > now) continue;
    entry.status = 'PROCESSING';
    entry.attempts = (entry.attempts || 0) + 1;
    changed = true;
    const sub = entry.channel === 'WEB_PUSH' ? store.pushSubscriptions.find((subscription) => subscription.endpoint === entry.recipient) : null;
    try {
      if (entry.channel === 'WEB_PUSH') {
        if (!sub) throw new Error('Push subscription is no longer active.');
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payloadCopy(entry.payload)), { TTL: 60 });
      } else if (entry.channel === 'EMAIL') {
        await deliverEmail(entry.recipient || '', payloadCopy(entry.payload));
      } else if (entry.channel === 'SMS') {
        await deliverSms(entry.recipient || '', payloadCopy(entry.payload));
      }
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
        entry.nextAttemptAt = new Date(now + retryDelayMs[Math.min(attempts - 1, retryDelayMs.length - 1)]).toISOString();
      }
    }
  }
  if (changed) writeStore(store);
}

let workerTimer: NodeJS.Timeout | undefined;
let isWorking = false;
export function startNotificationWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    if (isWorking) return;
    isWorking = true;
    try {
      if (isPostgresConfigured) await processPostgresOutbox();
      else await processLocalOutbox();
    } catch (error) { console.error('[FloodGuard outbox]', error); }
    finally { isWorking = false; }
  }, 5_000);
  workerTimer.unref();
}

export const retryScheduleSeconds = [30, 120, 600, 1800, 'dead-letter after attempt 5'] as const;

export function endpointFingerprint(endpoint: string) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}
