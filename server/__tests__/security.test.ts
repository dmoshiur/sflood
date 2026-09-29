import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64);

const security = await import('../security.js');
const { validateProviderInput } = await import('../providers.js');

function decodeBase32(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let buffer = 0; const output: number[] = [];
  for (const char of value) {
    buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { output.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}
function totpAt(secret: string, now: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const value = (((digest[offset]! & 127) << 24) | ((digest[offset + 1]! & 255) << 16) | ((digest[offset + 2]! & 255) << 8) | (digest[offset + 3]! & 255)) % 1_000_000;
  return String(value).padStart(6, '0');
}

test('password hashing, encrypted settings, TOTP and consent tokens have secure primitives', async () => {
  const encoded = await security.hashPassword('long-and-unique-test-password');
  assert.equal(await security.verifyPassword('long-and-unique-test-password', encoded), true);
  assert.equal(await security.verifyPassword('incorrect-password', encoded), false);

  const ciphertext = security.encryptSecret('smtp-password-should-never-be-returned');
  assert.notEqual(ciphertext, 'smtp-password-should-never-be-returned');
  assert.equal(security.decryptSecret(ciphertext), 'smtp-password-should-never-be-returned');
  // Corrupt the GCM auth tag (second segment) deterministically — decryption must fail.
  const parts = ciphertext.split('.');
  const corruptedTag = parts[2]!.startsWith('A') ? `B${parts[2]!.slice(1)}` : `A${parts[2]!.slice(1)}`;
  assert.throws(() => security.decryptSecret([parts[0], parts[1], corruptedTag, parts[3]].join('.')));

  const secret = security.createTotpSecret();
  const now = 1_700_000_000_000;
  assert.equal(security.verifyTotp(secret, totpAt(secret, now), now), true);
  assert.equal(security.verifyTotp(secret, '000000', now), false);

  const codeHash = security.hashSmsVerificationCode('+8801700000000', '123456');
  assert.equal(codeHash, security.hashSmsVerificationCode('+8801700000000', '123456'));
  assert.notEqual(codeHash, security.hashSmsVerificationCode('+8801700000001', '123456'));
  assert.equal(security.createSmsUnsubscribeToken('subscription-a'), security.createSmsUnsubscribeToken('subscription-a'));
  assert.notEqual(security.createSmsUnsubscribeToken('subscription-a'), security.createSmsUnsubscribeToken('subscription-b'));
});

test('provider forms preserve saved secrets and reject insecure SMS gateway targets', () => {
  const smtp = validateProviderInput('SMTP', {
    host: 'smtp.example.test', port: 587, secure: false, username: 'operator', password: '',
    fromName: 'FloodGuard', fromAddress: 'alerts@example.test', replyTo: '',
  }, { host: 'smtp.example.test', port: 587, secure: false, username: 'operator', password: 'previous-password', fromName: 'FloodGuard', fromAddress: 'alerts@example.test' }) as { password: string };
  assert.equal(smtp.password, 'previous-password');

  assert.throws(() => validateProviderInput('SMS_HTTP', {
    endpoint: 'http://gateway.example.test/send', authToken: 'secret',
  }));
  assert.throws(() => validateProviderInput('SMS_HTTP', {
    endpoint: 'https://127.0.0.1/send', authToken: 'secret',
  }));
  assert.throws(() => validateProviderInput('SMS_HTTP', {
    endpoint: 'https://gateway.example.test/send', authHeader: 'Host', authToken: 'secret',
  }));
  assert.throws(() => validateProviderInput('SMS_HTTP', {
    endpoint: 'https://gateway.example.test/send?api_key=secret', authToken: 'secret',
  }));
  assert.throws(() => validateProviderInput('SMS_HTTP', {
    endpoint: 'https://gateway.example.test/send', authToken: 'secret', authPrefix: 'Bearer leaked-secret',
  }));
});
