import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import {
  allFeatureFlags, currentTimestamp, execute, getSiteSetting, insertAudit, primaryTenantId, queryAll, queryOne,
  randomId, rowBoolean, rowNullableNumber, rowNumber, rowText, setFeatureFlag, setSiteSetting, tableCounts,
} from '../database.js';
import { requireCsrf, requireSession, listUsers, countActiveOwners } from '../auth.js';
import { inAdminScope, isLocalAdmin, isSuperAdmin, type AuthUser } from '../rbac.js';
import { createServiceArea, listServiceAreas, updateServiceArea } from '../service-areas.js';
import { deviceListWithScope } from '../devices.js';
import { setMaintenanceMode } from '../notifications.js';
import {
  getSavedProvider, providerSummary, recordProviderTest, saveProvider, validateProviderInput, verifySmsProvider, verifySmtpProvider,
} from '../providers.js';
import { commandStats } from '../commands.js';
import { asyncHandler, clientIp, fail, forbidden } from '../http.js';

/**
 * Admin console API.
 *
 * Two tiers, both enforced server-side:
 *   - super admin (OWNER): tenant-wide control of users, service areas, devices,
 *     thresholds, automation, templates, subscribers, settings, reports and audit
 *   - local admin (ADMIN): scoped to the assigned city/site; sees only the users,
 *     devices, manual records and reports for that scope
 */

export const adminRouter = express.Router();

adminRouter.use(requireSession);
adminRouter.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));

function scopeFilter(user: AuthUser): { cityId?: string; zoneId?: string } {
  if (isSuperAdmin(user)) return {};
  return user.zoneId ? { zoneId: user.zoneId } : user.cityId ? { cityId: user.cityId } : {};
}

async function deliverySummary(scope: { cityId?: string; zoneId?: string }) {
  const clauses: string[] = [];
  const args: string[] = [];
  if (scope.zoneId) { clauses.push('zone_id=?'); args.push(scope.zoneId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await queryAll(`SELECT status, COUNT(*) AS count FROM notification_deliveries ${where} GROUP BY status`, args);
  const summary: Record<string, number> = {};
  for (const row of rows) summary[rowText(row, 'status')] = rowNumber(row, 'count');
  return summary;
}

adminRouter.get('/overview', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const scope = scopeFilter(user);
  const [counts, flags, maintenance, deliveries, commands] = await Promise.all([
    tableCounts(), allFeatureFlags(), getSiteSetting('maintenance_mode', false), deliverySummary(scope), commandStats(),
  ]);
  const devices = await deviceListWithScope(user.tenantId);
  const scopedDevices = isSuperAdmin(user) ? devices : devices.filter((device) => inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId }));
  const events = await queryAll('SELECT * FROM flood_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT 12', [user.tenantId]);
  res.json({
    role: user.role,
    scope,
    counts,
    flags,
    maintenanceMode: Boolean(maintenance),
    mode: config.isLocalDatabase ? 'local-database' : 'turso',
    devices: scopedDevices.map((device) => ({
      id: device.id, uid: device.uid, name: device.name, board: device.board, approvalState: device.approvalState,
      enabled: device.enabled, health: device.health, simulation: device.simulation, currentState: device.currentState,
      barrierState: device.barrierState, zoneName: device.zoneName, cityName: device.cityName, lastSeenAt: device.lastSeenAt,
    })),
    events: events.map((row) => ({
      id: rowText(row, 'id'), deviceId: rowText(row, 'device_id'), zoneId: rowText(row, 'zone_id'),
      fromState: rowText(row, 'from_state'), toState: rowText(row, 'to_state'),
      levelCm: rowNullableNumber(row, 'level_cm'), reason: rowText(row, 'reason'),
      simulated: rowBoolean(row, 'simulated'), acknowledgedAt: rowText(row, 'acknowledged_at') || null,
      createdAt: rowText(row, 'created_at'),
    })),
    deliveries, commands,
  });
}));

/* ------------------------------- users ------------------------------- */

adminRouter.get('/users', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  let users = await listUsers(user.tenantId, 300);
  if (!isSuperAdmin(user)) users = users.filter((item) => inAdminScope(user, { cityId: item.cityId, zoneId: item.zoneId }));
  res.json({ users });
}));

const userPatchSchema = z.object({
  role: z.enum(['MEMBER', 'OPERATOR', 'ADMIN', 'OWNER']).optional(),
  disabled: z.boolean().optional(),
  zoneId: z.string().max(64).nullable().optional(),
  cityId: z.string().max(64).nullable().optional(),
});

