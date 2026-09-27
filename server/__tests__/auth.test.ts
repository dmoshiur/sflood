import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'floodguard-auth-test-'));
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = `file:${path.join(temporaryDirectory, 'auth.db')}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.SETTINGS_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.SESSION_SECRET = 'auth-integration-session-secret-with-32-bytes';
process.env.OWNER_BOOTSTRAP_TOKEN = 'test-bootstrap-token-with-more-than-32-characters';
process.env.OWNER_BOOTSTRAP_CIDR_ALLOWLIST = '127.0.0.1/32';
process.env.ADMIN_CIDR_ALLOWLIST = '127.0.0.1/32';
process.env.PUBLIC_APP_URL = 'https://floodguard.example.test';

const database = await import('../database.js');
await database.migrateDatabase();
const createdAt = new Date().toISOString();
await database.execute('INSERT INTO tenants(id,name,slug,created_at) VALUES(?,?,?,?)', ['auth-tenant', 'FloodGuard', 'floodguard-demo', createdAt]);
const { app } = await import('../index.js');
const server = createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
const baseUrl = `http://127.0.0.1:${address.port}`;
const origin = baseUrl;

function cookiesFrom(response: Response) {
  return (response.headers.get('set-cookie') || '').split(/, (?=[^;,]+=)/).map((item) => item.split(';', 1)[0]).filter(Boolean).join('; ');
}
function decodeBase32(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let buffer = 0; const output: number[] = [];
  for (const char of value) {
    buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { output.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}
function totpNow(secret: string) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const value = (((digest[offset]! & 127) << 24) | ((digest[offset + 1]! & 255) << 16) | ((digest[offset + 2]! & 255) << 8) | (digest[offset + 3]! & 255)) % 1_000_000;
  return String(value).padStart(6, '0');
}

async function post(pathname: string, body: unknown, cookie = '', csrf = '') {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function patch(pathname: string, body: unknown, cookie: string, csrf: string) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
  });
}

test('bootstrap, MFA, CSRF and provider-secret redaction protect Hackeradmin', async (t) => {
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.requireTurso().close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const status = await (await fetch(`${baseUrl}/api/auth/status`)).json();
  assert.equal(status.bootstrapAvailable, true);
  const boot = await post('/api/auth/bootstrap', {
    name: 'Test Owner', email: 'owner@example.test', password: 'a-very-long-integration-password', token: process.env.OWNER_BOOTSTRAP_TOKEN,
  });
  assert.equal(boot.status, 201);
  const bootBody = await boot.json();
  assert.equal(bootBody.user.role, 'OWNER');
  assert.equal(bootBody.mfaSetupRequired, true);
  const cookies = cookiesFrom(boot);
  assert.match(cookies, /fg_session=.*fg_csrf=/);
  const csrf = bootBody.csrfToken as string;

  const blockedBeforeMfa = await post('/api/owner/providers/smtp', { host: 'smtp.example.test' }, cookies, csrf);
  assert.equal(blockedBeforeMfa.status, 403);
  assert.match((await blockedBeforeMfa.json()).error, /authenticator/i);

  const startMfa = await post('/api/auth/totp/start', {}, cookies, csrf);
  assert.equal(startMfa.status, 200);
  const mfa = await startMfa.json();
  const confirmMfa = await post('/api/auth/totp/confirm', { code: totpNow(mfa.secret) }, cookies, csrf);
  assert.equal(confirmMfa.status, 200);
  assert.equal((await confirmMfa.json()).enrolled, true);

  const noCsrf = await fetch(`${baseUrl}/api/owner/providers/smtp`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookies },
    body: JSON.stringify({ host: 'smtp.example.test' }),
  });
  assert.equal(noCsrf.status, 403);

  const smtpSecret = 'smtp-password-that-must-not-leak';
  const smtpResponse = await fetch(`${baseUrl}/api/owner/providers/smtp`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookies, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ host: 'smtp.example.test', port: 587, secure: false, username: 'mailer', password: smtpSecret, fromName: 'FloodGuard', fromAddress: 'alerts@example.test', replyTo: '', enabled: true }),
  });
  assert.equal(smtpResponse.status, 200);
  const smtpBody = await smtpResponse.json();
  assert.equal(smtpBody.providers.smtp.hasPassword, true);
  assert.equal(JSON.stringify(smtpBody).includes(smtpSecret), false);

  const smsSecret = 'sms-token-that-must-not-leak';
  const smsResponse = await fetch(`${baseUrl}/api/owner/providers/sms`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookies, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ endpoint: 'https://gateway.example.test/send', authHeader: 'Authorization', authPrefix: 'Bearer ', authToken: smsSecret, senderId: 'FloodGuard', toField: 'to', messageField: 'message', senderField: 'sender', enabled: true }),
  });
  assert.equal(smsResponse.status, 200);
  const smsBody = await smsResponse.json();
  assert.equal(smsBody.providers.sms.hasToken, true);
  assert.equal(JSON.stringify(smsBody).includes(smsSecret), false);

  const duplicateBootstrap = await post('/api/auth/bootstrap', {
    name: 'Other Owner', email: 'other@example.test', password: 'another-long-integration-password', token: process.env.OWNER_BOOTSTRAP_TOKEN,
  });
  assert.equal(duplicateBootstrap.status, 409);

  const inviteResponse = await post('/api/owner/invites', { name: 'Second Owner', email: 'second-owner@example.test' }, cookies, csrf);
  assert.equal(inviteResponse.status, 201);
  const inviteBody = await inviteResponse.json();
  const inviteToken = new URL(inviteBody.inviteUrl).searchParams.get('invite');
  assert.ok(inviteToken);
  const acceptedInvite = await post('/api/auth/accept-invite', { token: inviteToken, password: 'second-owner-password-long' });
  assert.equal(acceptedInvite.status, 201);
  const acceptedBody = await acceptedInvite.json();
  assert.equal(acceptedBody.user.role, 'OWNER');
  assert.equal(acceptedBody.mfaSetupRequired, true);
  const secondOwnerCookies = cookiesFrom(acceptedInvite);
  const reusedInvite = await post('/api/auth/accept-invite', { token: inviteToken, password: 'second-owner-password-long' });
  assert.equal(reusedInvite.status, 400);

  const usersResponse = await fetch(`${baseUrl}/api/owner/users`, { headers: { Cookie: cookies } });
  assert.equal(usersResponse.status, 200);
  const users = (await usersResponse.json()).users as Array<{ id: string; role: string; email: string }>;
  const secondOwner = users.find((item) => item.email === 'second-owner@example.test');
  assert.ok(secondOwner);
  const disableSecondOwner = await patch(`/api/owner/users/${secondOwner.id}`, { disabled: true }, cookies, csrf);
  assert.equal(disableSecondOwner.status, 200);
  const revokedSecondOwner = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: secondOwnerCookies } });
  assert.equal(revokedSecondOwner.status, 401);
  const selfDisable = await patch(`/api/owner/users/${users.find((item) => item.email === 'owner@example.test')!.id}`, { disabled: true }, cookies, csrf);
  assert.equal(selfDisable.status, 400);
  const reenableSecondOwner = await patch(`/api/owner/users/${secondOwner.id}`, { disabled: false }, cookies, csrf);
  assert.equal(reenableSecondOwner.status, 200);
  const resetMfa = await post(`/api/owner/users/${secondOwner.id}/mfa/reset`, {}, cookies, csrf);
  assert.equal(resetMfa.status, 200);
});
