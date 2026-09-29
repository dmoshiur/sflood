import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

/**
 * Security primitives.
 *
 * - Password hashing: bcrypt (cost 12) for new hashes, scrypt verification kept
 *   for hashes written by earlier versions so existing accounts keep working.
 * - Tokens: 256-bit random values, stored only as SHA-256 hashes.
 * - Comparisons: timing-safe.
 * - Secrets at rest: AES-256-GCM with a server-side key.
 * - TOTP: RFC 6238 for privileged MFA.
 * - Rotating operations credentials: high-entropy, hashed at rest, single use.
 */

const BCRYPT_ROUNDS = 12;

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET || '';
  if (Buffer.byteLength(secret) < 32) throw new Error('SESSION_SECRET must contain at least 32 random characters.');
  return secret;
}

export function hashToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashSmsVerificationCode(phone: string, code: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(`floodgrid:sms-verification:${phone}:${code}`).digest('hex');
}

export function createSmsUnsubscribeToken(subscriptionId: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(`floodgrid:sms-unsubscribe:${subscriptionId}`).digest('base64url');
}

export function safeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deriveScrypt(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, length, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!encoded) return false;
  if (encoded.startsWith('$2a$') || encoded.startsWith('$2b$') || encoded.startsWith('$2y$')) {
    try { return bcrypt.compareSync(password, encoded); } catch { return false; }
  }
  // Legacy scrypt hashes: scrypt$N$r$p$salt$derived
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const derived = await deriveScrypt(password, salt, expected.length);
    return safeEqual(derived, expected);
  } catch { return false; }
}

export function passwordProblem(password: string, minLength = 10): string | null {
  if (typeof password !== 'string' || password.length < minLength) return `Use at least ${minLength} characters.`;
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) return 'Include both lowercase and uppercase letters.';
  if (!/\d/.test(password)) return 'Include at least one number.';
  const common = ['password', 'qwerty', '123456', 'letmein', 'floodguard', 'floodgrid', 'admin123'];
  if (common.some((item) => password.toLowerCase().includes(item))) return 'Choose a less predictable password.';
  return null;
}

/**
 * AES-256-GCM key for secrets at rest (provider credentials, TOTP secrets).
 *
 * The value comes from `config`, which enforces the production requirement and
 * supplies a development-only fallback so `npm run dev` works without setup.
 * Accepts 64 hex characters or base64/base64url of 32 bytes.
 */
function getEncryptionKey(): Buffer {
  const value = config.settingsEncryptionKey || '';
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters or base64.');
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(encoded: string): string {
  const [version, ivPart, tagPart, cipherPart] = encoded.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !cipherPart) throw new Error('Encrypted secret has an unsupported format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(cipherPart, 'base64url')), decipher.final()]).toString('utf8');
}

export function isEncryptedSecret(value: string): boolean {
  return /^v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+$/.test(value);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer: Buffer): string {
  let bits = 0; let value = 0; let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(value: string): Buffer {
  let bits = 0; let accumulator = 0; const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '')) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid TOTP secret.');
    accumulator = (accumulator << 5) | index; bits += 5;
    if (bits >= 8) { output.push((accumulator >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

export function createTotpSecret(): string { return base32Encode(crypto.randomBytes(20)); }
export function totpUri(email: string, secret: string, issuer = 'FloodGrid'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
/** Generate the current RFC 6238 code for a base32 secret (used by tests and diagnostics). */
export function generateTotpCode(secret: string, now = Date.now(), deltaSteps = 0): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000) + deltaSteps));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff)) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function verifyTotp(secret: string, token: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  try {
    for (const delta of [-1, 0, 1]) {
      if (safeEqual(generateTotpCode(secret, now, delta), token)) return true;
    }
  } catch { return false; }
  return false;
}

/**
 * Rotating operations credential.
 *
 * Format is deliberately split so that the value can be checked in parts and so
 * that a partial leak of one segment is not sufficient to authenticate:
 *   FG-OPS-<rotation>-<8 random chars>
 * The full value is only ever delivered to the configured security mailbox.
 */
export function generateOpsCredential(rotationIndex: number): string {
  const random = crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase();
  return `FG-OPS-${rotationIndex.toString(36).toUpperCase().padStart(3, '0')}-${random}`;
}

export function opsCredentialShapeIsValid(value: string): boolean {
  return /^FG-OPS-[0-9A-Z]{3}-[0-9A-Z]{10}$/.test(value);
}

/** Command nonce for barrier commands: 128-bit random, single use, short TTL. */
export function createCommandNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

export function constantTimeStringEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}