adminRouter.patch('/users/:userId', requireCsrf, asyncHandler(async (req, res) => {
  const actor = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(actor)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = userPatchSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Choose a valid role, scope or enabled state.'); return; }
  const targetId = String(req.params.userId);
  const target = await queryOne('SELECT * FROM users WHERE id=?', [targetId]);
  if (!target || rowText(target, 'tenant_id') !== actor.tenantId) { fail(res, 404, 'Account not found.'); return; }
  if (parsed.data.role === 'OWNER' && !isSuperAdmin(actor)) { forbidden(res, 'Only a super admin can grant the super-admin role.'); return; }
  if (rowText(target, 'role') === 'OWNER' && !isSuperAdmin(actor)) { forbidden(res, 'Only a super admin can change another super admin.'); return; }
  if (targetId === actor.id && (parsed.data.disabled || (parsed.data.role && parsed.data.role !== 'OWNER'))) {
    fail(res, 400, 'You cannot disable or demote your own account.'); return;
  }
  if (parsed.data.role === 'ADMIN' && parsed.data.zoneId === undefined && parsed.data.cityId === undefined) {
    fail(res, 400, 'A local admin must be assigned a city or site.'); return;
  }
  if (parsed.data.zoneId || parsed.data.cityId) {
    if (!isSuperAdmin(actor) && !inAdminScope(actor, { cityId: parsed.data.cityId ?? null, zoneId: parsed.data.zoneId ?? null })) {
      forbidden(res, 'You cannot assign a scope outside your own area.'); return;
    }
  }
  const now = currentTimestamp();
  if (parsed.data.role) await execute('UPDATE users SET role=? WHERE id=?', [parsed.data.role, targetId]);
  if (parsed.data.zoneId !== undefined) await execute('UPDATE users SET zone_id=? WHERE id=?', [parsed.data.zoneId, targetId]);
  if (parsed.data.cityId !== undefined) await execute('UPDATE users SET city_id=? WHERE id=?', [parsed.data.cityId, targetId]);
  if (parsed.data.disabled !== undefined) {
    if (parsed.data.disabled && rowText(target, 'role') === 'OWNER' && (await countActiveOwners()) <= 1) {
      fail(res, 409, 'The last active super admin cannot be disabled.'); return;
    }
    await execute('UPDATE users SET disabled_at=? WHERE id=?', [parsed.data.disabled ? now : null, targetId]);
    if (parsed.data.disabled) await execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now, targetId]);
  }
  await insertAudit({ tenantId: actor.tenantId, actorId: actor.id, action: 'ADMIN_USER_UPDATED', targetType: 'user', targetId, metadata: parsed.data, ipAddress: req.ip });
  res.json({ updated: true, message: 'Account updated.' });
}));

adminRouter.post('/users/:userId/mfa-reset', requireCsrf, asyncHandler(async (req, res) => {
  const actor = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(actor)) { forbidden(res, 'This action requires an admin role.'); return; }
  const targetId = String(req.params.userId);
  const target = await queryOne('SELECT id,tenant_id,role FROM users WHERE id=?', [targetId]);
  if (!target || rowText(target, 'tenant_id') !== actor.tenantId) { fail(res, 404, 'Account not found.'); return; }
  if (rowText(target, 'role') === 'OWNER' && !isSuperAdmin(actor)) { forbidden(res, 'Only a super admin can reset another super admin MFA.'); return; }
  const now = currentTimestamp();
  await execute('UPDATE users SET totp_secret_enc=NULL,totp_pending_enc=NULL,totp_pending_expires_at=NULL WHERE id=?', [targetId]);
  await execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now, targetId]);
  await insertAudit({ tenantId: actor.tenantId, actorId: actor.id, action: 'ADMIN_USER_MFA_RESET', targetType: 'user', targetId, ipAddress: req.ip });
  res.json({ reset: true, message: 'MFA was reset and every session for that account was revoked.' });
}));

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(2).max(100),
  role: z.enum(['ADMIN', 'OPERATOR']),
  zoneId: z.string().max(64).optional(),
  cityId: z.string().max(64).optional(),
});

adminRouter.post('/invites', requireCsrf, asyncHandler(async (req, res) => {
  const actor = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(actor)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Enter an email, display name, role and site scope.'); return; }
  if (parsed.data.role === 'ADMIN' && !parsed.data.zoneId && !parsed.data.cityId) {
    fail(res, 400, 'A local admin invitation must include a city or site.'); return;
  }
  if (!isSuperAdmin(actor) && !inAdminScope(actor, { cityId: parsed.data.cityId ?? null, zoneId: parsed.data.zoneId ?? null })) {
    forbidden(res, 'You cannot invite staff outside your own area.'); return;
  }
  const existing = await queryOne('SELECT id FROM users WHERE email=? LIMIT 1', [parsed.data.email]);
  if (existing) { fail(res, 409, 'That email already has an account.'); return; }
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const now = currentTimestamp();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60_000).toISOString();
  const inviteId = randomId();
  const { hashToken } = await import('../security.js');
  await execute(
    'INSERT INTO admin_invites(id,tenant_id,email,display_name,role,city_id,zone_id,token_hash,invited_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [inviteId, actor.tenantId, parsed.data.email, parsed.data.displayName, parsed.data.role, parsed.data.cityId || null, parsed.data.zoneId || null, hashToken(rawToken), actor.id, expiresAt, now],
  );
  await insertAudit({
    tenantId: actor.tenantId, actorId: actor.id, action: 'ADMIN_INVITE_CREATED', targetType: 'invite', targetId: inviteId,
    metadata: { email: parsed.data.email, role: parsed.data.role, zoneId: parsed.data.zoneId || null }, ipAddress: req.ip,
  });
  let inviteUrl: string | null = null;
  if (config.publicAppUrl) {
    const url = new URL('/accept-invite', config.publicAppUrl);
    url.searchParams.set('invite', rawToken);
    inviteUrl = url.toString();
  }
  res.status(201).json({ inviteId, inviteUrl, expiresAt, message: 'Invitation created. Send the link through a secure channel; it is shown only once.' });
}));

