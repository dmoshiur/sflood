import net from 'node:net';
import nodemailer, { type Transporter } from 'nodemailer';
import ipaddr from 'ipaddr.js';
import { execute, turso } from './database.js';
import { decryptSecret, encryptSecret } from './security.js';

type SmtpConfig = { host: string; port: number; secure: boolean; username: string; password: string; fromName: string; fromAddress: string; replyTo?: string };
type SmsConfig = { endpoint: string; authHeader: string; authPrefix: string; authToken: string; senderId: string; toField: string; messageField: string; senderField: string };
type Provider = 'SMTP' | 'SMS_HTTP';
export type ProviderType = Provider;

function parseConfig(cipher: string) {
  return JSON.parse(decryptSecret(cipher)) as SmtpConfig | SmsConfig;
}
function parseRow(row: Record<string, unknown>) {
  const cipher = String(row.config_cipher || '');
  const config = cipher ? parseConfig(cipher) : null;
  return { config, enabled: Boolean(row.enabled), updatedAt: row.updated_at ? String(row.updated_at) : null, lastTestAt: row.last_test_at ? String(row.last_test_at) : null, lastTestStatus: row.last_test_status ? String(row.last_test_status) : null };
}
export async function getSavedProvider(provider: Provider) {
  const result = await execute('SELECT * FROM provider_configs WHERE provider=?', [provider]);
  if (!result.rows.length) return null;
  return parseRow(result.rows[0] as Record<string, unknown>);
}
export async function providerAvailability() {
  const result = await execute('SELECT provider,enabled FROM provider_configs');
  const states = new Map(result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return [String(row.provider), Boolean(row.enabled)] as const;
  }));
  return { smtp: states.get('SMTP') || false, sms: states.get('SMS_HTTP') || false };
}

export async function providerSummary() {
  const [smtp, sms] = await Promise.all([getSavedProvider('SMTP'), getSavedProvider('SMS_HTTP')]);
  const smtpConfig = smtp?.config as SmtpConfig | undefined;
  const smsConfig = sms?.config as SmsConfig | undefined;
  return {
    smtp: { configured: Boolean(smtp?.enabled && smtpConfig?.host && smtpConfig?.fromAddress), enabled: smtp?.enabled ?? false, host: smtpConfig?.host || '', port: smtpConfig?.port || 0, secure: smtpConfig?.secure || false, username: smtpConfig?.username || '', fromName: smtpConfig?.fromName || '', fromAddress: smtpConfig?.fromAddress || '', replyTo: smtpConfig?.replyTo || '', hasPassword: Boolean(smtpConfig?.password), lastTestAt: smtp?.lastTestAt, lastTestStatus: smtp?.lastTestStatus },
    sms: { configured: Boolean(sms?.enabled && smsConfig?.authToken), enabled: sms?.enabled ?? false, endpoint: smsConfig?.endpoint || '', authHeader: smsConfig?.authHeader || 'Authorization', authPrefix: smsConfig?.authPrefix || 'Bearer ', senderId: smsConfig?.senderId || '', toField: smsConfig?.toField || 'to', messageField: smsConfig?.messageField || 'message', senderField: smsConfig?.senderField || 'sender', hasToken: Boolean(smsConfig?.authToken), lastTestAt: sms?.lastTestAt, lastTestStatus: sms?.lastTestStatus },
  };
}

