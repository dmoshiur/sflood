import type { DashboardPayload, TelemetryPoint } from '../shared/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('The FloodGuard API returned an unreadable response.'); }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : 'The request could not be completed.';
    throw new Error(message);
  }
  return body as T;
}

export const getDashboard = () => request<DashboardPayload>('/api/dashboard');
export const getHistory = (limit = 100) => request<{ history: TelemetryPoint[]; mode: string }>(`/api/history?limit=${limit}`);
export const getDevices = () => request<{ devices: DashboardPayload['devices']; mode: string }>('/api/devices');
export const simulate = (action: 'rise' | 'recede' | 'sensor-fault' | 'sensor-recovered' | 'estop' | 'estop-reset' | 'reset') =>
  request<{ dashboard: DashboardPayload; message: string }>('/api/demo/simulate', { method: 'POST', body: JSON.stringify({ action }) });

export function formatTime(value: string | Date, options?: Intl.DateTimeFormatOptions) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(undefined, options || { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function timeAgo(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${hours === 1 ? '' : 's'} ago`;
}
