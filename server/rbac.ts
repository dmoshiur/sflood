import type { RequestHandler } from 'express';
import { queryOne, rowText } from './database.js';

/**
 * Server-side authorization.
 *
 * Roles (stored in users.role):
 *   MEMBER   - registered member of the public inside a service area
 *   OPERATOR - local operator, read/ack inside an assigned site
 *   ADMIN    - local admin, scoped to an assigned city/site
 *   OWNER    - super admin, tenant-wide
 *
 * Every authorization decision is made here, from database state. Hiding UI
 * controls is never treated as access control.
 */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'MEMBER' | 'OPERATOR' | 'ADMIN' | 'OWNER';
  tenantId: string;
  cityId: string | null;
  zoneId: string | null;
  serviceAreaId: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  totpEnrolled: boolean;
  mfaVerified: boolean;
  sessionId: string;
  disabled: boolean;
}

export function authUserOf(res: { locals: Record<string, unknown> }): AuthUser {
  return res.locals.authUser as AuthUser;
}

export function isSuperAdmin(user: AuthUser | undefined | null): boolean {
  return Boolean(user && user.role === 'OWNER');
}

export function isLocalAdmin(user: AuthUser | undefined | null): boolean {
  return Boolean(user && (user.role === 'ADMIN' || user.role === 'OWNER'));
}

export function isOperatorOrAbove(user: AuthUser | undefined | null): boolean {
  return Boolean(user && ['OPERATOR', 'ADMIN', 'OWNER'].includes(user.role));
}

/** Super admin: tenant-wide. Local admin: only inside the assigned city/site. */
export function inAdminScope(user: AuthUser, scope: { cityId?: string | null; zoneId?: string | null }): boolean {
  if (isSuperAdmin(user)) return true;
  if (!isLocalAdmin(user)) return false;
  if (scope.zoneId && user.zoneId) return user.zoneId === scope.zoneId;
  if (scope.cityId && user.cityId) return user.cityId === scope.cityId;
  if (user.zoneId || user.cityId) return false;
  return true;
}

export async function canAccessZone(user: AuthUser, zoneId: string | null): Promise<boolean> {
  if (!zoneId) return isSuperAdmin(user);
  if (isSuperAdmin(user)) return true;
  if (user.zoneId) return user.zoneId === zoneId;
  if (user.cityId) return zoneBelongsToCity(zoneId, user.cityId);
  return false;
}

async function zoneBelongsToCity(zoneId: string, cityId: string): Promise<boolean> {
  const row = await queryOne('SELECT city_id FROM zones WHERE id=?', [zoneId]);
  return Boolean(row) && rowText(row as Record<string, unknown>, 'city_id') === cityId;
}

export const requireRole = (...roles: Array<AuthUser['role']>): RequestHandler => (_req, res, next) => {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user) { res.status(401).json({ error: 'Sign in to continue.' }); return; }
  if (!roles.includes(user.role)) { res.status(403).json({ error: 'Your account role does not allow this action.' }); return; }
  next();
};

/** Requires a local admin (or super admin) whose scope covers the requested site. */
export const requireSiteAdmin: RequestHandler = (req, res, next) => {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user) { res.status(401).json({ error: 'Sign in to continue.' }); return; }
  if (!isLocalAdmin(user)) { res.status(403).json({ error: 'This action requires an admin role.' }); return; }
  if (!user.mfaVerified) { res.status(403).json({ error: 'Verify your authenticator code before using admin controls.', code: 'MFA_REQUIRED' }); return; }
  const cityId = typeof req.body?.cityId === 'string' ? req.body.cityId : typeof req.query?.cityId === 'string' ? req.query.cityId : null;
  const zoneId = typeof req.body?.zoneId === 'string' ? req.body.zoneId : typeof req.query?.zoneId === 'string' ? req.query.zoneId : null;
  if ((cityId || zoneId) && !inAdminScope(user, { cityId, zoneId })) {
    res.status(403).json({ error: 'This site is outside your assigned area.' }); return;
  }
  next();
};

export const requireSuperAdmin: RequestHandler = (_req, res, next) => {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user) { res.status(401).json({ error: 'Sign in to continue.' }); return; }
  if (!isSuperAdmin(user)) { res.status(403).json({ error: 'This action requires the super-admin role.' }); return; }
  if (!user.mfaVerified) { res.status(403).json({ error: 'Verify your authenticator code before using super-admin controls.', code: 'MFA_REQUIRED' }); return; }
  next();
};

/** Barrier commands may be issued by operators and above, scoped to their site. */
export function canCommandBarrier(user: AuthUser, scope: { zoneId: string | null; cityId: string | null }): boolean {
  if (!isOperatorOrAbove(user)) return false;
  return inAdminScope(user, scope);
}

export function canManageDevice(user: AuthUser, device: { zoneId: string | null; cityId: string | null }): boolean {
  return isLocalAdmin(user) && inAdminScope(user, { zoneId: device.zoneId, cityId: device.cityId });
}
