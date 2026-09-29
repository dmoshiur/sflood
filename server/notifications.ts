import 'dotenv/config';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { config } from './config.js';
import {
  execute, getFeatureFlag, isMaintenanceMode, primaryTenantId, queryAll, queryOne, randomId,
  setSiteSetting, currentTimestamp, rowText, rowBoolean,
} from './database.js';
import { getSavedProvider, recordProviderTest, sendEmail, sendSms } from './providers.js';
import { hashToken } from './security.js';
import type { FloodStateName } from '../shared/flood-engine.js';

/**
 * Notification pipeline.
 *
 * Channels: EMAIL (SMTP), SMS (HTTP gateway), WEB_PUSH (VAPID/FCM), IN_APP.
 * Every send goes through the `notification_deliveries` queue so telemetry
 * ingestion is never blocked by a slow provider. Delivery status, provider
 * message id, failure reason and retry count are all persisted.
 */

export type NotificationChannel = 'EMAIL' | 'SMS' | 'WEB_PUSH' | 'IN_APP';
export type NotificationSeverity = 'INFO' | 'WATCH' | 'WARNING' | 'CRITICAL' | 'RECOVERY' | 'SYSTEM';

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

if (config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
}

export const webPushReady = Boolean(config.vapidPublicKey && config.vapidPrivateKey);

export interface NotificationPayload {
  title: string;
  body: string;
  url?: string;
  severity?: NotificationSeverity;
  levelCm?: number | null;
  state?: FloodStateName | null;
  simulated?: boolean;
  unsubscribeUrl?: string;
}