adminRouter.get('/invites', asyncHandler(async (_req, res) => {
  const actor = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(actor)) { forbidden(res, 'This action requires an admin role.'); return; }
  const rows = await queryAll('SELECT * FROM admin_invites WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50', [actor.tenantId]);
  res.json({
    invites: rows.map((row) => ({
      id: rowText(row, 'id'), email: rowText(row, 'email'), displayName: rowText(row, 'display_name'),
      role: rowText(row, 'role'), zoneId: rowText(row, 'zone_id') || null, cityId: rowText(row, 'city_id') || null,
      expiresAt: rowText(row, 'expires_at'), used: Boolean(rowText(row, 'used_at')), createdAt: rowText(row, 'created_at'),
    })),
  });
}));

/* ---------------------------- service areas ---------------------------- */

adminRouter.get('/service-areas', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  res.json({ serviceAreas: await listServiceAreas(true) });
}));

const serviceAreaSchema = z.object({
  city: z.string().trim().min(2).max(100),
  region: z.string().trim().max(100).optional().default(''),
  country: z.string().trim().min(2).max(100),
  countryCode: z.string().trim().length(2),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  enabled: z.boolean().optional().default(true),
  requiresReview: z.boolean().optional().default(false),
  notes: z.string().max(500).optional().default(''),
});

adminRouter.post('/service-areas', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isSuperAdmin(user)) { forbidden(res, 'Only a super admin can add service areas.'); return; }
  const parsed = serviceAreaSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Enter a city, country and two-letter country code.'); return; }
  const area = await createServiceArea({ tenantId: user.tenantId, ...parsed.data, countryCode: parsed.data.countryCode.toUpperCase() });
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SERVICE_AREA_CREATED', targetType: 'service_area', targetId: area.id, metadata: { city: area.city, country: area.country }, ipAddress: req.ip });
  res.status(201).json({ serviceArea: area });
}));

adminRouter.patch('/service-areas/:areaId', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isSuperAdmin(user)) { forbidden(res, 'Only a super admin can change service areas.'); return; }
  const parsed = serviceAreaSchema.partial().safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the service area values.'); return; }
  const area = await updateServiceArea(String(req.params.areaId), parsed.data);
  if (!area) { fail(res, 404, 'Service area not found.'); return; }
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SERVICE_AREA_UPDATED', targetType: 'service_area', targetId: area.id, metadata: parsed.data, ipAddress: req.ip });
  res.json({ serviceArea: area });
}));

/* ------------------------------ thresholds ----------------------------- */

const policySchema = z.object({
  name: z.string().trim().min(2).max(80),
  zoneId: z.string().max(64).nullable().optional(),
  scope: z.enum(['TENANT', 'ZONE']).optional().default('ZONE'),
  normalBelowCm: z.number().min(0).max(1000),
  watchCm: z.number().min(0).max(1000),
  warningCm: z.number().min(0).max(1000),
  criticalCm: z.number().min(0).max(1000),
  rateOfRiseCmPerMin: z.number().min(0).max(1000),
  hysteresisCm: z.number().min(0).max(100),
  recoveryCm: z.number().min(0).max(1000),
  recoveryHoldSeconds: z.number().int().min(0).max(86_400),
  cooldownSeconds: z.number().int().min(0).max(86_400),
  confirmationSamples: z.number().int().min(1).max(10),
  confirmationWindowSeconds: z.number().int().min(10).max(86_400),
  autoBarrierStates: z.array(z.enum(['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY'])).min(0),
  barrierRecoveryState: z.enum(['NORMAL', 'RECOVERY']),
  notifyChannels: z.array(z.enum(['IN_APP', 'EMAIL', 'SMS', 'WEB_PUSH'])).min(1),
  notifyRecovery: z.boolean().optional().default(true),
  enabled: z.boolean().optional().default(true),
});

