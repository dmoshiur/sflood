import crypto from 'node:crypto';
import type { Request } from 'express';
import ipaddr from 'ipaddr.js';

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function safeEqualHex(a: string, b: string) {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function isIpAllowedByCidr(address: string, list: string | undefined) {
  const cidrs = (list || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!cidrs.length) return false;
  try {
    const client = ipaddr.process(address);
    return cidrs.some((cidr) => {
      try {
        const [range, prefix] = ipaddr.parseCIDR(cidr);
        return client.kind() === range.kind() && client.match(range, prefix);
      } catch { return false; }
    });
  } catch { return false; }
}

/** Push subscription endpoints must be HTTPS on known browser push services. */
export function isTrustedPushEndpoint(value: string) {
  try {
    const endpoint = new URL(value);
    const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
    if (endpoint.protocol !== 'https:' || (endpoint.port && endpoint.port !== '443') || ipaddr.isValid(host)) return false;
    return host === 'fcm.googleapis.com'
      || host === 'android.googleapis.com'
      || host === 'web.push.apple.com'
      || host.endsWith('.push.apple.com')
      || host === 'push.services.mozilla.com'
      || host.endsWith('.push.services.mozilla.com');
  } catch { return false; }
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || '';
}

/** Extract the Bearer device key from a request. */
export function bearerToken(req: Request): string {
  const authorization = req.header('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}
