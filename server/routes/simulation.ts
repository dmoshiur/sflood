import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  execute, getSiteSetting, insertAudit, primaryTenantId, queryOne, rowNumber, rowText, setSiteSetting,
} from '../database.js';
import { requireCsrf, requireSession } from '../auth.js';
import { isLocalAdmin, type AuthUser } from '../rbac.js';
import { getDevice, latestTelemetry, registerDevice, setDeviceApproval } from '../devices.js';
import { ingestTelemetry, telemetrySchema } from '../telemetry.js';
import { asyncHandler, fail, forbidden } from '../http.js';

/**
 * Explicitly labelled simulation mode.
 *
 * Simulation telemetry is written to the same tables as real telemetry, but every
 * row, event and notification is flagged `simulated` and the device is named as a
 * simulation node. The UI shows a permanent SIMULATION banner. This exists so the
 * full barrier/notification workflow can be demonstrated at a science fair
 * without pretending that a physical sensor is connected.
 */

export const simulationRouter = express.Router();

const stepLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
simulationRouter.use(requireSession, stepLimiter);

const SIMULATION_DEVICE_NAME = 'SIMULATION NODE (not hardware)';

async function findOrCreateSimulationDevice(user: AuthUser): Promise<string> {
  const tenantId = user.tenantId;
  const existing = await queryOne('SELECT * FROM devices WHERE tenant_id=? AND simulation=1 ORDER BY created_at LIMIT 1', [tenantId]);
  if (existing) return rowText(existing, 'id');
  const zone = user.zoneId
    ? await queryOne('SELECT id,city_id FROM zones WHERE id=?', [user.zoneId])
    : await queryOne('SELECT id,city_id FROM zones z JOIN cities c ON c.id=z.city_id WHERE c.tenant_id=? ORDER BY z.created_at LIMIT 1', [tenantId]);
  if (!zone) throw new Error('No monitored zone is configured.');
  const { device } = await registerDevice({
    tenantId, cityId: rowText(zone, 'city_id'), zoneId: rowText(zone, 'id'),
    name: SIMULATION_DEVICE_NAME, board: 'ESP32', firmwareVersion: 'simulation', actorId: user.id, simulation: true,
  });
  await setDeviceApproval(device.id, 'APPROVED', 'Simulation node', user.id);
  await execute('UPDATE devices SET uid=? WHERE id=?', [`SIM${rowNumber(await queryOne('SELECT COUNT(*) AS count FROM devices'), 'count') + 1}`.padEnd(8, '0'), device.id]);
  return device.id;
}

async function currentLevel(deviceId: string): Promise<number> {
  const row = await queryOne('SELECT level_cm FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 1', [deviceId]);
  return row ? Number(row.level_cm ?? 0) : 12;
}

simulationRouter.get('/state', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'Simulation controls require an admin role.'); return; }
  const deviceRow = await queryOne('SELECT * FROM devices WHERE tenant_id=? AND simulation=1 ORDER BY created_at LIMIT 1', [user.tenantId]);
  if (!deviceRow) { res.json({ simulation: true, active: false, running: false, device: null, levelCm: null, history: [], events: [] }); return; }
  const deviceId = rowText(deviceRow, 'id');
  const device = await getDevice(deviceId);
  const history = await latestTelemetry(deviceId, 40);
  const events = await queryOne('SELECT COUNT(*) AS count FROM flood_events WHERE device_id=?', [deviceId]);
  const recent = await queryOne('SELECT * FROM flood_events WHERE device_id=? ORDER BY created_at DESC LIMIT 1', [deviceId]);
  res.json({
    simulation: true,
    active: true,
    running: Boolean(await getSiteSetting('simulation_running', false)),
    intervalSeconds: Number(await getSiteSetting('simulation_interval_seconds', 5)),
    pattern: String(await getSiteSetting('simulation_pattern', 'sine')),
    device: device && {
      id: device.id, uid: device.uid, name: device.name, board: device.board, approvalState: device.approvalState,
      currentState: device.currentState, barrierState: device.barrierState, lastSeq: device.lastSeq,
      emergencyStopActive: device.emergencyStopActive, faultState: device.faultState,
    },
    levelCm: history.length ? history[history.length - 1]!.levelCm : null,
    eventCount: rowNumber(events, 'count'),
    lastEvent: recent
      ? { fromState: rowText(recent, 'from_state'), toState: rowText(recent, 'to_state'), levelCm: rowNumber(recent, 'level_cm'), reason: rowText(recent, 'reason'), createdAt: rowText(recent, 'created_at') }
      : null,
    history,
  });
}));

const scenarioSchema = z.object({
  scenario: z.enum(['rise', 'recede', 'sensor-fault', 'sensor-recovered', 'estop', 'estop-reset', 'set-level']).optional(),
  levelCm: z.number().min(0).max(400).optional(),
  rateCmPerMin: z.number().min(-100).max(100).optional(),
});

