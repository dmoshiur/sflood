import 'dotenv/config';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const tenantId = 'floodguard-demo-tenant';
const cityName = 'River Island City';
const zoneName = 'Ward 04 · North Bank';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const esp32Key = process.env.FG_ESP32_API_KEY;
  const esp8266Key = process.env.FG_ESP8266_API_KEY;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required before seeding PostgreSQL.');
  if (!esp32Key || esp32Key.length < 32 || !esp8266Key || esp8266Key.length < 32) {
    throw new Error('Set FG_ESP32_API_KEY and FG_ESP8266_API_KEY (32+ random characters each) before seeding. Never commit these values.');
  }

  const tenant = await prisma.tenant.upsert({
    where: { slug: 'floodguard-demo' },
    update: { name: 'FloodGuard Demo Tenant' },
    create: { id: tenantId, slug: 'floodguard-demo', name: 'FloodGuard Demo Tenant' },
  });
  const city = await prisma.city.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: cityName } },
    update: {},
    create: { tenantId: tenant.id, name: cityName },
  });
  const zone = await prisma.zone.upsert({
    where: { cityId_name: { cityId: city.id, name: zoneName } },
    update: {},
    create: { cityId: city.id, name: zoneName },
  });
  const controller = await prisma.device.upsert({
    where: { id: 'fg-esp32-01' },
    update: { apiKeyHash: hash(esp32Key), enabled: true },
    create: {
      id: 'fg-esp32-01', tenantId: tenant.id, cityId: city.id, zoneId: zone.id,
      name: 'Main control node', kind: 'ESP32_CONTROLLER',
      apiKeyHash: hash(esp32Key), firmwareVersion: '0.1.0-demo', lastSeq: 0,
      currentState: 'UNKNOWN', barrierState: 'DOWN',
    },
  });
  const sender = await prisma.device.upsert({
    where: { id: 'fg-esp8266-01' },
    update: { apiKeyHash: hash(esp8266Key), enabled: true },
    create: {
      id: 'fg-esp8266-01', tenantId: tenant.id, cityId: city.id, zoneId: zone.id,
      name: 'North gauge sender', kind: 'ESP8266_SENDER',
      apiKeyHash: hash(esp8266Key), firmwareVersion: '0.1.0-demo', lastSeq: 0,
      currentState: 'UNKNOWN', barrierState: 'DOWN',
    },
  });

  if (await prisma.telemetry.count({ where: { deviceId: controller.id } }) === 0) {
    const levels = [9.5, 11.1, 13.8, 12.9, 16.4, 19.7, 21.2, 24.5, 26.8, 29.3, 31.8, 34.2];
    const now = Date.now();
    await prisma.telemetry.createMany({ data: levels.map((levelCm, index) => ({
      deviceId: controller.id,
      seq: index + 1,
      levelCm,
      rainfallMm: Math.max(0, Math.round((index - 2) * 1.7)),
      state: levelCm >= 35 ? 'WARNING' : levelCm >= 20 ? 'WATCH' : 'SAFE',
      barrierState: 'DOWN',
      sensorHealthy: true,
      createdAt: new Date(now - (levels.length - index - 1) * 10 * 60_000),
    })) });
    await prisma.device.update({ where: { id: controller.id }, data: { lastSeq: levels.length, lastSeenAt: new Date(), currentState: 'WATCH', barrierState: 'DOWN' } });
  }
  if (await prisma.telemetry.count({ where: { deviceId: sender.id } }) === 0) {
    await prisma.telemetry.create({ data: {
      deviceId: sender.id, seq: 1, levelCm: 29.6, rainfallMm: 24, state: 'WATCH',
      barrierState: 'DOWN', sensorHealthy: true,
    } });
    await prisma.device.update({ where: { id: sender.id }, data: { lastSeq: 1, lastSeenAt: new Date(), currentState: 'WATCH' } });
  }
  await prisma.firmwareRelease.upsert({
    where: { version: '0.1.0-demo' },
    update: {},
    create: { version: '0.1.0-demo', sha256: 'not-published', sizeBytes: 0, assetUrl: 'unavailable-in-demo', channel: 'demo', notes: 'No firmware binary is published by this preview.' },
  });
  console.log('FloodGuard demo tenant, city, zone, devices and sample telemetry are ready.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
