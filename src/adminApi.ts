/** Extended API helpers for the public status, profile, admin and ops surfaces. */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isWrite = init?.method && init.method !== 'GET';
  const csrf = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('fg_csrf='));
  const csrfToken = csrf ? decodeURIComponent(csrf.slice('fg_csrf='.length)) : '';
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(isWrite && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init?.headers,
    },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('The API returned an unreadable response.'); }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'The request could not be completed.';
    throw new Error(message);
  }
  return body as T;
}

export interface PublicStatus {
  mode: 'simulation' | 'turso';
  simulation: boolean;
  simulationNotice: string | null;
  project: string;
  city: string;
  zone: string;
  state: string;
  stateLabel: string;
  levelCm: number | null;
  trendCm: number;
  rateOfRiseCmPerMin: number;
  barrier: string;
  barrierLatched: boolean;
  sensorHealthy: boolean;
  emergencyStopActive: boolean;
  lastUpdate: string;
  lastSampleAt: string;
  devicesOnline: number;
  devicesTotal: number;
  maintenanceMode: boolean;
  safetyInstructions: string[];
  updatedAt: string;
}

export interface ServiceArea { id: string; countryCode: string; countryName: string; cityName: string; enabled: boolean }
export interface FloodEventRow {
  id: string; key: string; state: string; severity: string; levelCm: number | null;
  reason: string; simulation: boolean; createdAt: string;
}

export const getPublicStatus = () => request<PublicStatus>('/api/public/status');
export const getServiceAreas = () => request<{ serviceAreas: ServiceArea[] }>('/api/public/service-areas');
export const getFloodEvents = (limit = 20) => request<{ mode: string; simulation: boolean; events: FloodEventRow[] }>(`/api/public/flood-events?limit=${limit}`);

export const registerAccount = (input: { name: string; email: string; password: string; countryCode: string; cityName: string; consent: true }) =>
  request<{ created: boolean; verificationQueued: boolean; message: string }>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });

export interface ProfilePayload {
  id: string; email: string; displayName: string; phone: string; phoneVerified: boolean;
  country: string; cityName: string; avatarUrl: string | null; emailVerified: boolean;
  notificationPrefs: { floodAlerts: boolean; email: boolean; push: boolean; sms: boolean };
  createdAt: string;
}

export const getProfile = () => request<{ profile: ProfilePayload }>('/api/profile');
export const updateProfile = (input: Partial<{ displayName: string; phone: string; country: string; cityName: string; notificationPrefs: { floodAlerts: boolean; email: boolean; push: boolean; sms: boolean } }>) =>
  request<{ saved: boolean }>('/api/profile', { method: 'PUT', body: JSON.stringify(input) });
export const uploadAvatar = (dataUri: string, mimeType: string) =>
  request<{ saved: boolean; avatarUrl: string }>('/api/profile/avatar', { method: 'POST', body: JSON.stringify({ dataUri, mimeType }) });

export interface InboxItem {
  id: string; kind: string; severity: string; title: string; body: string;
  link: string | null; readAt: string | null; createdAt: string;
}
export const getInbox = () => request<{ notifications: InboxItem[]; unread: number }>('/api/profile/inbox');
export const markInboxRead = (id: string) => request<{ read: boolean }>(`/api/profile/inbox/${id}/read`, { method: 'POST', body: '{}' });
export const markInboxAllRead = () => request<{ read: boolean }>('/api/profile/inbox/read-all', { method: 'POST', body: '{}' });

// --- Admin / ops ---
export const adminDevices = () => request<{ devices: Array<Record<string, unknown>> }>('/api/owner/devices');
export const adminApproveDevice = (id: string) => request<{ approved: boolean }>(`/api/owner/devices/${id}/approve`, { method: 'POST', body: '{}' });
export const adminRevokeDevice = (id: string) => request<{ revoked: boolean }>(`/api/owner/devices/${id}/revoke`, { method: 'POST', body: '{}' });
export const adminProvisionToken = (id: string) => request<{ provisioningToken: string; expiresAt: string; setupPayload: string; qrSvg: string; message: string }>(`/api/owner/devices/${id}/provision-token`, { method: 'POST', body: '{}' });
export const adminRotateKey = (id: string) => request<{ apiKey: string; message: string }>(`/api/owner/devices/${id}/rotate-key`, { method: 'POST', body: '{}' });
export const adminCreateCommand = (id: string, action: string) => request<{ command: { id: string; action: string; issuedAt: string; expiresAt: string; status: string }; message: string }>(`/api/owner/devices/${id}/commands`, { method: 'POST', body: JSON.stringify({ action }) });
export const adminListCommands = (id: string) => request<{ commands: Array<Record<string, unknown>> }>(`/api/owner/devices/${id}/commands`);
export const adminRegisterDevice = (input: { id: string; name: string; kind: string; zoneId: string }) =>
  request<{ device: { id: string; approvalState: string }; message: string }>('/api/owner/devices', { method: 'POST', body: JSON.stringify(input) });