adminRouter.get('/policies', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  let rows = await queryAll('SELECT * FROM flood_policies WHERE tenant_id=? ORDER BY scope DESC, created_at ASC', [user.tenantId]);
  if (!isSuperAdmin(user)) rows = rows.filter((row) => !rowText(row, 'zone_id') || inAdminScope(user, { zoneId: rowText(row, 'zone_id') }));
  res.json({
    policies: rows.map((row) => ({
      id: rowText(row, 'id'), name: rowText(row, 'name'), scope: rowText(row, 'scope', 'ZONE'), zoneId: rowText(row, 'zone_id') || null,
      normalBelowCm: rowNumber(row, 'normal_below_cm'), watchCm: rowNumber(row, 'watch_cm'), warningCm: rowNumber(row, 'warning_cm'),
      criticalCm: rowNumber(row, 'critical_cm'), rateOfRiseCmPerMin: rowNumber(row, 'rate_of_rise_cm_per_min'),
      hysteresisCm: rowNumber(row, 'hysteresis_cm'), recoveryCm: rowNumber(row, 'recovery_cm'),
      recoveryHoldSeconds: rowNumber(row, 'recovery_hold_seconds'), cooldownSeconds: rowNumber(row, 'cooldown_seconds'),
      confirmationSamples: rowNumber(row, 'confirmation_samples'), confirmationWindowSeconds: rowNumber(row, 'confirmation_window_seconds'),
      autoBarrierStates: rowText(row, 'auto_barrier_states').split(',').filter(Boolean),
      barrierRecoveryState: rowText(row, 'barrier_recovery_state', 'RECOVERY'),
      notifyChannels: rowText(row, 'notify_channels').split(',').filter(Boolean),
      notifyRecovery: rowBoolean(row, 'notify_recovery'), enabled: rowBoolean(row, 'enabled'),
      updatedAt: rowText(row, 'updated_at'),
    })),
  });
}));

