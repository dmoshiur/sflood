import ipaddr from 'ipaddr.js';

/**
 * Web Push endpoint validation.
 *
 * Only HTTPS endpoints on known browser push services are accepted. This blocks
 * server-side request forgery attempts where a crafted "subscription" would make
 * the server POST to an arbitrary internal address.
 */

const ALLOWED_EXACT = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'web.push.apple.com',
  'push.services.mozilla.com',
  'updates.push.services.mozilla.com',
]);

const ALLOWED_SUFFIXES = ['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];

export function isTrustedPushEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:') return false;
    if (endpoint.port && endpoint.port !== '443') return false;
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
    const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || ipaddr.isValid(host)) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (ALLOWED_EXACT.has(host)) return true;
    return ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}
