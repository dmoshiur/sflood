import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { bootstrap, createOwner, resetDatabase, TEST_DB_FILE } from './helpers.js';

/**
 * Service-area allowlist: registration is only accepted for enabled, listed
 * cities. IP geolocation is advisory and must never change the decision.
 */

let db: Awaited<ReturnType<typeof bootstrap>>;

beforeEach(async () => {
  db = await bootstrap();
  await resetDatabase();
  await createOwner();
});

describe('service area allowlist', () => {
  it('lists the seeded service areas', async () => {
    const { listServiceAreas } = await import('../service-areas.js');
    const areas = await listServiceAreas();
    assert.ok(areas.length >= 5);
    assert.ok(areas.some((area) => area.city === 'Dhaka' && area.countryCode === 'BD'));
    assert.ok(areas.every((area) => area.enabled));
  });

  it('accepts a matching service area', async () => {
    const { checkServiceAreaEligibility } = await import('../service-areas.js');
    const result = await checkServiceAreaEligibility({ serviceAreaId: 'sa-dhaka', city: 'Dhaka', countryCode: 'BD' });
    assert.equal(result.allowed, true);
    assert.equal(result.serviceArea?.city, 'Dhaka');
  });

  it('rejects an unknown service area id', async () => {
    const { checkServiceAreaEligibility } = await import('../service-areas.js');
    const result = await checkServiceAreaEligibility({ serviceAreaId: 'sa-does-not-exist' });
    assert.equal(result.allowed, false);
  });

  it('rejects a missing service area', async () => {
    const { checkServiceAreaEligibility } = await import('../service-areas.js');
    const result = await checkServiceAreaEligibility({ city: 'Dhaka' });
    assert.equal(result.allowed, false);
  });

  it('rejects a city that does not match the selected area', async () => {
    const { checkServiceAreaEligibility } = await import('../service-areas.js');
    const result = await checkServiceAreaEligibility({ serviceAreaId: 'sa-dhaka', city: 'Sylhet' });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Dhaka/);
  });

  it('rejects a mismatched country code', async () => {
    const { checkServiceAreaEligibility } = await import('../service-areas.js');
    const result = await checkServiceAreaEligibility({ serviceAreaId: 'sa-dhaka', countryCode: 'GB' });
    assert.equal(result.allowed, false);
  });

  it('rejects a disabled service area', async () => {
    const { checkServiceAreaEligibility, updateServiceArea } = await import('../service-areas.js');
    await updateServiceArea('sa-dhaka', { enabled: false });
    const result = await checkServiceAreaEligibility({ serviceAreaId: 'sa-dhaka' });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /not currently accepting/);
  });

  it('does not block on IP location (secondary signal only)', async () => {
    const { checkServiceAreaEligibility } = await import('../service-areas.js');
    const result = await checkServiceAreaEligibility({ serviceAreaId: 'sa-dhaka', ip: '203.0.113.10' });
    assert.equal(result.allowed, true);
    assert.equal(result.ipCountryCode, null);
    assert.equal(result.ipMatches, null);
  });

  it('lets a super admin add and update a service area', async () => {
    const { createServiceArea, updateServiceArea, listServiceAreas } = await import('../service-areas.js');
    const created = await createServiceArea({
      tenantId: 'tenant-floodgrid', city: 'Testville', country: 'Testland', countryCode: 'TL', enabled: true,
    });
    assert.equal(created.city, 'Testville');
    const updated = await updateServiceArea(created.id, { requiresReview: true });
    assert.equal(updated?.requiresReview, true);
    assert.ok((await listServiceAreas()).some((area) => area.id === created.id));
  });
});

describe('database bootstrap', () => {
  it('creates a real database file with the seeded tenant', async () => {
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(TEST_DB_FILE), 'the test database file must exist');
    assert.equal(db.tenantId, 'tenant-floodgrid');
  });
});