adminRouter.post('/policies', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the threshold values: normal < watch < warning < critical.'); return; }
  const data = parsed.data;
  if (!(data.normalBelowCm < data.watchCm && data.watchCm < data.warningCm && data.warningCm < data.criticalCm)) {
    fail(res, 400, 'Thresholds must increase: normal < watch < warning < critical.'); return;
  }
  if (data.recoveryCm >= data.watchCm) { fail(res, 400, 'The recovery threshold must be below the watch threshold.'); return; }
  if (data.zoneId && !inAdminScope(user, { zoneId: data.zoneId })) { forbidden(res, 'That zone is outside your assigned area.'); return; }
  const now = currentTimestamp();
  const id = randomId();
  await execute(
    `INSERT INTO flood_policies(id,tenant_id,zone_id,scope,name,normal_below_cm,watch_cm,warning_cm,critical_cm,rate_of_rise_cm_per_min,hysteresis_cm,recovery_cm,recovery_hold_seconds,cooldown_seconds,confirmation_samples,confirmation_window_seconds,auto_barrier_states,barrier_recovery_state,notify_channels,notify_recovery,enabled,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, user.tenantId, data.zoneId || null, data.zoneId ? 'ZONE' : 'TENANT', data.name, data.normalBelowCm, data.watchCm, data.warningCm, data.criticalCm,
      data.rateOfRiseCmPerMin, data.hysteresisCm, data.recoveryCm, data.recoveryHoldSeconds, data.cooldownSeconds,
      data.confirmationSamples, data.confirmationWindowSeconds, data.autoBarrierStates.join(','), data.barrierRecoveryState,
      data.notifyChannels.join(','), data.notifyRecovery ? 1 : 0, data.enabled ? 1 : 0, now, now],
  );
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'FLOOD_POLICY_CREATED', targetType: 'policy', targetId: id, metadata: { name: data.name, zoneId: data.zoneId || null }, ipAddress: req.ip });
  res.status(201).json({ id, message: 'Flood policy saved. New telemetry is evaluated against it immediately.' });
}));

adminRouter.put('/policies/:policyId', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const existing = await queryOne('SELECT * FROM flood_policies WHERE id=?', [String(req.params.policyId)]);
  if (!existing || rowText(existing, 'tenant_id') !== user.tenantId) { fail(res, 404, 'Policy not found.'); return; }
  const parsed = policySchema.partial().safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the threshold values.'); return; }
  const merged = { ...existing, ...parsed.data } as Record<string, unknown>;
  if (!(Number(merged.normal_below_cm) < Number(merged.watch_cm) && Number(merged.watch_cm) < Number(merged.warning_cm) && Number(merged.warning_cm) < Number(merged.critical_cm))) {
    fail(res, 400, 'Thresholds must increase: normal < watch < warning < critical.'); return;
  }
  await execute(
    `UPDATE flood_policies SET name=?,normal_below_cm=?,watch_cm=?,warning_cm=?,critical_cm=?,rate_of_rise_cm_per_min=?,hysteresis_cm=?,
      recovery_cm=?,recovery_hold_seconds=?,cooldown_seconds=?,confirmation_samples=?,confirmation_window_seconds=?,auto_barrier_states=?,
      barrier_recovery_state=?,notify_channels=?,notify_recovery=?,enabled=?,updated_at=? WHERE id=?`,
    [String(merged.name), Number(merged.normal_below_cm), Number(merged.watch_cm), Number(merged.warning_cm), Number(merged.critical_cm),
      Number(merged.rate_of_rise_cm_per_min), Number(merged.hysteresis_cm), Number(merged.recovery_cm), Number(merged.recovery_hold_seconds),
      Number(merged.cooldown_seconds), Number(merged.confirmation_samples), Number(merged.confirmation_window_seconds),
      String(merged.auto_barrier_states), String(merged.barrier_recovery_state), String(merged.notify_channels),
      merged.notify_recovery ? 1 : 0, merged.enabled ? 1 : 0, currentTimestamp(), String(req.params.policyId)],
  );
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'FLOOD_POLICY_UPDATED', targetType: 'policy', targetId: String(req.params.policyId), metadata: parsed.data, ipAddress: req.ip });
  res.json({ updated: true, message: 'Policy updated.' });
}));

/* ---------------------------- subscribers ---------------------------- */

adminRouter.get('/subscribers', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const scope = scopeFilter(user);
  const emailArgs: string[] = [user.tenantId];
  const emailWhere = ['tenant_id=?'];
  if (scope.zoneId) { emailWhere.push('zone_id=?'); emailArgs.push(scope.zoneId); }
  const emails = await queryAll(`SELECT * FROM email_subscribers WHERE ${emailWhere.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, emailArgs);
  const push = scope.zoneId
    ? await queryAll('SELECT id,zone_id,endpoint,consent_at,unsubscribed_at FROM push_subscriptions WHERE zone_id=? ORDER BY created_at DESC LIMIT 200', [scope.zoneId])
    : await queryAll('SELECT id,zone_id,endpoint,consent_at,unsubscribed_at FROM push_subscriptions ORDER BY created_at DESC LIMIT 200');
  const users = (await listUsers(user.tenantId, 300)).filter((item) => item.emailVerified);
  res.json({
    emailSubscribers: emails.map((row) => ({
      id: rowText(row, 'id'), email: rowText(row, 'email'), zoneId: rowText(row, 'zone_id'),
      verified: Boolean(rowText(row, 'verified_at')), unsubscribed: Boolean(rowText(row, 'unsubscribed_at')),
      source: rowText(row, 'source'), createdAt: rowText(row, 'created_at'),
    })),
    pushSubscriptions: push.map((row) => ({
      id: rowText(row, 'id'), zoneId: rowText(row, 'zone_id'), endpoint: rowText(row, 'endpoint').slice(0, 90),
      active: !rowText(row, 'unsubscribed_at'), consentAt: rowText(row, 'consent_at'),
    })),
    registeredUsers: users.map((item) => ({ id: item.id, email: item.email, displayName: item.displayName, role: item.role, zoneId: item.zoneId, cityId: item.cityId, serviceCity: item.serviceCity })),
  });
}));

/* --------------------------- manual records --------------------------- */

const manualRecordSchema = z.object({
  zoneId: z.string().max(64).optional(),
  deviceId: z.string().max(64).optional(),
  kind: z.enum(['OBSERVATION', 'INSPECTION', 'CALIBRATION', 'INCIDENT', 'MAINTENANCE']).optional().default('OBSERVATION'),
  levelCm: z.number().min(0).max(2000).nullable().optional(),
  note: z.string().trim().min(2).max(2000),
});

adminRouter.post('/records', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = manualRecordSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Add a note and, optionally, a measured level.'); return; }
  const zoneId = parsed.data.zoneId || user.zoneId;
  if (zoneId && !inAdminScope(user, { zoneId })) { forbidden(res, 'That zone is outside your assigned area.'); return; }
  const id = randomId();
  await execute(
    'INSERT INTO manual_records(id,tenant_id,zone_id,device_id,kind,level_cm,note,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, user.tenantId, zoneId || null, parsed.data.deviceId || null, parsed.data.kind, parsed.data.levelCm ?? null, parsed.data.note, user.id, currentTimestamp()],
  );
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'MANUAL_RECORD_CREATED', targetType: 'manual_record', targetId: id, metadata: { kind: parsed.data.kind, zoneId: zoneId || null }, ipAddress: req.ip });
  res.status(201).json({ id, message: 'Manual record saved.' });
}));

