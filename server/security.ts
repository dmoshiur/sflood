import crypto from 'node:crypto';

function deriveKey(password: string, salt: Buffer, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, length, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

export function hashToken(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET || '';
  if (Buffer.byteLength(secret) < 32) throw new Error('SESSION_SECRET must contain at least 32 random characters for verification-code and unsubscribe tokens.');
  return secret;
}

export function hashSmsVerificationCode(phone: string, code: string) {
  return crypto.createHmac('sha256', getSessionSecret()).update(`floodguard:sms-verification:${phone}:${code}`).digest('hex');
}

export function createSmsUnsubscribeToken(subscriptionId: string) {
  return crypto.createHmac('sha256', getSessionSecret()).update(`floodguard:sms-unsubscribe:${subscriptionId}`).digest('base64url');
}

export function safeEqual(left: string | Buffer, right: string | Buffer) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const N = 32_768;
  const derived = await deriveKey(password, salt, 64);
  return `scrypt$${N}$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '32768' || parts[2] !== '8' || parts[3] !== '1') return false;
  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const derived = await deriveKey(password, salt, expected.length);
    return safeEqual(derived, expected);
  } catch { return false; }
}

function getEncryptionKey() {
  const value = process.env.SETTINGS_ENCRYPTION_KEY || '';
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters or base64.');
  return key;
}

export function encryptSecret(plaintext: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(encoded: string) {
  const [version, ivPart, tagPart, cipherPart] = encoded.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !cipherPart) throw new Error('Encrypted provider secret has an unsupported format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(cipherPart, 'base64url')), decipher.final()]).toString('utf8');
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer: Buffer) {
  let bits = 0; let value = 0; let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(value: string) {
  let bits = 0; let accumulator = 0; const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid TOTP secret.');
    accumulator = (accumulator << 5) | index; bits += 5;
    if (bits >= 8) { output.push((accumulator >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

export function createTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
export function totpUri(email: string, secret: string) {
  const label = encodeURIComponent(`FloodGuard:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=FloodGuard&algorithm=SHA1&digits=6&period=30`;
}
export function verifyTotp(secret: string, token: string, now = Date.now()) {
  if (!/^\d{6}$/.test(token)) return false;
  const key = base32Decode(secret);
  const current = Math.floor(now / 30_000);
  for (let delta = -1; delta <= 1; delta += 1) {
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(current + delta));
    const digest = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const code = (((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff)) % 1_000_000;
    if (safeEqual(String(code).padStart(6, '0'), token)) return true;
  }
  return false;
}
