import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value-0123456789abcdef';
import {
  constantTimeStringEqual, createCommandNonce, createTotpSecret, encryptSecret, decryptSecret, generateOpsCredential,
  generateTotpCode, hashPassword, hashToken, isEncryptedSecret, opsCredentialShapeIsValid, passwordProblem, safeEqual, totpUri,
  verifyPassword, verifyTotp,
} from '../security.js';

/**
 * Security primitives: password hashing and policy, secret encryption, token
 * hashing, TOTP, command nonces and rotating operations credentials.
 */

describe('password hashing', () => {
  it('hashes with bcrypt and verifies the same password', async () => {
    const hash = await hashPassword('Str0ngPassw0rd');
    assert.ok(hash.startsWith('$2'), 'new hashes must use bcrypt');
    assert.equal(await verifyPassword('Str0ngPassw0rd', hash), true);
    assert.equal(await verifyPassword('wrong-password', hash), false);
  });

  it('produces a different hash for the same password (unique salt)', async () => {
    const a = await hashPassword('Str0ngPassw0rd');
    const b = await hashPassword('Str0ngPassw0rd');
    assert.notEqual(a, b);
  });

  it('still verifies legacy scrypt hashes', async () => {
    const crypto = await import('node:crypto');
    const salt = crypto.randomBytes(16);
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt('LegacyPass1', salt, 64, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => {
        if (error) reject(error); else resolve(value as Buffer);
      });
    });
    const encoded = `scrypt$32768$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
    assert.equal(await verifyPassword('LegacyPass1', encoded), true);
    assert.equal(await verifyPassword('LegacyPass2', encoded), false);
  });

  it('rejects malformed hashes', async () => {
    assert.equal(await verifyPassword('anything', ''), false);
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  });
});

describe('password policy', () => {
  it('requires length, mixed case and a digit', () => {
    assert.match(passwordProblem('short') || '', /at least/);
    assert.match(passwordProblem('alllowercase1') || '', /uppercase/);
    assert.match(passwordProblem('ALLUPPERCASE1') || '', /lowercase/);
    assert.match(passwordProblem('NoDigitsHere') || '', /number/);
    assert.equal(passwordProblem('Str0ngPassw0rd'), null);
  });

  it('rejects obviously predictable passwords', () => {
    assert.match(passwordProblem('Floodguard123') || '', /predictable/);
  });
});

describe('secret encryption', () => {
  it('round-trips a secret and detects tampering', () => {
    const encoded = encryptSecret('smtp-password-value');
    assert.ok(isEncryptedSecret(encoded));
    assert.equal(decryptSecret(encoded), 'smtp-password-value');
    const tampered = encoded.slice(0, -4) + 'AAAA';
    assert.throws(() => decryptSecret(tampered));
  });

  it('uses a fresh IV for every value', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), decryptSecret(b));
  });

  it('rejects unsupported formats', () => {
    assert.throws(() => decryptSecret('v2.aaa.bbb.ccc'));
  });
});

describe('tokens and comparison', () => {
  it('hashes tokens deterministically and compares in constant time', () => {
    const hash = hashToken('token-value');
    assert.equal(hash, hashToken('token-value'));
    assert.notEqual(hash, hashToken('other'));
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(constantTimeStringEqual('same', 'same'), true);
    assert.equal(constantTimeStringEqual('same', 'diff'), false);
  });

  it('creates unique command nonces', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createCommandNonce()));
    assert.equal(nonces.size, 50);
  });
});

describe('TOTP', () => {
  it('generates a base32 secret and an otpauth URI', () => {
    const secret = createTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(totpUri('admin@example.org', secret), /^otpauth:\/\/totp\//);
  });

  it('verifies a current code and rejects others', () => {
    const secret = createTotpSecret();
    const now = Date.now();
    assert.equal(verifyTotp(secret, generateTotpCode(secret, now), now), true);
    assert.equal(verifyTotp(secret, generateTotpCode(secret, now, -1), now), true, 'the previous window is accepted');
    assert.equal(verifyTotp(secret, generateTotpCode(secret, now, 1), now), true, 'the next window is accepted');
    assert.equal(verifyTotp(secret, generateTotpCode(secret, now, 5), now), false, 'a distant window is rejected');
    assert.equal(verifyTotp(secret, '000000', now), false);
    assert.equal(verifyTotp(secret, '123456', now), false);
    assert.equal(verifyTotp(secret, 'abcdef', now), false);
    assert.equal(verifyTotp('not-base32!!', '123456', now), false);
  });
});

describe('rotating operations credential', () => {
  it('has a stable, parseable shape', () => {
    const credential = generateOpsCredential(7);
    assert.match(credential, /^FG-OPS-[0-9A-Z]{3}-[0-9A-Z]{10}$/);
    assert.equal(opsCredentialShapeIsValid(credential), true);
    assert.equal(opsCredentialShapeIsValid('nope'), false);
    assert.equal(opsCredentialShapeIsValid('FG-OPS-1-ABCDEFGHIJ'), false);
  });

  it('is unique per rotation', () => {
    const values = new Set(Array.from({ length: 25 }, (_unused, index) => generateOpsCredential(index)));
    assert.ok(values.size > 20);
  });
});