adminRouter.get('/records', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const scope = scopeFilter(user);
  const args: string[] = [user.tenantId];
  const where = ['tenant_id=?'];
  if (scope.zoneId) { where.push('zone_id=?'); args.push(scope.zoneId); }
  const rows = await queryAll(`SELECT * FROM manual_records WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`, args);
  res.json({
    records: rows.map((row) => ({
      id: rowText(row, 'id'), zoneId: rowText(row, 'zone_id') || null, deviceId: rowText(row, 'device_id') || null,
      kind: rowText(row, 'kind'), levelCm: rowNullableNumber(row, 'level_cm'), note: rowText(row, 'note'),
      recordedBy: rowText(row, 'recorded_by') || null, createdAt: rowText(row, 'created_at'),
    })),
  });
}));

/* ------------------------------ templates ----------------------------- */

const templateSchema = z.object({
  templateKey: z.string().trim().min(2).max(60),
  channel: z.enum(['EMAIL', 'SMS', 'WEB_PUSH', 'IN_APP']),
  state: z.string().trim().min(2).max(20).default('ANY'),
  subject: z.string().trim().max(180).default(''),
  body: z.string().trim().min(2).max(4000),
  enabled: z.boolean().optional().default(true),
});

adminRouter.get('/templates', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const rows = await queryAll('SELECT * FROM notification_templates WHERE tenant_id=? ORDER BY template_key, channel', [user.tenantId]);
  res.json({
    templates: rows.map((row) => ({
      id: rowText(row, 'id'), templateKey: rowText(row, 'template_key'), channel: rowText(row, 'channel'),
      state: rowText(row, 'state'), subject: rowText(row, 'subject'), body: rowText(row, 'body'),
      enabled: rowBoolean(row, 'enabled'), updatedAt: rowText(row, 'updated_at'),
    })),
  });
}));

