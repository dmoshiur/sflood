import { queryAll, queryOne, rowText, rowBoolean, rowNullableNumber, execute, randomId, currentTimestamp } from './database.js';
import { config } from './config.js';

/**
 * Service-area allowlist.
 *
 * Registration is only accepted for cities/countries that exist in the
 * `service_areas` table and are enabled. This is the authoritative eligibility
 * check and it is enforced server-side on every registration and profile update.
 *
 * Optional IP geolocation is a *secondary* signal only. It is recorded for
 * review and can be used to flag mismatches, but it is never treated as a
 * security boundary: VPNs, CGNAT and mobile carriers make IP location unreliable.
 */

export interface ServiceArea {
  id: string;
  city: string;
  region: string;
  country: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  enabled: boolean;
  requiresReview: boolean;
  notes: string;
}

function toServiceArea(row: Record<string, unknown>): ServiceArea {
  return {
    id: rowText(row, 'id'),
    city: rowText(row, 'city'),
    region: rowText(row, 'region'),
    country: rowText(row, 'country'),
    countryCode: rowText(row, 'country_code').toUpperCase(),
    latitude: rowNullableNumber(row, 'latitude'),
    longitude: rowNullableNumber(row, 'longitude'),
    enabled: rowBoolean(row, 'enabled'),
    requiresReview: rowBoolean(row, 'requires_review'),
    notes: rowText(row, 'notes'),
  };
}

export async function listServiceAreas(includeDisabled = false): Promise<ServiceArea[]> {
  const rows = await queryAll(
    includeDisabled
      ? 'SELECT * FROM service_areas ORDER BY country ASC, city ASC'
      : 'SELECT * FROM service_areas WHERE enabled=1 ORDER BY country ASC, city ASC',
  );
  return rows.map(toServiceArea);
}

export async function findServiceArea(id: string): Promise<ServiceArea | null> {
  const row = await queryOne('SELECT * FROM service_areas WHERE id=?', [id]);
  return row ? toServiceArea(row) : null;
}

export interface EligibilityResult {
  allowed: boolean;
  reason: string;
  serviceArea: ServiceArea | null;
  ipCountryCode: string | null;
  ipCity: string | null;
  ipMatches: boolean | null;
  requiresReview: boolean;
}

function normalizeCity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Enforce the allowlist. The service area id must exist and be enabled.
 * A city/country pair is accepted when it matches the selected service area so
 * that a client cannot claim one area while selecting another id.
 */
export async function checkServiceAreaEligibility(input: {
  serviceAreaId?: string | null; city?: string | null; countryCode?: string | null; ip?: string | null;
}): Promise<EligibilityResult> {
  const geo = await lookupIpLocation(input.ip || null);
  if (!input.serviceAreaId) {
    return { allowed: false, reason: 'Select a service area from the allowlist.', serviceArea: null, ipCountryCode: geo.countryCode, ipCity: geo.city, ipMatches: null, requiresReview: false };
  }
  const area = await findServiceArea(input.serviceAreaId);
  if (!area) {
    return { allowed: false, reason: 'That service area is not in the allowlist.', serviceArea: null, ipCountryCode: geo.countryCode, ipCity: geo.city, ipMatches: null, requiresReview: false };
  }
  if (!area.enabled) {
    return { allowed: false, reason: `${area.city}, ${area.country} is not currently accepting registrations.`, serviceArea: area, ipCountryCode: geo.countryCode, ipCity: geo.city, ipMatches: null, requiresReview: false };
  }
  if (input.city && normalizeCity(input.city) !== normalizeCity(area.city)) {
    return { allowed: false, reason: `The selected service area is ${area.city}, ${area.country}.`, serviceArea: area, ipCountryCode: geo.countryCode, ipCity: geo.city, ipMatches: null, requiresReview: false };
  }
  if (input.countryCode && input.countryCode.toUpperCase() !== area.countryCode) {
    return { allowed: false, reason: `The selected service area is in ${area.country}.`, serviceArea: area, ipCountryCode: geo.countryCode, ipCity: geo.city, ipMatches: null, requiresReview: false };
  }
  const ipMatches = geo.countryCode ? geo.countryCode === area.countryCode : null;
  return {
    allowed: true,
    reason: ipMatches === false
      ? `Eligible by service area. Note: your network location (${geo.countryCode}) differs from ${area.country}; this is recorded for review and does not block access.`
      : 'Service area is on the allowlist.',
    serviceArea: area, ipCountryCode: geo.countryCode, ipCity: geo.city, ipMatches, requiresReview: area.requiresReview,
  };
}

export interface IpLocation { countryCode: string | null; city: string | null; source: string | null }

/**
 * Optional, best-effort IP geolocation. Disabled unless IP_GEO_LOOKUP_URL is
 * configured. Never throws and never blocks a request on its own.
 */
export async function lookupIpLocation(ip: string | null): Promise<IpLocation> {
  if (!ip || !config.geoLookupUrl) return { countryCode: null, city: null, source: null };
  try {
    const url = new URL(config.geoLookupUrl);
    url.searchParams.set('ip', ip);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.geoLookupToken) headers.Authorization = `Bearer ${config.geoLookupToken}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!response.ok) return { countryCode: null, city: null, source: null };
    const data = await response.json() as Record<string, unknown>;
    const countryCode = typeof data.country_code === 'string' ? data.country_code.toUpperCase()
      : typeof data.countryCode === 'string' ? data.countryCode.toUpperCase() : null;
    const city = typeof data.city === 'string' ? data.city : null;
    return { countryCode, city, source: 'ip-geolocation' };
  } catch {
    return { countryCode: null, city: null, source: null };
  }
}

export async function createServiceArea(input: {
  tenantId: string; city: string; region?: string; country: string; countryCode: string;
  latitude?: number | null; longitude?: number | null; enabled?: boolean; requiresReview?: boolean; notes?: string;
}): Promise<ServiceArea> {
  const id = randomId();
  const now = currentTimestamp();
  await execute(
    `INSERT INTO service_areas(id,tenant_id,city,region,country,country_code,latitude,longitude,enabled,requires_review,notes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, input.tenantId, input.city, input.region || '', input.country, input.countryCode.toUpperCase(), input.latitude ?? null, input.longitude ?? null, input.enabled === false ? 0 : 1, input.requiresReview ? 1 : 0, input.notes || '', now, now],
  );
  return (await findServiceArea(id)) as ServiceArea;
}

export async function updateServiceArea(id: string, patch: Partial<ServiceArea>): Promise<ServiceArea | null> {
  const existing = await findServiceArea(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, id };
  await execute(
    'UPDATE service_areas SET city=?,region=?,country=?,country_code=?,latitude=?,longitude=?,enabled=?,requires_review=?,notes=?,updated_at=? WHERE id=?',
    [next.city, next.region, next.country, next.countryCode, next.latitude, next.longitude, next.enabled ? 1 : 0, next.requiresReview ? 1 : 0, next.notes, currentTimestamp(), id],
  );
  return findServiceArea(id);
}
