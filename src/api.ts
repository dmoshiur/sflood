import type { SiteBlock } from '../shared/site-blocks.js';

/** Typed API client. All calls are same-origin and credential-aware. */

async function request<T>(path: string, init?: RequestInit & { csrf?: string }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (init?.csrf) headers['x-csrf-token'] = init.csrf;
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `Request failed (${response.status}).`;
    const error = new Error(message) as Error & { status: number; code?: string };
    error.status = response.status;
    if (body && typeof body === 'object' && 'code' in body) error.code = String((body as { code: unknown }).code);
    throw error;
  }
  return body as T;
}

export interface PublicStatus {
  projectName: string;
  mode: string;
  generatedAt: string;
  maintenanceMode: boolean;
  statusEnabled: boolean;
  safetyNotice: string;
  safetyInstructions: string[];
  site: { city: string; zone: string; devices: number; simulationDevices: number };
  current: {
    state: string; label: string; guidance: string; levelCm: number | null; trendCm: number;
    rateCmPerMin: number | null; barrier: string; sensorHealthy: boolean; emergencyStopActive: boolean;
    faultState: string; simulated: boolean; lastUpdateAt: string | null;
    lastEvent: { fromState: string; toState: string; reason: string; createdAt: string; simulated: boolean } | null;
  };
  devices: Array<{
    deviceId: string; uid: string; name: string; board: string; simulation: boolean; zoneName: string; cityName: string;
    approvalState: string; online: boolean; levelCm: number | null; state: string; barrier: string; sensorHealthy: boolean;
    rateCmPerMin: number | null; simulated: boolean; lastUpdateAt: string | null; trendCm: number; limitSwitchLow: boolean;
    limitSwitchHigh: boolean; emergencyStopActive: boolean; faultState: string;
  }>;
  events: Array<{ id: string; fromState: string; toState: string; levelCm: number | null; reason: string; simulated: boolean; createdAt: string }>;
  history: Array<{ seq: number; levelCm: number; state: string; rateCmPerMin: number | null; simulated: boolean; createdAt: string }>;
}

export interface PublicConfig {
  projectName: string;
  mode: string;
  webPushAvailable: boolean;
  vapidPublicKey: string | null;
  cloudinary: { cloudName: string | null; uploadPreset: string | null; configured: boolean };
  firmware: { esp32Url: string | null; esp8266Url: string | null; releasesUrl: string | null; configured: boolean };
  mqttConfigured: boolean;
  simulationEnabled: boolean;
  notifications: {
    mode: string; maintenanceMode: boolean; webPushAvailable: boolean; vapidPublicKey: string | null;
    emailAvailable: boolean; smsAvailable: boolean; cloudinary: PublicConfig['cloudinary']; firmware: PublicConfig['firmware']; flags: Record<string, boolean>;
  };
  serviceAreas: Array<{ id: string; city: string; region: string; country: string; countryCode: string; latitude: number | null; longitude: number | null; requiresReview: boolean }>;
}

export interface AuthUser {
  id: string; email: string; displayName: string; role: 'MEMBER' | 'OPERATOR' | 'ADMIN' | 'OWNER';
  emailVerified: boolean; phoneVerified: boolean; totpEnrolled: boolean; mfaVerified: boolean;
  cityId: string | null; zoneId: string | null; serviceAreaId: string | null;
}

export interface DeviceSummary {
  id: string; uid: string; name: string; board: string; kind: string; approvalState: string; enabled: boolean;
  simulation: boolean; firmwareVersion: string; health: string; zoneId: string; zoneName: string; cityId: string;
  cityName: string; lastSeenAt: string | null; lastHeartbeatAt: string | null; lastSeq: number; currentState: string;
  barrierState: string; barrierLatched: boolean; emergencyStopActive: boolean; signalDbm: number | null;
  uptimeSeconds: number; faultState: string; limitSwitchLow: boolean; limitSwitchHigh: boolean;
  activeCredentials: number; config: Record<string, unknown>; createdAt: string;
}