adminRouter.post('/templates', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the template fields.'); return; }
  const id = randomId();
  await execute(
    `INSERT INTO notification_templates(id,tenant_id,template_key,channel,state,subject,body,enabled,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,template_key,channel,state) DO UPDATE SET subject=excluded.subject,body=excluded.body,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    [id, user.tenantId, parsed.data.templateKey, parsed.data.channel, parsed.data.state, parsed.data.subject, parsed.data.body, parsed.data.enabled ? 1 : 0, user.id, currentTimestamp()],
  );
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'NOTIFICATION_TEMPLATE_SAVED', targetType: 'template', targetId: id, ipAddress: req.ip });
  res.status(201).json({ id, message: 'Template saved.' });
}));

adminRouter.put('/templates/:templateId', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = templateSchema.partial().safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the template fields.'); return; }
  const existing = await queryOne('SELECT * FROM notification_templates WHERE id=? AND tenant_id=?', [String(req.params.templateId), user.tenantId]);
  if (!existing) { fail(res, 404, 'Template not found.'); return; }
  const merged = { ...existing, ...parsed.data } as Record<string, unknown>;
  await execute('UPDATE notification_templates SET subject=?,body=?,enabled=?,updated_by=?,updated_at=? WHERE id=?', [
    String(merged.subject), String(merged.body), merged.enabled ? 1 : 0, user.id, currentTimestamp(), String(req.params.templateId),
  ]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'NOTIFICATION_TEMPLATE_UPDATED', targetType: 'template', targetId: String(req.params.templateId), ipAddress: req.ip });
  res.json({ updated: true });
}));

/* ------------------------------ settings ------------------------------ */

adminRouter.get('/settings', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const rows = await queryAll('SELECT key,value_json,updated_at FROM site_settings ORDER BY key');
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try { settings[rowText(row, 'key')] = JSON.parse(rowText(row, 'value_json', 'null')); } catch { /* skip malformed */ }
  }
  res.json({ settings, flags: await allFeatureFlags() });
}));

adminRouter.put('/settings', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = z.object({ settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])) }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Send a settings object.'); return; }
  for (const [key, value] of Object.entries(parsed.data.settings)) {
    if (!/^[a-z0-9_]{3,60}$/.test(key)) { fail(res, 400, `Setting key ${key} is not allowed.`); return; }
    await setSiteSetting(key, value, user.id);
  }
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SITE_SETTINGS_UPDATED', targetType: 'settings', targetId: null, metadata: { keys: Object.keys(parsed.data.settings) }, ipAddress: req.ip });
  res.json({ updated: true, message: 'Site settings saved.' });
}));

adminRouter.put('/flags/:key', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isSuperAdmin(user)) { forbidden(res, 'Only a super admin can change feature flags.'); return; }
  const parsed = z.object({ enabled: z.boolean(), description: z.string().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Specify enabled as true or false.'); return; }
  await setFeatureFlag(String(req.params.key), parsed.data.enabled, parsed.data.description || '', user.id);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'FEATURE_FLAG_UPDATED', targetType: 'flag', targetId: String(req.params.key), metadata: { enabled: parsed.data.enabled }, ipAddress: req.ip });
  res.json({ flags: await allFeatureFlags(), message: `Feature flag ${String(req.params.key)} updated.` });
}));

adminRouter.post('/maintenance', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = z.object({ enabled: z.boolean(), reason: z.string().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Specify enabled and an optional reason.'); return; }
  await setMaintenanceMode(parsed.data.enabled, parsed.data.reason || 'Scheduled maintenance', user.id);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: parsed.data.enabled ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED', targetType: 'site', targetId: null, metadata: { reason: parsed.data.reason || '' }, ipAddress: req.ip });
  res.json({ maintenanceMode: parsed.data.enabled, message: parsed.data.enabled ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.' });
}));

/* ---------------------------- providers ------------------------------ */

const smtpInput = z.object({
  host: z.string().trim().min(1).max(255), port: z.coerce.number().int().min(1).max(65535), secure: z.boolean(),
  username: z.string().trim().max(255).optional().default(''), password: z.string().max(1024).optional().default(''),
  fromName: z.string().trim().min(1).max(100), fromAddress: z.string().email().max(254),
  replyTo: z.string().email().max(254).or(z.literal('')).optional().default(''), enabled: z.boolean(),
});

const smsInput = z.object({
  endpoint: z.string().url().max(2048), authHeader: z.string().trim().max(64).optional().default('Authorization'),
  authPrefix: z.string().max(40).optional().default('Bearer '), authToken: z.string().max(2048).optional().default(''),
  senderId: z.string().max(64).optional().default(''), toField: z.string().trim().max(48).optional().default('to'),
  messageField: z.string().trim().max(48).optional().default('message'), senderField: z.string().trim().max(48).optional().default('sender'),
  enabled: z.boolean(),
});

adminRouter.get('/providers', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  res.json({ providers: await providerSummary() });
}));

adminRouter.put('/providers/smtp', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isSuperAdmin(user)) { forbidden(res, 'Only a super admin can configure providers.'); return; }
  if (!user.mfaVerified) { fail(res, 403, 'Verify your authenticator code before changing provider settings.'); return; }
  const parsed = smtpInput.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the SMTP settings.'); return; }
  const previous = await getSavedProvider('SMTP');
  const providerConfig = validateProviderInput('SMTP', parsed.data, previous?.config) as Parameters<typeof saveProvider>[1];
  await saveProvider('SMTP', providerConfig, parsed.data.enabled, user.id);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMTP_PROVIDER_UPDATED', targetType: 'provider', targetId: 'SMTP', metadata: { host: parsed.data.host, port: parsed.data.port, enabled: parsed.data.enabled }, ipAddress: req.ip });
  res.json({ saved: true, providers: await providerSummary(), message: 'SMTP credentials were encrypted before storage. Saved secrets are never returned to the browser.' });
}));

adminRouter.put('/providers/sms', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isSuperAdmin(user)) { forbidden(res, 'Only a super admin can configure providers.'); return; }
  if (!user.mfaVerified) { fail(res, 403, 'Verify your authenticator code before changing provider settings.'); return; }
  const parsed = smsInput.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the SMS gateway settings.'); return; }
  const previous = await getSavedProvider('SMS_HTTP');
  const providerConfig = validateProviderInput('SMS_HTTP', parsed.data, previous?.config) as Parameters<typeof saveProvider>[1];
  await saveProvider('SMS_HTTP', providerConfig, parsed.data.enabled, user.id);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMS_PROVIDER_UPDATED', targetType: 'provider', targetId: 'SMS_HTTP', metadata: { endpointHost: new URL(parsed.data.endpoint).host, enabled: parsed.data.enabled }, ipAddress: req.ip });
  res.json({ saved: true, providers: await providerSummary(), message: 'SMS gateway credentials were encrypted before storage.' });
}));

adminRouter.post('/providers/smtp/test', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isSuperAdmin(user)) { forbidden(res, 'Only a super admin can test providers.'); return; }
  const parsed = z.object({ recipient: z.string().email().max(254) }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Enter a recipient address you control.'); return; }
  try {
    await verifySmtpProvider(parsed.data.recipient);
    await recordProviderTest('SMTP', true, 'Test message accepted by the SMTP server.');
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMTP_PROVIDER_TESTED', targetType: 'provider', targetId: 'SMTP', metadata: { recipient: parsed.data.recipient }, ipAddress: req.ip });
    res.json({ ok: true, message: 'SMTP test message accepted.' });
  } catch (error) {
    await recordProviderTest('SMTP', false, (error as Error).message);
    fail(res, 502, `SMTP test failed: ${(error as Error).message}`);
  }
}));

adminRouter.post('/providers/sms/test', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isSuperAdmin(user)) { forbidden(res, 'Only a super admin can test providers.'); return; }
  const parsed = z.object({ recipient: z.string().regex(/^\+[1-9]\d{7,14}$/) }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Enter an E.164 phone number you control.'); return; }
  try {
    await verifySmsProvider(parsed.data.recipient);
    await recordProviderTest('SMS_HTTP', true, 'Test message accepted by the SMS gateway.');
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SMS_PROVIDER_TESTED', targetType: 'provider', targetId: 'SMS_HTTP', metadata: { recipient: parsed.data.recipient }, ipAddress: req.ip });
    res.json({ ok: true, message: 'SMS test message accepted.' });
  } catch (error) {
    await recordProviderTest('SMS_HTTP', false, (error as Error).message);
    fail(res, 502, `SMS test failed: ${(error as Error).message}`);
  }
}));

/* ------------------------------- alerts ------------------------------- */

adminRouter.get('/alerts', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  const scope = scopeFilter(user);
  const args: string[] = [user.tenantId];
  const where = ['tenant_id=?'];
  if (scope.zoneId) { where.push('zone_id=?'); args.push(scope.zoneId); }
  const rows = await queryAll(`SELECT * FROM flood_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`, args);
  res.json({
    alerts: rows.map((row) => ({
      id: rowText(row, 'id'), deviceId: rowText(row, 'device_id'), zoneId: rowText(row, 'zone_id'),
      fromState: rowText(row, 'from_state'), toState: rowText(row, 'to_state'), levelCm: rowNullableNumber(row, 'level_cm'),
      rateCmPerMin: rowNullableNumber(row, 'rate_cm_per_min'), trigger: rowText(row, 'trigger'), reason: rowText(row, 'reason'),
      simulated: rowBoolean(row, 'simulated'), acknowledged: Boolean(rowText(row, 'acknowledged_at')),
      acknowledgedAt: rowText(row, 'acknowledged_at') || null, createdAt: rowText(row, 'created_at'),
    })),
  });
}));

adminRouter.post('/alerts/:alertId/acknowledge', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const alertId = String(req.params.alertId);
  const alert = await queryOne('SELECT * FROM flood_events WHERE id=?', [alertId]);
  if (!alert || rowText(alert, 'tenant_id') !== user.tenantId) { fail(res, 404, 'Alert not found.'); return; }
  if (!inAdminScope(user, { zoneId: rowText(alert, 'zone_id') || null })) { forbidden(res, 'That alert is outside your assigned area.'); return; }
  await execute('UPDATE flood_events SET acknowledged_at=?,acknowledged_by=? WHERE id=?', [currentTimestamp(), user.id, alertId]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'ALERT_ACKNOWLEDGED', targetType: 'flood_event', targetId: alertId, ipAddress: req.ip });
  res.json({ acknowledged: true });
}));

/* ------------------------------- reports ------------------------------ */

adminRouter.get('/reports', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const scope = scopeFilter(user);
  const args: string[] = [user.tenantId];
  const where = ['tenant_id=?'];
  if (scope.zoneId) { where.push('zone_id=?'); args.push(scope.zoneId); }
  const byState = await queryAll(`SELECT to_state, COUNT(*) AS count FROM flood_events WHERE ${where.join(' AND ')} GROUP BY to_state`, args);
  const byDay = await queryAll(
    `SELECT substr(created_at,1,10) AS day, COUNT(*) AS count FROM flood_events WHERE ${where.join(' AND ')} GROUP BY day ORDER BY day DESC LIMIT 14`,
    args,
  );
  const deliveries = await queryAll('SELECT channel,status,COUNT(*) AS count FROM notification_deliveries GROUP BY channel,status');
  const devices = await deviceListWithScope(user.tenantId);
  const scoped = isSuperAdmin(user) ? devices : devices.filter((device) => inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId }));
  res.json({
    eventsByState: byState.map((row) => ({ state: rowText(row, 'to_state'), count: rowNumber(row, 'count') })),
    eventsByDay: byDay.map((row) => ({ day: rowText(row, 'day'), count: rowNumber(row, 'count') })),
    deliveriesByChannel: deliveries.map((row) => ({ channel: rowText(row, 'channel'), status: rowText(row, 'status'), count: rowNumber(row, 'count') })),
    deviceUptime: scoped.map((device) => ({
      uid: device.uid, name: device.name, health: device.health, uptimeSeconds: device.uptimeSeconds,
      lastSeenAt: device.lastSeenAt, approvalState: device.approvalState,
    })),
  });
}));

/* -------------------------------- audit ------------------------------- */

adminRouter.get('/audit', asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const rows = await queryAll(
    `SELECT a.*, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT ?`,
    [user.tenantId, limit],
  );
  res.json({
    entries: rows.map((row) => {
      let metadata: unknown = {};
      try { metadata = JSON.parse(rowText(row, 'metadata_json', '{}')); } catch { /* keep empty */ }
      return {
        id: rowText(row, 'id'), action: rowText(row, 'action'), targetType: rowText(row, 'target_type'),
        targetId: rowText(row, 'target_id') || null, metadata, ipAddress: rowText(row, 'ip_address') || null,
        createdAt: rowText(row, 'created_at'), actorEmail: rowText(row, 'actor_email') || 'System',
      };
    }),
  });
}));

export { clientIp, primaryTenantId };