export function hasCanonicalPublicUrl(): boolean {
  const value = config.publicAppUrl;
  if (!value) return false;
  try {
    const url = new URL(value);
    const secure = url.protocol === 'https:' || (!config.isProduction && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    return secure && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}

export function publicUrl(pathname: string, params: Record<string, string> = {}): string | null {
  if (!hasCanonicalPublicUrl()) return null;
  const url = new URL(pathname, config.publicAppUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export async function notificationConfig() {
  const [smtp, sms, flags, maintenance] = await Promise.all([
    getSavedProvider('SMTP'), getSavedProvider('SMS_HTTP'), allFlags(), isMaintenanceMode(),
  ]);
  const smsEnabled = Boolean(sms?.enabled) && (await getFeatureFlag('sms_channel_enabled', false));
  return {
    mode: config.isLocalDatabase ? 'local-database' : 'turso',
    maintenanceMode: maintenance,
    webPushAvailable: webPushReady,
    vapidPublicKey: config.vapidPublicKey || null,
    emailAvailable: Boolean(smtp?.enabled) && hasCanonicalPublicUrl(),
    smsAvailable: smsEnabled && hasCanonicalPublicUrl(),
    cloudinary: config.publicConfig().cloudinary,
    firmware: config.publicConfig().firmware,
    flags,
  };
}

async function allFlags() {
  const rows = await queryAll('SELECT key,value_json FROM feature_flags');
  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    try { flags[rowText(row, 'key')] = Boolean(JSON.parse(rowText(row, 'value_json', 'false'))); } catch { /* skip */ }
  }
  return flags;
}

export async function emailChannelAvailable(): Promise<boolean> {
  const smtp = await getSavedProvider('SMTP');
  return Boolean(smtp?.enabled);
}

export async function smsChannelAvailable(): Promise<boolean> {
  const sms = await getSavedProvider('SMS_HTTP');
  return Boolean(sms?.enabled) && (await getFeatureFlag('sms_channel_enabled', false));
}

export async function pushChannelAvailable(): Promise<boolean> {
  return webPushReady;
}

/** Queue a single delivery. Duplicate (channel, recipient, event) rows are ignored. */
export async function queueDelivery(input: {
  tenantId: string; zoneId?: string | null; eventId?: string | null; channel: NotificationChannel;
  recipient: string; payload: NotificationPayload; priority?: number;
}): Promise<boolean> {
  if (!input.recipient) return false;
  const result = await execute(
    `INSERT OR IGNORE INTO notification_deliveries(id,tenant_id,zone_id,event_id,channel,recipient,payload_json,status,priority,attempts,retry_count,next_attempt_at,created_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',?,0,0,?,?)`,
    [
      randomId(), input.tenantId, input.zoneId ?? null, input.eventId ?? null, input.channel, input.recipient,
      JSON.stringify(input.payload), input.priority ?? 5, currentTimestamp(), currentTimestamp(),
    ],
  );
  return result.rowsAffected > 0;
}

export async function createInAppNotification(input: {
  tenantId: string; userId: string | null; zoneId?: string | null; severity: NotificationSeverity;
  title: string; body: string; url?: string;
}): Promise<string> {
  const id = randomId();
  await execute(
    'INSERT INTO notifications(id,tenant_id,user_id,zone_id,channel,severity,title,body,url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, input.tenantId, input.userId, input.zoneId ?? null, 'IN_APP', input.severity, input.title, input.body, input.url || '/app', currentTimestamp()],
  );
  return id;
}

export interface FloodFanOutInput {
  tenantId: string;
  zoneId: string | null;
  eventId: string;
  state: FloodStateName;
  previousState: FloodStateName;
  levelCm: number | null;
  deviceId: string | null;
  deviceName: string;
  zoneName: string;
  reason: string;
  simulated: boolean;
  channels: NotificationChannel[];
  notifyRecovery: boolean;
}

const SEVERITY_FOR_STATE: Record<string, NotificationSeverity> = {
  NORMAL: 'INFO', WATCH: 'WATCH', WARNING: 'WARNING', CRITICAL: 'CRITICAL', RECOVERY: 'RECOVERY',
};

/**
 * Fan a flood event out to every eligible recipient.
 *
 * Audience:
 *  - registered users scoped to the event zone (or the whole city) who enabled
 *    the channel in their notification preferences
 *  - platform admins, who always receive in-app notifications for their scope
 *  - verified public email subscribers for the zone
 *  - active browser push subscriptions for the zone
 *
 * Nothing here sends a message synchronously: rows are queued and the worker
 * delivers them with retries.
 */
export async function fanOutFloodEvent(input: FloodFanOutInput): Promise<{ queued: number; inApp: number }> {
  const severity = SEVERITY_FOR_STATE[input.state] || 'WARNING';
  const isRecovery = input.state === 'RECOVERY';
  if (isRecovery && !input.notifyRecovery) return { queued: 0, inApp: 0 };

  const title = input.state === 'NORMAL'
    ? `${input.zoneName}: level returned to normal`
    : isRecovery
      ? `${input.zoneName}: recovery in progress`
      : `${input.zoneName}: ${input.state.toLowerCase()} water level`;
  const body = `${input.simulated ? 'SIMULATION: ' : ''}Water level ${input.levelCm === null ? 'unknown' : `${input.levelCm.toFixed(1)} cm`} at ${input.deviceName}. ${input.reason}`;
  const payload: NotificationPayload = {
    title, body, url: '/app/alerts', severity, levelCm: input.levelCm, state: input.state, simulated: input.simulated,
  };

  const audience = await queryAll(
    `SELECT u.id, u.zone_id, u.city_id, u.role, u.email, u.phone, u.email_verified_at, u.phone_verified_at, u.disabled_at,
            COALESCE(p.email_enabled,1) AS email_enabled, COALESCE(p.sms_enabled,0) AS sms_enabled,
            COALESCE(p.push_enabled,1) AS push_enabled, COALESCE(p.in_app_enabled,1) AS in_app_enabled,
            COALESCE(p.min_severity,'WATCH') AS min_severity, COALESCE(p.recovery_enabled,1) AS recovery_enabled
     FROM users u
     LEFT JOIN notification_preferences p ON p.user_id = u.id
     WHERE u.disabled_at IS NULL`,
  );

  const zone = input.zoneId ? await queryOne('SELECT id, city_id FROM zones WHERE id=?', [input.zoneId]) : null;
  const cityId = zone ? rowText(zone, 'city_id') : null;
  const severityRank: Record<string, number> = { INFO: 0, WATCH: 1, WARNING: 2, CRITICAL: 3, RECOVERY: 1, SYSTEM: 2 };
  let queued = 0;
  let inApp = 0;

  for (const row of audience) {
    const role = rowText(row, 'role');
    const userZone = rowText(row, 'zone_id');
    const userCity = rowText(row, 'city_id');
    const inScope = Boolean(input.zoneId) && (userZone === input.zoneId || (userCity && userCity === cityId) || !userZone);
    const isAdmin = role === 'ADMIN' || role === 'OWNER' || role === 'OPERATOR';
    if (!inScope && !isAdmin) continue;
    const minSeverity = rowText(row, 'min_severity', 'WATCH');
    const meetsSeverity = (severityRank[severity] ?? 1) >= (severityRank[minSeverity] ?? 1);
    const userId = rowText(row, 'id');

    if (rowBoolean(row, 'in_app_enabled')) {
      await createInAppNotification({
        tenantId: input.tenantId, userId, zoneId: input.zoneId, severity,
        title, body, url: '/app/alerts',
      });
      inApp += 1;
    }
    if (!meetsSeverity) continue;
    if (isRecovery && !rowBoolean(row, 'recovery_enabled')) continue;
    if (input.channels.includes('EMAIL') && rowBoolean(row, 'email_enabled') && rowText(row, 'email') && rowText(row, 'email_verified_at')) {
      if (await queueDelivery({ tenantId: input.tenantId, zoneId: input.zoneId, eventId: input.eventId, channel: 'EMAIL', recipient: rowText(row, 'email'), payload, priority: severity === 'CRITICAL' ? 1 : 3 })) queued += 1;
    }
    if (input.channels.includes('SMS') && rowBoolean(row, 'sms_enabled') && rowText(row, 'phone') && rowText(row, 'phone_verified_at')) {
      if (await queueDelivery({ tenantId: input.tenantId, zoneId: input.zoneId, eventId: input.eventId, channel: 'SMS', recipient: rowText(row, 'phone'), payload, priority: 2 })) queued += 1;
    }
  }

  if (input.channels.includes('EMAIL') && input.zoneId) {
    const subscribers = await queryAll(
      'SELECT id,email FROM email_subscribers WHERE zone_id=? AND verified_at IS NOT NULL AND unsubscribed_at IS NULL',
      [input.zoneId],
    );
    for (const subscriber of subscribers) {
      const token = crypto.randomBytes(32).toString('base64url');
      const unsubscribe = publicUrl('/api/public/unsubscribe', { token });
      const unsubscribeHash = hashToken(token);
      await execute('UPDATE email_subscribers SET unsubscribe_token_hash=? WHERE id=?', [unsubscribeHash, rowText(subscriber, 'id')]);
      if (await queueDelivery({
        tenantId: input.tenantId, zoneId: input.zoneId, eventId: input.eventId, channel: 'EMAIL',
        recipient: rowText(subscriber, 'email'), payload: unsubscribe ? { ...payload, unsubscribeUrl: unsubscribe } : payload, priority: 2,
      })) queued += 1;
    }
  }

  if (input.channels.includes('WEB_PUSH') && input.zoneId) {
    const subscriptions = await queryAll(
      'SELECT id FROM push_subscriptions WHERE zone_id=? AND unsubscribed_at IS NULL',
      [input.zoneId],
    );
    for (const subscription of subscriptions) {
      if (await queueDelivery({ tenantId: input.tenantId, zoneId: input.zoneId, eventId: input.eventId, channel: 'WEB_PUSH', recipient: rowText(subscription, 'id'), payload, priority: 1 })) queued += 1;
    }
  }

  return { queued, inApp };
}

async function deliverEmail(recipient: string, payload: NotificationPayload): Promise<string | null> {
  const result = await sendEmail(recipient, payload);
  return result || null;
}

async function deliverSms(recipient: string, payload: NotificationPayload): Promise<string | null> {
  await sendSms(recipient, payload);
  return null;
}

async function deliverWebPush(subscriptionId: string, payload: NotificationPayload): Promise<string | null> {
  const subscription = await queryOne('SELECT endpoint,p256dh,auth,unsubscribed_at FROM push_subscriptions WHERE id=?', [subscriptionId]);
  if (!subscription) throw new Error('Push subscription no longer exists.');
  if (rowText(subscription, 'unsubscribed_at')) throw new Error('Push subscription is no longer active.');
  const response = await webpush.sendNotification(
    { endpoint: rowText(subscription, 'endpoint'), keys: { p256dh: rowText(subscription, 'p256dh'), auth: rowText(subscription, 'auth') } },
    JSON.stringify(payload),
    { TTL: 60 },
  ) as { headers?: Record<string, string> };
  const location = response?.headers?.location || response?.headers?.Location;
  await execute('UPDATE push_subscriptions SET last_used_at=?,failure_count=0 WHERE id=?', [currentTimestamp(), subscriptionId]);
  return location ? String(location).slice(0, 500) : null;
}

async function deliverInApp(recipient: string, payload: NotificationPayload, tenantId: string): Promise<string | null> {
  const id = randomId();
  await execute(
    'INSERT INTO notifications(id,tenant_id,user_id,zone_id,channel,severity,title,body,url,created_at) VALUES (?,?,?,NULL,?,?,?,?,?,?)',
    [id, tenantId, recipient, 'IN_APP', payload.severity || 'INFO', payload.title, payload.body, payload.url || '/app', currentTimestamp()],
  );
  return id;
}

export interface DeliveryProcessResult { processed: number; sent: number; retried: number; deadLettered: number; skipped: number }

/** Process one batch of queued deliveries. Exported for tests and the worker. */
export async function processDeliveryQueue(limit = BATCH_SIZE): Promise<DeliveryProcessResult> {
  const result: DeliveryProcessResult = { processed: 0, sent: 0, retried: 0, deadLettered: 0, skipped: 0 };
  const now = currentTimestamp();
  await execute("UPDATE notification_deliveries SET status='RETRYING' WHERE status='PROCESSING' AND lease_until<=?", [now]);
  const rows = await queryAll(
    `SELECT * FROM notification_deliveries WHERE status IN ('PENDING','RETRYING') AND next_attempt_at<=?
     ORDER BY priority ASC, created_at ASC LIMIT ?`,
    [now, limit],
  );

  for (const row of rows) {
    const id = rowText(row, 'id');
    const channel = rowText(row, 'channel') as NotificationChannel;
    result.processed += 1;

    let available = false;
    try {
      if (channel === 'EMAIL') available = await emailChannelAvailable();
      else if (channel === 'SMS') available = await smsChannelAvailable();
      else if (channel === 'WEB_PUSH') available = await pushChannelAvailable();
      else if (channel === 'IN_APP') available = true;
    } catch { available = false; }
    if (!available) {
      await execute("UPDATE notification_deliveries SET status='SKIPPED',failure_reason=? WHERE id=? AND status IN ('PENDING','RETRYING')", [`${channel} channel is not configured`, id]);
      result.skipped += 1;
      continue;
    }

    const leaseUntil = new Date(Date.now() + 120_000).toISOString();
    const claim = await execute(
      "UPDATE notification_deliveries SET status='PROCESSING',attempts=attempts+1,lease_until=? WHERE id=? AND status IN ('PENDING','RETRYING') AND next_attempt_at<=?",
      [leaseUntil, id, now],
    );
    if (claim.rowsAffected !== 1) continue;

    let payload: NotificationPayload;
    try { payload = JSON.parse(rowText(row, 'payload_json', '{}')); } catch { payload = { title: 'FloodGrid update', body: 'Open FloodGrid to review the latest update.' }; }

    try {
      let providerMessageId: string | null = null;
      if (channel === 'EMAIL') providerMessageId = await deliverEmail(rowText(row, 'recipient'), payload);
      else if (channel === 'SMS') providerMessageId = await deliverSms(rowText(row, 'recipient'), payload);
      else if (channel === 'WEB_PUSH') providerMessageId = await deliverWebPush(rowText(row, 'recipient'), payload);
      else providerMessageId = await deliverInApp(rowText(row, 'recipient'), payload, rowText(row, 'tenant_id'));
      await execute(
        "UPDATE notification_deliveries SET status='SENT',sent_at=?,provider_message_id=COALESCE(?,provider_message_id),failure_reason=NULL,payload_json='{}' WHERE id=?",
        [currentTimestamp(), providerMessageId, id],
      );
      result.sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const message = String((error as Error)?.message || error).slice(0, 500);
      if (channel === 'WEB_PUSH' && (statusCode === 404 || statusCode === 410)) {
        await execute('UPDATE push_subscriptions SET unsubscribed_at=? WHERE id=?', [currentTimestamp(), rowText(row, 'recipient')]);
        await execute("UPDATE notification_deliveries SET status='SENT',sent_at=?,failure_reason='Push endpoint expired and was removed',payload_json='{}' WHERE id=?", [currentTimestamp(), id]);
        result.sent += 1;
        continue;
      }
      const attempts = Number(row.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await execute(
          "UPDATE notification_deliveries SET status='DEAD_LETTER',retry_count=?,failure_reason=?,next_attempt_at=?,payload_json='{}' WHERE id=?",
          [attempts - 1, message, new Date(Date.now() + 3_600_000).toISOString(), id],
        );
        result.deadLettered += 1;
      } else {
        const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
        await execute(
          "UPDATE notification_deliveries SET status='RETRYING',retry_count=?,failure_reason=?,next_attempt_at=? WHERE id=?",
          [attempts - 1, message, new Date(Date.now() + delay).toISOString(), id],
        );
        result.retried += 1;
      }
      console.warn(`[floodgrid] delivery ${id} (${channel}) attempt ${attempts} failed: ${message}`);
    }
  }
  return result;
}

let workerTimer: NodeJS.Timeout | null = null;
export function startNotificationWorker(intervalMs = 10_000): void {
  if (workerTimer) return;
  const tick = async () => {
    try { await processDeliveryQueue(); } catch (error) { console.warn('[floodgrid] notification worker tick failed', error); }
  };
  void tick();
  workerTimer = setInterval(() => void tick(), intervalMs);
  workerTimer.unref?.();
}

export function stopNotificationWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

/** Provider test helper used by the admin console. */
export async function testEmailProvider(recipient: string): Promise<void> {
  const { verifySmtpProvider } = await import('./providers.js');
  await verifySmtpProvider(recipient);
  await recordProviderTest('SMTP', true, 'Test message accepted by the SMTP server.');
}

export async function testSmsProvider(recipient: string): Promise<void> {
  const { verifySmsProvider } = await import('./providers.js');
  await verifySmsProvider(recipient);
  await recordProviderTest('SMS_HTTP', true, 'Test message accepted by the SMS gateway.');
}

export async function setMaintenanceMode(enabled: boolean, reason: string, actorId: string | null): Promise<void> {
  await setSiteSetting('maintenance_mode', enabled, actorId);
  if (enabled) {
    await execute('INSERT INTO maintenance_events(id,tenant_id,mode,reason,started_by,started_at) VALUES (?,?,?,?,?,?)', [
      randomId(), await primaryTenantId(), 'MAINTENANCE', reason.slice(0, 500), actorId, currentTimestamp(),
    ]);
  } else {
    await execute('UPDATE maintenance_events SET ended_at=? WHERE ended_at IS NULL', [currentTimestamp()]);
  }
}