export interface TelemetryPoint {
  id: string; deviceId: string; seq: number; levelCm: number | null; rainfallMm: number | null; state: string;
  barrierState: string; sensorHealthy: boolean; rssi: number | null; batteryMv: number | null;
  rateCmPerMin: number | null; simulated: boolean; createdAt: string;
}

export interface BarrierCommand {
  commandId: string; deviceId: string; action: string; status: string; requestedBy: string | null;
  requestedByKind: string; reason: string; issuedAt: string; expiresAt: string; acknowledgedAt: string | null;
}

export interface InAppNotification {
  id: string; severity: string; title: string; body: string; url: string; read: boolean; createdAt: string;
}

export interface FloodEventRow {
  id: string; deviceId: string; zoneId: string; fromState: string; toState: string; levelCm: number | null;
  rateCmPerMin: number | null; trigger: string; reason: string; simulated: boolean; acknowledged: boolean;
  acknowledgedAt: string | null; createdAt: string;
}

let csrfToken = '';
export function setCsrfToken(token: string) { csrfToken = token; }
export function getCsrfToken() { return csrfToken; }

const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), csrf: csrfToken });
const put = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body), csrf: csrfToken });
const patch = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body), csrf: csrfToken });
const del = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body), csrf: csrfToken });

export const api = {
  health: () => request<{ status: string; mode: string; databaseReady: boolean; counts: Record<string, number>; version: string }>('/api/health'),
  publicStatus: () => request<PublicStatus>('/api/public/status'),
  publicConfig: () => request<PublicConfig>('/api/public/config'),
  serviceAreas: () => request<{ serviceAreas: PublicConfig['serviceAreas'] }>('/api/public/service-areas'),
  publishedPage: (slug: string) => request<{ slug: string; title: string; version: number; publishedAt: string | null; blocks: SiteBlock[] }>(`/api/public/page/${slug}`),

  authStatus: () => request<{ databaseConfigured: boolean; bootstrapAvailable: boolean; ownerCount: number; registrationOpen: boolean }>('/api/auth/status'),
  me: () => request<{ user: AuthUser; csrfToken: string }>('/api/auth/me'),
  login: (email: string, password: string, totp?: string) => post<{ user: AuthUser; csrfToken: string; mfaSetupRequired?: boolean }>('/api/auth/login', { email, password, totp }),
  register: (input: { displayName: string; email: string; password: string; serviceAreaId: string; city?: string; countryCode?: string; phone?: string }) =>
    post<{ user: AuthUser; csrfToken: string; message: string }>('/api/auth/register', input),
  logout: () => post<{ loggedOut: boolean }>('/api/auth/logout'),
  resendVerification: () => post<{ queued: boolean; message: string }>('/api/auth/verify-email/resend'),
  forgotPassword: (email: string) => post<{ queued: boolean }>('/api/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) => post<{ reset: boolean; message?: string }>('/api/auth/password/reset', { token, password }),
  changePassword: (currentPassword: string, newPassword: string) => post<{ changed: boolean }>('/api/auth/password/change', { currentPassword, newPassword }),
  acceptInvite: (token: string, password: string, displayName?: string) => post<{ user: AuthUser; csrfToken: string }>('/api/auth/accept-invite', { token, password, displayName }),
  sessions: () => request<{ sessions: Array<{ id: string; current: boolean; ipAddress: string | null; userAgent: string | null; mfaVerified: boolean; createdAt: string; expiresAt: string; revoked: boolean }> }>('/api/auth/sessions'),
  revokeOtherSessions: () => post<{ revoked: number }>('/api/auth/sessions/revoke-others'),
  totpStart: () => post<{ secret: string; otpAuthUri: string }>('/api/auth/totp/start'),
  totpConfirm: (code: string) => post<{ enrolled: boolean }>('/api/auth/totp/confirm', { code }),

  profile: () => request<{
    profile: { id: string; email: string; displayName: string; role: string; phone: string | null; avatarUrl: string | null; emailVerified: boolean; phoneVerified: boolean; serviceArea: { city: string; country: string; countryCode: string } | null; createdAt: string; lastLoginAt: string | null };
    preferences: { emailEnabled: boolean; smsEnabled: boolean; pushEnabled: boolean; inAppEnabled: boolean; minSeverity: string; recoveryEnabled: boolean };
  }>('/api/me/profile'),
  updateProfile: (input: { displayName?: string; phone?: string; serviceAreaId?: string }) => put<{ message: string }>('/api/me/profile', input),
  avatarSignature: () => post<{ cloudName: string; apiKey: string | null; uploadPreset: string | null; folder: string; publicId: string; timestamp: number; signature: string | null; maxBytes: number; allowedFormats: string[] }>('/api/me/avatar/signature'),
  saveAvatar: (publicId: string, url: string) => post<{ avatarUrl: string }>('/api/me/avatar', { publicId, url }),
  removeAvatar: () => del<{ removed: boolean }>('/api/me/avatar'),
  updatePreferences: (input: Record<string, unknown>) => put<{ preferences: Record<string, unknown>; message: string }>('/api/me/notifications/preferences', input),
  notifications: () => request<{ unread: number; notifications: InAppNotification[] }>('/api/me/notifications'),
  markNotificationRead: (id: string) => post<{ read: boolean }>(`/api/me/notifications/${id}/read`),
  markAllNotificationsRead: () => post<{ read: number }>('/api/me/notifications/read-all'),
  savePush: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, zoneId?: string) => post<{ saved: boolean }>('/api/me/push', { consent: true, subscription, zoneId }),
  removePush: (endpoint: string) => del<{ removed: boolean }>('/api/me/push', { endpoint }),
  deliveries: () => request<{ deliveries: Array<{ id: string; channel: string; status: string; attempts: number; retryCount: number; providerMessageId: string | null; failureReason: string | null; sentAt: string | null; createdAt: string }> }>('/api/me/deliveries'),

  devices: () => request<{ mode: string; devices: DeviceSummary[] }>('/api/devices'),
  device: (id: string) => request<{ device: DeviceSummary & { heartbeatIntervalSeconds: number; config: Record<string, unknown>; lastSeq: number }; history: TelemetryPoint[]; commands: BarrierCommand[] }>(`/api/devices/${id}`),
  registerDevice: (input: { name: string; board: 'ESP32' | 'ESP8266'; zoneId?: string; firmwareVersion?: string; simulation?: boolean }) =>
    post<{ device: { id: string; uid: string; name: string; board: string; approvalState: string }; provisioning: { token: string; expiresAt: string; qrDataUrl: string; qrPayload: string }; message: string }>('/api/devices', input),
  approveDevice: (id: string, note?: string) => post<{ message: string }>(`/api/devices/${id}/approve`, { note }),
  rejectDevice: (id: string, note?: string) => post<{ message: string }>(`/api/devices/${id}/reject`, { note }),
  setDeviceEnabled: (id: string, enabled: boolean) => post<{ message: string }>(`/api/devices/${id}/enabled`, { enabled }),
  rotateDeviceCredentials: (id: string) => post<{ apiKey: string; message: string }>(`/api/devices/${id}/rotate-credentials`),
  revokeDeviceCredentials: (id: string) => post<{ revoked: boolean }>(`/api/devices/${id}/revoke-credentials`),
  updateDeviceConfig: (id: string, config: Record<string, unknown>) => put<{ config: Record<string, unknown> }>(`/api/devices/${id}/config`, config),
  deleteDevice: (id: string) => del<{ deleted: boolean }>(`/api/devices/${id}`),
  issueProvisioningToken: (id: string) => post<{ provisioning: { token: string; expiresAt: string; qrDataUrl: string; qrPayload: string } }>(`/api/devices/${id}/provisioning-token`),
  firmwareReleases: () => request<{ releases: Array<Record<string, unknown>>; links: { esp32: string | null; esp8266: string | null; releases: string | null }; note: string }>('/api/devices/firmware/releases'),

  barrierCommands: (params?: { deviceId?: string; zoneId?: string }) => request<{ commands: BarrierCommand[] }>(`/api/devices/barrier/commands${params?.deviceId ? `?deviceId=${params.deviceId}` : ''}`),
  issueBarrierCommand: (deviceId: string, action: string, reason?: string) => post<{ command: { commandId: string; action: string; status: string; expiresAt: string }; message: string }>('/api/devices/barrier/commands', { deviceId, action, reason }),
  cancelBarrierCommand: (commandId: string) => post<{ cancelled: boolean }>(`/api/devices/barrier/commands/${commandId}/cancel`),

  adminOverview: () => request<{
    role: string; scope: Record<string, string>; counts: Record<string, number>; flags: Record<string, boolean>;
    maintenanceMode: boolean; mode: string; devices: DeviceSummary[]; events: FloodEventRow[];
    deliveries: Record<string, number>; commands: { queued: number; acknowledged: number; failed: number };
  }>('/api/admin/overview'),
  adminUsers: () => request<{ users: Array<{ id: string; email: string; displayName: string; role: string; cityId: string | null; zoneId: string | null; serviceAreaId: string | null; serviceCity: string | null; serviceCountry: string | null; emailVerified: boolean; phoneVerified: boolean; disabled: boolean; lastLoginAt: string | null; createdAt: string }> }>('/api/admin/users'),
  updateUser: (id: string, input: Record<string, unknown>) => patch<{ updated: boolean }>(`/api/admin/users/${id}`, input),
  resetUserMfa: (id: string) => post<{ reset: boolean }>(`/api/admin/users/${id}/mfa-reset`),
  invites: () => request<{ invites: Array<{ id: string; email: string; displayName: string; role: string; zoneId: string | null; cityId: string | null; expiresAt: string; used: boolean; createdAt: string }> }>('/api/admin/invites'),
  createInvite: (input: { email: string; displayName: string; role: 'ADMIN' | 'OPERATOR'; zoneId?: string; cityId?: string }) =>
    post<{ inviteId: string; inviteUrl: string | null; expiresAt: string; message: string }>('/api/admin/invites', input),
  serviceAreasAdmin: () => request<{ serviceAreas: Array<Record<string, unknown>> }>('/api/admin/service-areas'),
  createServiceArea: (input: Record<string, unknown>) => post<{ serviceArea: Record<string, unknown> }>('/api/admin/service-areas', input),
  updateServiceArea: (id: string, input: Record<string, unknown>) => patch<{ serviceArea: Record<string, unknown> }>(`/api/admin/service-areas/${id}`, input),
  policies: () => request<{ policies: Array<Record<string, unknown>> }>('/api/admin/policies'),
  savePolicy: (input: Record<string, unknown>) => post<{ id: string; message: string }>('/api/admin/policies', input),
  updatePolicy: (id: string, input: Record<string, unknown>) => put<{ updated: boolean }>(`/api/admin/policies/${id}`, input),
  subscribers: () => request<{
    emailSubscribers: Array<{ id: string; email: string; zoneId: string; verified: boolean; unsubscribed: boolean; source: string; createdAt: string }>;
    pushSubscriptions: Array<{ id: string; zoneId: string; endpoint: string; active: boolean; consentAt: string }>;
    registeredUsers: Array<{ id: string; email: string; displayName: string; role: string; zoneId: string | null; cityId: string | null; serviceCity: string | null }>;
  }>('/api/admin/subscribers'),
  records: () => request<{ records: Array<{ id: string; zoneId: string | null; deviceId: string | null; kind: string; levelCm: number | null; note: string; recordedBy: string | null; createdAt: string }> }>('/api/admin/records'),
  createRecord: (input: { zoneId?: string; deviceId?: string; kind?: string; levelCm?: number | null; note: string }) => post<{ id: string }>('/api/admin/records', input),
  templates: () => request<{ templates: Array<{ id: string; templateKey: string; channel: string; state: string; subject: string; body: string; enabled: boolean }> }>('/api/admin/templates'),
  saveTemplate: (input: Record<string, unknown>) => post<{ id: string }>('/api/admin/templates', input),
  settings: () => request<{ settings: Record<string, unknown>; flags: Record<string, boolean> }>('/api/admin/settings'),
  updateSettings: (settings: Record<string, unknown>) => put<{ updated: boolean }>('/api/admin/settings', { settings }),
  setFlag: (key: string, enabled: boolean, description?: string) => put<{ flags: Record<string, boolean> }>(`/api/admin/flags/${key}`, { enabled, description }),
  setMaintenance: (enabled: boolean, reason?: string) => post<{ maintenanceMode: boolean }>('/api/admin/maintenance', { enabled, reason }),
  alerts: () => request<{ alerts: FloodEventRow[] }>('/api/admin/alerts'),
  acknowledgeAlert: (id: string) => post<{ acknowledged: boolean }>(`/api/admin/alerts/${id}/acknowledge`),
  reports: () => request<{
    eventsByState: Array<{ state: string; count: number }>;
    eventsByDay: Array<{ day: string; count: number }>;
    deliveriesByChannel: Array<{ channel: string; status: string; count: number }>;
    deviceUptime: Array<{ uid: string; name: string; health: string; uptimeSeconds: number; lastSeenAt: string | null; approvalState: string }>;
  }>('/api/admin/reports'),
  audit: (limit = 200) => request<{ entries: Array<{ id: string; action: string; targetType: string; targetId: string | null; metadata: unknown; ipAddress: string | null; createdAt: string; actorEmail: string }> }>(`/api/admin/audit?limit=${limit}`),
  providers: () => request<{ providers: Record<string, Record<string, unknown>> }>('/api/admin/providers'),
  saveSmtp: (input: Record<string, unknown>) => put<{ saved: boolean }>('/api/admin/providers/smtp', input),
  saveSms: (input: Record<string, unknown>) => put<{ saved: boolean }>('/api/admin/providers/sms', input),
  testSmtp: (recipient: string) => post<{ ok: boolean }>('/api/admin/providers/smtp/test', { recipient }),
  testSms: (recipient: string) => post<{ ok: boolean }>('/api/admin/providers/sms/test', { recipient }),

  opsStatus: () => request<{
    available: boolean; securityEmailConfigured: boolean; smtpConfigured: boolean; rotationMinutes: number;
    credentialTtlMinutes: number; requireMfa: boolean; ipAllowlistConfigured: boolean;
    currentCredential: { issuedAt: string; expiresAt: string; consumed: boolean; revoked: boolean } | null;
    opsSessionActive: boolean; opsSessionExpiresAt: string | null; note: string;
  }>('/api/ops/status'),
  opsUnlock: (credential: string, totp?: string) => post<{ opened: boolean; expiresAt: string; message?: string }>('/api/ops/session', { credential, totp }),
  opsLock: () => post<{ closed: boolean }>('/api/ops/session/end'),
  opsOverview: () => request<{
    version: string; gitCommit: string; environment: string; database: { mode: string; target: string };
    flags: Record<string, boolean>; maintenanceMode: boolean;
    sessions: Array<{ id: string; email: string; ipAddress: string | null; mfaVerified: boolean; expiresAt: string; createdAt: string }>;
    credentials: Array<{ id: string; issuedAt: string; expiresAt: string; consumed: boolean; revoked: boolean; failedAttempts: number }>;
    deployments: Array<{ id: string; environment: string; appVersion: string; gitCommit: string; deployedAt: string; note: string }>;
    commands: Array<{ commandId: string; deviceId: string; action: string; status: string; issuedAt: string }>;
    audit: Array<{ id: string; action: string; targetType: string; metadata: unknown; createdAt: string }>;
  }>('/api/ops/overview'),
  opsRotate: () => post<{ rotated: boolean; expiresAt: string; delivered: boolean; message: string }>('/api/ops/rotate'),
  opsSetMaintenance: (enabled: boolean, reason?: string) => post<{ maintenanceMode: boolean }>('/api/ops/maintenance', { enabled, reason }),
  opsEmergencyStatus: (status: string, note?: string) => post<{ emergencyStatus: string }>('/api/ops/emergency-status', { status, note }),
  opsDeviceEmergency: (deviceId: string, action: string) => post<{ commandId: string; expiresAt: string }>(`/api/ops/devices/${deviceId}/emergency`, { action }),
  opsRevokeSession: (id: string) => post<{ revoked: number }>(`/api/ops/sessions/${id}/revoke`),
  opsSetFlag: (key: string, enabled: boolean) => put<{ flags: Record<string, boolean> }>(`/api/ops/flags/${key}`, { enabled }),
  opsSuperAdmins: () => request<{ superAdmins: Array<{ id: string; email: string; displayName: string; disabled: boolean; mfaEnrolled: boolean; lastLoginAt: string | null; createdAt: string }> }>('/api/ops/superadmins'),
  opsResetSuperAdminMfa: (id: string) => post<{ reset: boolean }>(`/api/ops/superadmins/${id}/reset-mfa`),
  opsAudit: () => request<{ entries: Array<{ id: string; action: string; targetType: string; targetId: string | null; metadata: unknown; ipAddress: string | null; createdAt: string }> }>('/api/ops/audit'),
  opsBackups: () => request<{ backups: Array<{ id: string; kind: string; target: string; status: string; note: string; createdAt: string; completedAt: string | null }> }>('/api/ops/backups'),
  opsRecordBackup: (note?: string) => post<{ id: string; message: string }>('/api/ops/backups', { note }),

  pages: () => request<{ pages: Array<{ id: string; slug: string; title: string; status: string; publishedVersionId: string | null; updatedAt: string; versions: Array<{ id: string; version: number; title: string; createdAt: string; publishedAt: string | null }> }> }>('/api/admin/pages'),
  page: (id: string) => request<{ page: { id: string; slug: string; title: string; status: string; publishedVersionId: string | null; blocks: SiteBlock[] } }>(`/api/admin/pages/${id}`),
  createPage: (slug: string, title: string) => post<{ id: string; slug: string }>('/api/admin/pages', { slug, title }),
  saveDraft: (id: string, title: string, blocks: SiteBlock[], note?: string) => put<{ saved: boolean; blocks: number }>(`/api/admin/pages/${id}/draft`, { title, blocks, note }),
  publishPage: (id: string, title: string, blocks: SiteBlock[], note?: string) => post<{ published: boolean; version: number; message: string }>(`/api/admin/pages/${id}/publish`, { title, blocks, note }),
  rollbackPage: (id: string, versionId: string) => post<{ rolledBack: boolean; version: number; message: string }>(`/api/admin/pages/${id}/rollback`, { versionId }),
  blockLibrary: () => request<{ library: Array<{ type: string; label: string; description: string; template: SiteBlock }> }>('/api/admin/library'),

  simulationState: () => request<{
    simulation: boolean; active: boolean; running: boolean; intervalSeconds: number; pattern: string;
    device: { id: string; uid: string; name: string; board: string; approvalState: string; currentState: string; barrierState: string; lastSeq: number; emergencyStopActive: boolean; faultState: string } | null;
    levelCm: number | null; eventCount: number; lastEvent: { fromState: string; toState: string; levelCm: number; reason: string; createdAt: string } | null;
    history: TelemetryPoint[];
  }>('/api/simulation/state'),
  simulationStep: (input: { scenario?: string; levelCm?: number; rateCmPerMin?: number }) => post<{ state: string; previousState: string; changed: boolean; barrier: string; levelCm: number; eventId: string | null; commandId: string | null; message: string }>('/api/simulation/step', input),
  simulationStart: (intervalSeconds?: number, pattern?: string) => post<{ running: boolean }>('/api/simulation/start', { intervalSeconds, pattern }),
  simulationStop: () => post<{ running: boolean }>('/api/simulation/stop'),
};

export function formatTime(value: string | Date | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(undefined, options || { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  return formatTime(value, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function formatLevel(levelCm: number | null): string {
  return levelCm === null ? '—' : `${levelCm.toFixed(1)} cm`;
}