export async function saveProvider(provider: Provider, config: SmtpConfig | SmsConfig, enabled: boolean, actorId: string) {
  const client = turso;
  const now = new Date().toISOString();
  const encrypted = encryptSecret(JSON.stringify(config));
  await client.execute({
    sql: `INSERT INTO provider_configs(provider,config_cipher,enabled,updated_by,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(provider) DO UPDATE SET config_cipher=excluded.config_cipher,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    args: [provider, encrypted, enabled ? 1 : 0, actorId, now],
  });
}

export async function recordProviderTest(provider: Provider, success: boolean, summary: string) {
  await execute('UPDATE provider_configs SET last_test_at=?,last_test_status=? WHERE provider=?', [new Date().toISOString(), `${success ? 'OK' : 'FAILED'}: ${summary.slice(0, 180)}`, provider]);
}

function smtpTransport(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
}

export async function verifySmtpProvider(recipient?: string) {
  const saved = await getSavedProvider('SMTP');
  if (!saved?.enabled || !saved.config) throw new Error('SMTP provider is not configured and enabled.');
  const transport = smtpTransport(saved.config as SmtpConfig);
  try {
    await transport.verify();
    if (recipient) await sendEmail(recipient, { title: 'FloodGrid gateway test', body: 'This is a settings test requested by an administrator. No emergency alert is active.' });
  } finally { transport.close(); }
}

export async function sendEmail(recipient: string, payload: { title?: string; body?: string; url?: string; unsubscribeUrl?: string }): Promise<string | null> {
  const saved = await getSavedProvider('SMTP');
  if (!saved?.enabled || !saved.config) throw new Error('SMTP provider is disabled.');
  const config = saved.config as SmtpConfig;
  const transport = smtpTransport(config);
  try {
    const unsubscribe = payload.unsubscribeUrl ? `\n\nStop optional project updates: ${payload.unsubscribeUrl}` : '';
    const info = await transport.sendMail({
      from: { name: config.fromName || 'FloodGrid', address: config.fromAddress },
      to: recipient,
      replyTo: config.replyTo || undefined,
      subject: (payload.title || 'FloodGrid update').slice(0, 180),
      text: `${payload.body || 'Open FloodGrid to review the latest update.'}${payload.url ? `\n\n${new URL(payload.url, process.env.PUBLIC_APP_URL || 'https://example.invalid').toString()}` : ''}${unsubscribe}\n\nFloodGrid is an educational prototype, not an emergency service.`,
      headers: {
        'List-Unsubscribe': payload.unsubscribeUrl ? `<${payload.unsubscribeUrl}>` : undefined,
        'Auto-Submitted': 'auto-generated',
      } as Record<string, string>,
    });
    return info?.messageId ? String(info.messageId).slice(0, 500) : null;
  } finally { transport.close(); }
}

function validateSmsEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.search || url.hash) throw new Error('SMS gateway must be an HTTPS URL on port 443 without embedded credentials, query tokens or fragments.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost' || net.isIP(host)) throw new Error('Private, local and literal-IP SMS gateway hosts are not allowed.');
  if (ipaddr.isValid(host)) throw new Error('Literal-IP SMS gateway hosts are not allowed.');
  return url;
}

export async function sendSms(recipient: string, payload: { title?: string; body?: string; unsubscribeUrl?: string }) {
  const saved = await getSavedProvider('SMS_HTTP');
  if (!saved?.enabled || !saved.config) throw new Error('SMS HTTP gateway is disabled.');
  const config = saved.config as SmsConfig;
  const endpoint = validateSmsEndpoint(config.endpoint);
  const stopInstructions = payload.unsubscribeUrl ? ` To stop optional project updates, visit: ${payload.unsubscribeUrl}` : '';
  const message = `${payload.title || 'FloodGrid update'}: ${payload.body || 'Open FloodGrid to review the latest update.'} FloodGrid is an educational prototype.${stopInstructions}`.slice(0, 1400);
  const body: Record<string, string> = { [config.toField]: recipient, [config.messageField]: message };
  if (config.senderField && config.senderId) body[config.senderField] = config.senderId;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (config.authToken) headers[config.authHeader] = `${config.authPrefix}${config.authToken}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`SMS gateway responded with HTTP ${response.status}.`);
}

export async function verifySmsProvider(recipient: string) {
  const saved = await getSavedProvider('SMS_HTTP');
  if (!saved?.enabled || !saved.config) throw new Error('SMS HTTP gateway is not configured and enabled.');
  await sendSms(recipient, { title: 'FloodGrid gateway test', body: 'This is a settings test requested by your administrator. No emergency alert is active.' });
}

export function validateProviderInput(provider: ProviderType, input: Record<string, unknown>, previous?: SmtpConfig | SmsConfig | null) {
  if (provider === 'SMTP') {
    return parseSmtpInput(input, previous as SmtpConfig | null | undefined);
  }
  return parseSmsInput(input, previous as SmsConfig | null | undefined);
}

function parseSmtpInput(input: Record<string, unknown>, previous?: SmtpConfig | null): SmtpConfig {
  const password = typeof input.password === 'string' && input.password ? input.password : previous?.password || '';
  const config: SmtpConfig = {
    host: String(input.host || '').trim(), port: Number(input.port), secure: Boolean(input.secure), username: String(input.username || '').trim(), password,
    fromName: String(input.fromName || 'FloodGrid').trim(), fromAddress: String(input.fromAddress || '').trim().toLowerCase(), replyTo: String(input.replyTo || '').trim(),
  };
  if (!config.host || config.host.length > 255 || /[\s/@?#]/.test(config.host) || config.host.includes('://')) throw new Error('Enter an SMTP hostname only; credentials and URL paths are not accepted in the host field.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('SMTP port must be between 1 and 65535.');
  if (!config.fromAddress || config.fromAddress.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.fromAddress)) throw new Error('Enter a valid SMTP sender email address.');
  if (config.username && !config.password) throw new Error('SMTP username requires a password.');
  if (config.fromName.length > 100 || config.replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.replyTo)) throw new Error('Check SMTP sender name and reply-to email.');
  return config;
}
function parseSmsInput(input: Record<string, unknown>, previous?: SmsConfig | null): SmsConfig {
  const config: SmsConfig = {
    endpoint: String(input.endpoint || '').trim(), authHeader: String(input.authHeader || 'Authorization').trim(), authPrefix: String(input.authPrefix ?? 'Bearer ').slice(0, 40),
    authToken: typeof input.authToken === 'string' && input.authToken ? input.authToken : previous?.authToken || '', senderId: String(input.senderId || '').trim(),
    toField: String(input.toField || 'to').trim(), messageField: String(input.messageField || 'message').trim(), senderField: String(input.senderField || 'sender').trim(),
  };
  validateSmsEndpoint(config.endpoint);
  for (const key of [config.toField, config.messageField, config.senderField]) if (!/^[A-Za-z0-9_-]{1,48}$/.test(key)) throw new Error('Gateway JSON field names must contain only letters, numbers, underscores or hyphens.');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(config.authHeader) || /^(host|content-type|content-length)$/i.test(config.authHeader)) throw new Error('Gateway auth header name is invalid.');
  if (config.authPrefix && !/^[A-Za-z][A-Za-z0-9_-]{0,30} ?$/.test(config.authPrefix)) throw new Error('Auth prefix must be a scheme such as Bearer followed by an optional space, not a credential.');
  if (!config.authToken) throw new Error('Enter the SMS gateway token/API key.');
  if (config.senderId.length > 64) throw new Error('SMS sender ID must be 64 characters or fewer.');
  return config;
}