export const adminFloodEvents = (limit = 50) => request<{ events: Array<Record<string, unknown>> }>(`/api/owner/flood-events?limit=${limit}`);
export const adminThresholds = () => request<{ config: Record<string, number> }>('/api/owner/settings/thresholds');
export const adminSaveThresholds = (config: Record<string, number>) => request<{ saved: boolean }>('/api/owner/settings/thresholds', { method: 'PUT', body: JSON.stringify(config) });
export const adminAutomation = () => request<{ policy: Record<string, boolean> }>('/api/owner/settings/automation');
export const adminSaveAutomation = (policy: Record<string, boolean>) => request<{ saved: boolean }>('/api/owner/settings/automation', { method: 'PUT', body: JSON.stringify(policy) });
export const adminFeatures = () => request<{ flags: Record<string, boolean> }>('/api/owner/settings/features');
export const adminSaveFeatures = (flags: Record<string, boolean>) => request<{ saved: boolean }>('/api/owner/settings/features', { method: 'PUT', body: JSON.stringify(flags) });
export const adminMaintenance = (enabled: boolean, note: string) => request<{ saved: boolean }>('/api/owner/maintenance', { method: 'POST', body: JSON.stringify({ enabled, note }) });
export const adminEmergency = (emergency: boolean, message: string) => request<{ saved: boolean }>('/api/owner/emergency-status', { method: 'POST', body: JSON.stringify({ emergency, message }) });
export const adminServiceAreas = () => request<{ serviceAreas: ServiceArea[] }>('/api/owner/service-areas');
export const adminAddServiceArea = (input: { countryCode: string; countryName: string; cityName: string }) => request<{ serviceArea: ServiceArea }>('/api/owner/service-areas', { method: 'POST', body: JSON.stringify(input) });
export const adminToggleServiceArea = (id: string, enabled: boolean) => request<{ saved: boolean }>(`/api/owner/service-areas/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });

export interface ContentBlock { type: string; [key: string]: unknown }
export interface ContentRevisionView {
  id: string; slug: string; locale: string; title: string;
  content: { blocks: ContentBlock[] }; status: string; createdAt: string; publishedAt: string | null;
}
export const adminContent = (slug: string) => request<{ revisions: ContentRevisionView[] }>(`/api/owner/content/${slug}`);
export const adminSaveDraft = (slug: string, title: string, blocks: ContentBlock[]) =>
  request<{ revision: ContentRevisionView }>(`/api/owner/content/${slug}/draft`, { method: 'POST', body: JSON.stringify({ title, document: { blocks } }) });
export const adminPublish = (slug: string, revisionId: string) => request<{ revision: ContentRevisionView }>(`/api/owner/content/${slug}/publish`, { method: 'POST', body: JSON.stringify({ revisionId }) });
export const adminRollback = (slug: string, revisionId: string) => request<{ revision: ContentRevisionView }>(`/api/owner/content/${slug}/rollback`, { method: 'POST', body: JSON.stringify({ revisionId }) });

export const opsStatus = () => request<{ opsConsoleAvailable: boolean; securityMailboxConfigured: boolean; credentialRotationMinutes: number; deliveredTo: string | null; sessionActive: boolean }>('/api/ops/status');
export const opsUnlock = (code: string) => request<{ unlocked: boolean; expiresAt: string }>('/api/ops/unlock', { method: 'POST', body: JSON.stringify({ code }) });
export const opsLock = () => request<{ locked: boolean }>('/api/ops/lock', { method: 'POST', body: '{}' });
export const opsDeployment = () => request<Record<string, unknown>>('/api/ops/deployment');
export const opsAudit = (limit = 100) => request<{ audit: Array<Record<string, unknown>> }>(`/api/ops/audit?limit=${limit}`);
