import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Central runtime configuration.
 *
 * Every secret is read from the environment on the server. Nothing in this
 * module (or anything it exports) is ever bundled into the browser: the frontend
 * only receives the explicitly public values listed in `publicConfig()`.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isProduction = process.env.NODE_ENV === 'production';

function optionalNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csv(value: string | undefined): string[] {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

/** Deterministic development-only fallback so `npm run dev` works without setup. */
function devFallbackSecret(label: string, bytes = 32): string {
  if (isProduction) {
    console.error(`[floodgrid] ${label} must be set in production. Refusing to start with a development fallback.`);
    process.exit(1);
  }
  const marker = path.join(projectRoot, 'data', '.dev-secret-marker');
  try {
    if (!fs.existsSync(path.join(projectRoot, 'data'))) fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
    if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
      return fs.readFileSync(marker, 'utf8').trim();
    }
    const generated = crypto.randomBytes(bytes).toString('base64url');
    fs.writeFileSync(marker, generated, { mode: 0o600 });
    console.warn(`[floodgrid] ${label} was not set. Generated a development-only value stored in data/.dev-secret-marker. Set ${label} for any real deployment.`);
    return generated;
  } catch {
    console.warn(`[floodgrid] ${label} was not set and no development fallback could be persisted. Using an in-memory value.`);
    return crypto.randomBytes(bytes).toString('base64url');
  }
}

function resolveDatabaseUrl(): string {
  const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  if (tursoUrl) return tursoUrl;
  const explicit = (process.env.LIBSQL_FILE || '').trim();
  if (explicit) return explicit.startsWith('file:') ? explicit : `file:${explicit}`;
  return `file:${path.join(projectRoot, 'data', 'floodgrid.db').replace(/\\/g, '/')}`;
}

const databaseUrl = resolveDatabaseUrl();

export const config = {
  isProduction,
  nodeEnv: process.env.NODE_ENV || 'development',
  projectRoot,
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.API_PORT || process.env.PORT || 3000),
  webPort: Number(process.env.WEB_PORT || 5173),
  trustProxy: optionalNumber(process.env.TRUST_PROXY, 0),

  databaseUrl,
  databaseAuthToken: process.env.TURSO_AUTH_TOKEN || undefined,
  isLocalDatabase: databaseUrl.startsWith('file:'),

  sessionSecret: process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : devFallbackSecret('SESSION_SECRET'),
  settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY
    ? process.env.SETTINGS_ENCRYPTION_KEY
    : devFallbackSecret('SETTINGS_ENCRYPTION_KEY'),

  publicAppUrl: (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, ''),
  adminCidrAllowlist: csv(process.env.ADMIN_CIDR_ALLOWLIST),
  opsCidrAllowlist: csv(process.env.OPS_CIDR_ALLOWLIST || process.env.ADMIN_CIDR_ALLOWLIST),
  deviceCidrAllowlist: csv(process.env.DEVICE_CIDR_ALLOWLIST),

  sessionTtlHours: optionalNumber(process.env.SESSION_TTL_HOURS, 12),
  adminSessionTtlHours: optionalNumber(process.env.ADMIN_SESSION_TTL_HOURS, 4),
  opsSessionTtlMinutes: optionalNumber(process.env.OPS_SESSION_TTL_MINUTES, 30),
  passwordMinLength: optionalNumber(process.env.PASSWORD_MIN_LENGTH, 10),

  // Rotating operations credential (Hackeradmin).
  opsEmail: (process.env.OPS_SECURITY_EMAIL || '').trim(),
  opsRotationMinutes: optionalNumber(process.env.OPS_ROTATION_MINUTES, 60),
  opsMaxAttempts: optionalNumber(process.env.OPS_MAX_ATTEMPTS, 5),
  opsCredentialTtlMinutes: optionalNumber(process.env.OPS_CREDENTIAL_TTL_MINUTES, 75),
  opsRequireMfa: (process.env.OPS_REQUIRE_MFA || 'true') !== 'false',

  // Optional MQTT bridge.
  mqttUrl: (process.env.MQTT_URL || '').trim(),
  mqttUsername: process.env.MQTT_USERNAME || '',
  mqttPassword: process.env.MQTT_PASSWORD || '',
  mqttTopicPrefix: process.env.MQTT_TOPIC_PREFIX || 'floodgrid',

  // Web Push (VAPID).
  vapidPublicKey: (process.env.VAPID_PUBLIC_KEY || '').trim(),
  vapidPrivateKey: (process.env.VAPID_PRIVATE_KEY || '').trim(),
  vapidSubject: (process.env.VAPID_SUBJECT || 'mailto:project-owner@example.invalid').trim(),

  // Cloudinary: the cloud name is public, the API secret never leaves the server.
  cloudinaryCloudName: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
  cloudinaryApiKey: (process.env.CLOUDINARY_API_KEY || '').trim(),
  cloudinaryApiSecret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
  cloudinaryUploadPreset: (process.env.CLOUDINARY_UPLOAD_PRESET || '').trim(),
  cloudinaryFolder: (process.env.CLOUDINARY_FOLDER || 'floodgrid/avatars').trim(),

  // Firmware distribution links. Never hard-coded: empty means "not configured".
  githubEsp32Url: (process.env.FIRMWARE_GITHUB_ESP32_URL || '').trim(),
  githubEsp8266Url: (process.env.FIRMWARE_GITHUB_ESP8266_URL || '').trim(),
  githubReleasesUrl: (process.env.FIRMWARE_GITHUB_RELEASES_URL || '').trim(),

  // Optional secondary IP geolocation lookup (eligibility hint only).
  geoLookupUrl: (process.env.IP_GEO_LOOKUP_URL || '').trim(),
  geoLookupToken: (process.env.IP_GEO_LOOKUP_TOKEN || '').trim(),

  /** Values that are safe to expose to the browser. */
  publicConfig: publicAppConfig,
};