simulationRouter.post('/step', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'Simulation controls require an admin role.'); return; }
  const parsed = scenarioSchema.safeParse(req.body || {});
  if (!parsed.success) { fail(res, 400, 'Choose a supported simulation action.'); return; }
  const deviceId = await findOrCreateSimulationDevice(user);
  const device = await getDevice(deviceId);
  if (!device) { fail(res, 503, 'The simulation node could not be created.'); return; }

  const base = await currentLevel(deviceId);
  let level = base;
  let sensorHealthy = device.faultState !== 'SENSOR_FAULT';
  let emergencyStop = device.emergencyStopActive;
  let rate: number | undefined;
  switch (parsed.data.scenario) {
    case 'rise': level = Math.min(400, base + 6); rate = 6; break;
    case 'recede': level = Math.max(0, base - 7); rate = -7; break;
    case 'sensor-fault': sensorHealthy = false; break;
    case 'sensor-recovered': sensorHealthy = true; break;
    case 'estop': emergencyStop = true; break;
    case 'estop-reset': emergencyStop = false; break;
    case 'set-level': level = parsed.data.levelCm ?? base; break;
    default: level = base; break;
  }
  if (parsed.data.levelCm !== undefined && parsed.data.scenario !== 'set-level') level = parsed.data.levelCm;
  if (parsed.data.rateCmPerMin !== undefined) rate = parsed.data.rateCmPerMin;

  if (!sensorHealthy) await execute("UPDATE devices SET fault_state='SENSOR_FAULT' WHERE id=?", [deviceId]);
  else if (device.faultState === 'SENSOR_FAULT') await execute("UPDATE devices SET fault_state='NONE' WHERE id=?", [deviceId]);
  if (emergencyStop !== device.emergencyStopActive) {
    await execute('UPDATE devices SET emergency_stop_active=? WHERE id=?', [emergencyStop ? 1 : 0, deviceId]);
  }

  const payload = telemetrySchema.parse({
    deviceId, seq: device.lastSeq + 1, levelCm: level, rateCmPerMin: rate,
    sensorHealthy, emergencyStopActive: emergencyStop, simulated: true,
    uptimeSeconds: Math.floor(process.uptime()), rssi: -58,
    faultState: sensorHealthy ? (emergencyStop ? 'ACTUATOR_FAULT' : 'NONE') : 'SENSOR_FAULT',
    barrierState: emergencyStop ? 'FAULT' : undefined,
  });

  try {
    const result = await ingestTelemetry(device, payload);
    await insertAudit({
      tenantId: user.tenantId, actorId: user.id, action: 'SIMULATION_STEP', targetType: 'device', targetId: deviceId,
      metadata: { scenario: parsed.data.scenario || 'hold', levelCm: level, simulated: true },
    });
    res.json({
      simulation: true, seq: result.seq, state: result.state, previousState: result.previousState, changed: result.changed,
      barrier: result.barrier, levelCm: result.levelCm, rateCmPerMin: result.rateCmPerMin, eventId: result.eventId,
      commandId: result.commandId, simulated: true, reason: result.reason,
      message: 'SIMULATION sample stored. It is labelled as simulated everywhere it appears and no physical device was contacted.',
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) { fail(res, status, (error as Error).message); return; }
    throw error;
  }
}));

simulationRouter.post('/start', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'Simulation controls require an admin role.'); return; }
  const parsed = z.object({ intervalSeconds: z.number().int().min(2).max(120).optional(), pattern: z.enum(['sine', 'rise', 'random']).optional() }).safeParse(req.body || {});
  if (!parsed.success) { fail(res, 400, 'Choose an interval between 2 and 120 seconds.'); return; }
  await findOrCreateSimulationDevice(user);
  await setSiteSetting('simulation_running', true, user.id);
  await setSiteSetting('simulation_interval_seconds', parsed.data.intervalSeconds ?? 5, user.id);
  await setSiteSetting('simulation_pattern', parsed.data.pattern || 'sine', user.id);
  startSimulationLoop();
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SIMULATION_STARTED', targetType: 'simulation', metadata: { intervalSeconds: parsed.data.intervalSeconds ?? 5 }, ipAddress: req.ip });
  res.json({ running: true, message: 'SIMULATION mode started. Every sample is labelled as simulated.' });
}));

simulationRouter.post('/stop', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'Simulation controls require an admin role.'); return; }
  await setSiteSetting('simulation_running', false, user.id);
  stopSimulationLoop();
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SIMULATION_STOPPED', targetType: 'simulation', ipAddress: req.ip });
  res.json({ running: false, message: 'Simulation stopped.' });
}));

let loopTimer: NodeJS.Timeout | null = null;
let tick = 0;

function stopSimulationLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
}

function startSimulationLoop() {
  if (loopTimer) return;
  const run = async () => {
    const interval = Number(await getSiteSetting('simulation_interval_seconds', 5));
    try {
      const running = Boolean(await getSiteSetting('simulation_running', false));
      if (!running) { stopSimulationLoop(); return; }
      const pattern = String(await getSiteSetting('simulation_pattern', 'sine'));
      const tenantId = await primaryTenantId();
      const deviceRow = await queryOne('SELECT * FROM devices WHERE tenant_id=? AND simulation=1 ORDER BY created_at LIMIT 1', [tenantId]);
      if (!deviceRow) { stopSimulationLoop(); return; }
      const device = await getDevice(rowText(deviceRow, 'id'));
      if (!device) { stopSimulationLoop(); return; }
      const base = await currentLevel(device.id);
      tick += 1;
      let level = base;
      if (pattern === 'sine') level = 18 + 26 * (1 + Math.sin(tick / 6)) / 2;
      else if (pattern === 'rise') level = Math.min(90, base + 3);
      else level = Math.max(0, Math.min(90, base + (Math.random() * 12 - 6)));
      await ingestTelemetry(device, telemetrySchema.parse({
        deviceId: device.id, seq: device.lastSeq + 1, levelCm: Math.round(level * 10) / 10,
        sensorHealthy: true, simulated: true, uptimeSeconds: Math.floor(process.uptime()), rssi: -58,
      }));
    } catch (error) {
      console.warn('[floodgrid] simulation loop error:', (error as Error).message);
    }
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(run, Math.max(2, interval) * 1000);
    loopTimer.unref?.();
  };
  void run();
}

export function stopAllSimulations() { stopSimulationLoop(); }
