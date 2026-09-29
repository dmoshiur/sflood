/**
 * Service-area allowlist for public registration.
 *
 * Registration is limited to the cities/countries an operator has listed in the
 * service_areas table. Optional IP geolocation is used only as a soft, advisory
 * signal — it is never treated as a security boundary and never blocks a user who
 * already selected an allowlisted service area.
 */
import { execute, isTursoConfigured, randomId, rowText, rowBoolean, currentTimestamp, DatabaseRequestError } from './database.js';

export interface ServiceArea {
  id: string;
  countryCode: string;
  countryName: string;
  cityName: string;
  enabled: boolean;
}

function toServiceArea(raw: unknown): ServiceArea {
  const row = raw as Record<string, unknown>;
  return {
    id: rowText(row, 'id'),
    countryCode: rowText(row, 'country_code'),
    countryName: rowText(row, 'country_name'),
    cityName: rowText(row, 'city_name'),
    enabled: rowBoolean(row, 'enabled'),
  };
}

// In the labeled local simulation there is no database to migrate, so the same
// seed list as migrations/0005_service_areas.sql is used. These are simulated
// rows of the demonstration deployment — Turso deployments always use the table.
const SIMULATION_SERVICE_AREAS: ServiceArea[] = [
  { id: 'sim-area-dhaka', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Dhaka', enabled: true },
  { id: 'sim-area-chattogram', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Chattogram', enabled: true },
  { id: 'sim-area-khulna', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Khulna', enabled: true },
  { id: 'sim-area-rajshahi', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Rajshahi', enabled: true },
  { id: 'sim-area-sylhet', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Sylhet', enabled: true },
  { id: 'sim-area-barishal', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Barishal', enabled: true },
  { id: 'sim-area-rangpur', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Rangpur', enabled: true },
  { id: 'sim-area-mymensingh', countryCode: 'BD', countryName: 'Bangladesh', cityName: 'Mymensingh', enabled: true },
];

export async function listServiceAreas(includeDisabled = false): Promise<ServiceArea[]> {
  if (!isTursoConfigured) return SIMULATION_SERVICE_AREAS;
  const result = await execute(
    includeDisabled
      ? 'SELECT * FROM service_areas ORDER BY country_name,city_name'
      : 'SELECT * FROM service_areas WHERE enabled=1 ORDER BY country_name,city_name',
  );
  return result.rows.map(toServiceArea);
}

export async function isCityServiced(countryCode: string, cityName: string): Promise<boolean> {
  const country = countryCode.trim().toUpperCase();
  const city = cityName.trim().toLowerCase();
  if (!isTursoConfigured) {
    return SIMULATION_SERVICE_AREAS.some((area) => area.enabled && area.countryCode === country && area.cityName.toLowerCase() === city);
  }
  const result = await execute(
    'SELECT id FROM service_areas WHERE enabled=1 AND country_code=? AND city_name=? COLLATE NOCASE',
    [countryCode.trim().toUpperCase(), cityName.trim()],
  );
  return result.rows.length > 0;
}

export async function addServiceArea(input: { countryCode: string; countryName: string; cityName: string }): Promise<ServiceArea> {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Service areas require the database-backed deployment.');
  const id = randomId();
  await execute(
    'INSERT INTO service_areas(id,country_code,country_name,city_name,enabled,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(country_code,city_name) DO UPDATE SET enabled=1',
    [id, input.countryCode.trim().toUpperCase().slice(0, 2), input.countryName.trim().slice(0, 80), input.cityName.trim().slice(0, 80), currentTimestamp()],
  );
  const result = await execute('SELECT * FROM service_areas WHERE country_code=? AND city_name=?', [input.countryCode.trim().toUpperCase(), input.cityName.trim()]);
  return toServiceArea(result.rows[0]);
}

export async function setServiceAreaEnabled(id: string, enabled: boolean): Promise<void> {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Service areas require the database-backed deployment.');
  await execute('UPDATE service_areas SET enabled=? WHERE id=?', [enabled ? 1 : 0, id]);
}

export interface GeoAdvisory {
  source: string;
  country: string | null;
  city: string | null;
  withinServiceArea: boolean | null;
  note: string;
}

/**
 * Optional IP geolocation advisory. Requires IPINFO_TOKEN to be configured; any
 * failure returns null. The result is informational only (shown in the UI and
 * audit trail) and must never be the sole eligibility decision.
 */
export async function geoAdvisory(ip: string): Promise<GeoAdvisory | null> {
  const token = process.env.IPINFO_TOKEN || '';
  if (!token || !ip) return null;
  const advisoryNote = 'IP geolocation is advisory only and is not a security boundary.';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json() as { country?: string; city?: string };
    return {
      source: 'ipinfo.io',
      country: data.country || null,
      city: data.city || null,
      withinServiceArea: data.country ? await isCityServiced(data.country, data.city || '').catch(() => null) : null,
      note: advisoryNote,
    };
  } catch {
    return null;
  }
}