/** Values that are safe to expose to the browser. Contains no secrets. */
function publicAppConfig() {
  return {
    projectName: 'Smart Flood Control & Automation',
    mode: config.isLocalDatabase ? 'local-database' : 'turso',
    webPushAvailable: Boolean(config.vapidPublicKey && config.vapidPrivateKey),
    vapidPublicKey: config.vapidPublicKey || null,
    cloudinary: {
      cloudName: config.cloudinaryCloudName || null,
      uploadPreset: config.cloudinaryUploadPreset || null,
      configured: Boolean(config.cloudinaryCloudName && (config.cloudinaryApiSecret || config.cloudinaryUploadPreset)),
    },
    firmware: {
      esp32Url: config.githubEsp32Url || null,
      esp8266Url: config.githubEsp8266Url || null,
      releasesUrl: config.githubReleasesUrl || null,
      configured: Boolean(config.githubEsp32Url || config.githubEsp8266Url || config.githubReleasesUrl),
    },
    mqttConfigured: Boolean(config.mqttUrl),
    simulationEnabled: true,
  };
}

export type AppConfig = typeof config;

/** Runtime config is read once at startup; secrets stay server-side. */
export type PublicConfig = ReturnType<typeof publicAppConfig>;

/** Feature flags are stored in the database so operations can toggle them live. */
export const DEFAULT_FEATURE_FLAGS: Record<string, boolean> = {
  public_registration: true,
  device_approval_required: true,
  mqtt_gateway_enabled: false,
  sms_channel_enabled: false,
  auto_barrier_commands: true,
  public_status_page: true,
  email_alerts: true,
};

export function assertProductionSecrets() {
  const problems: string[] = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET (32+ characters)');
  if (!process.env.SETTINGS_ENCRYPTION_KEY) problems.push('SETTINGS_ENCRYPTION_KEY (32 bytes, hex or base64)');
  if (!process.env.PUBLIC_APP_URL) problems.push('PUBLIC_APP_URL (canonical HTTPS origin)');
  if (!config.isLocalDatabase && !process.env.TURSO_AUTH_TOKEN) problems.push('TURSO_AUTH_TOKEN');
  if (problems.length) {
    console.warn(`[floodgrid] Production configuration is incomplete: ${problems.join(', ')}.`);
  }
  return problems;
}
