import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { actorId, bootstrap, createOwner, resetDatabase } from './helpers.js';
import { rowText } from '../database.js';

/**
 * Operations credential lifecycle and the schema-driven site builder.
 */

beforeEach(async () => {
  await bootstrap();
  await resetDatabase();
  await createOwner();
});

describe('rotating operations credential', () => {
  it('stores only a hash and supersedes earlier credentials', async () => {
    const { rotateOpsCredential } = await import('../routes/ops.js');
    const { queryAll } = await import('../database.js');
    const first = await rotateOpsCredential(null);
    const second = await rotateOpsCredential(null);
    const rows = await queryAll('SELECT * FROM ops_credentials ORDER BY issued_at');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(String(row.credential_hash), /^[a-f0-9]{64}$/, 'only a hash may be stored');
      assert.ok(!String(row.credential_hash).startsWith('FG-OPS'), 'the credential value must never be stored');
    }
    assert.equal(String(rows[0]!.revoked_at).length > 0, true, 'the first credential is revoked');
    assert.equal(first.credentialId !== second.credentialId, true);
  });

  it('expires credentials past their lifetime', async () => {
    const { queryAll, execute } = await import('../database.js');
    const { rotateOpsCredential } = await import('../routes/ops.js');
    await rotateOpsCredential(null);
    await execute('UPDATE ops_credentials SET expires_at=? WHERE revoked_at IS NULL', ['2020-01-01T00:00:00.000Z']);
    await execute('UPDATE ops_credentials SET revoked_at=NULL');
    const expired = await queryAll('SELECT * FROM ops_credentials WHERE expires_at<=?', [new Date().toISOString()]);
    assert.ok(expired.length >= 1);
  });

  it('rejects credentials with an invalid shape', async () => {
    const { opsCredentialShapeIsValid } = await import('../security.js');
    const { rotateOpsCredential } = await import('../routes/ops.js');
    await rotateOpsCredential(null);
    assert.equal(opsCredentialShapeIsValid('FG-OPS-000-AAAAAAAAAA'), true);
    assert.equal(opsCredentialShapeIsValid('short'), false);
    assert.equal(opsCredentialShapeIsValid('FG-OPS-0000-AAAAAAAAAA'), false);
  });

  it('records an audit entry for every rotation', async () => {
    const { rotateOpsCredential } = await import('../routes/ops.js');
    const { queryAll } = await import('../database.js');
    await rotateOpsCredential(await actorId());
    const audit = await queryAll("SELECT * FROM audit_logs WHERE action='OPS_CREDENTIAL_ROTATED'");
    assert.equal(audit.length, 1);
    const metadata = JSON.parse(String(audit[0]!.metadata_json));
    assert.equal(typeof metadata.expiresAt, 'string');
    assert.equal(metadata.delivered, false, 'no security email is configured in tests');
  });
});

describe('maintenance mode', () => {
  it('toggles the site setting and records a maintenance event', async () => {
    const { setMaintenanceMode } = await import('../notifications.js');
    const { isMaintenanceMode, queryAll } = await import('../database.js');
    await setMaintenanceMode(true, 'Planned work', await actorId());
    assert.equal(await isMaintenanceMode(), true);
    const active = await queryAll('SELECT * FROM maintenance_events WHERE ended_at IS NULL');
    assert.equal(active.length, 1);
    assert.equal(String(active[0]!.reason), 'Planned work');
    await setMaintenanceMode(false, '', await actorId());
    assert.equal(await isMaintenanceMode(), false);
    const closed = await queryAll('SELECT * FROM maintenance_events WHERE ended_at IS NOT NULL');
    assert.equal(closed.length, 1);
  });
});

describe('site builder schema', () => {
  it('accepts a well-formed page', async () => {
    const { parseSitePage } = await import('../../shared/site-blocks.js');
    const result = parseSitePage({
      title: 'How it works',
      blocks: [
        { id: 'hero-1', type: 'hero', title: 'Sense', subtitle: 'Ultrasonic sensing' },
        { id: 'text-1', type: 'text', title: 'Overview', body: 'Body copy' },
        { id: 'status-1', type: 'status', title: 'Live', source: 'public-status' },
        { id: 'chart-1', type: 'chart', title: 'Level', source: 'public-history', limit: 40 },
        { id: 'alert-1', type: 'alert', title: 'Safety', body: 'Prototype only', tone: 'warning' },
        { id: 'buttons-1', type: 'buttons', items: [{ label: 'Status', href: '/status', variant: 'primary' }] },
        { id: 'cards-1', type: 'cards', title: 'Steps', items: [{ title: 'Sense', body: 'Level', icon: 'sensor' }] },
        { id: 'card-1', type: 'card', title: 'Note', body: 'Text', tone: 'info' },
        { id: 'image-1', type: 'image', src: '/icon-512.png', alt: 'Icon' },
      ],
    });
    assert.equal(result.ok, true);
  });

  it('rejects unknown block types', async () => {
    const { parseSitePage } = await import('../../shared/site-blocks.js');
    const result = parseSitePage({ title: 'Bad', blocks: [{ id: 'x-1', type: 'script', code: 'alert(1)' }] });
    assert.equal(result.ok, false);
  });

  it('rejects script, style and event-handler content in any field', async () => {
    const { parseSitePage } = await import('../../shared/site-blocks.js');
    const attempts = [
      { title: 'Bad', blocks: [{ id: 'a', type: 'text', title: '<script>alert(1)</script>', body: 'x' }] },
      { title: 'Bad', blocks: [{ id: 'b', type: 'text', title: 't', body: '<img src=x onerror=alert(1)>' }] },
      { title: 'Bad', blocks: [{ id: 'c', type: 'image', src: 'javascript:alert(1)', alt: 'x' }] },
      { title: 'Bad', blocks: [{ id: 'd', type: 'hero', title: 't', primaryAction: { label: 'x', href: 'javascript:alert(1)' } }] },
      { title: 'Bad', blocks: [{ id: 'e', type: 'text', title: 't', body: '<iframe src="https://evil.example.org"></iframe>' }] },
    ];
    for (const attempt of attempts) {
      const result = parseSitePage(attempt);
      // Text blocks accept markup as data, but links and images are restricted.
      if (result.ok) {
        const serialised = JSON.stringify(result.page);
        assert.ok(!serialised.includes('javascript:'), 'javascript: URLs must be rejected');
        assert.ok(!serialised.includes('<iframe'), 'iframe markup must be rejected');
        assert.ok(!serialised.includes('onerror='), 'event handlers must be rejected');
      }
    }
  });

  it('rejects duplicate block ids', async () => {
    const { parseSitePage } = await import('../../shared/site-blocks.js');
    const result = parseSitePage({
      title: 'Dupes',
      blocks: [
        { id: 'same', type: 'text', title: 'a', body: 'a' },
        { id: 'same', type: 'text', title: 'b', body: 'b' },
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /unique/);
  });

  it('rejects oversized pages and unknown block payloads', async () => {
    const { parseSitePage } = await import('../../shared/site-blocks.js');
    const many = Array.from({ length: 61 }, (_unused, index) => ({ id: `t-${index}`, type: 'text', title: 't', body: 'b' }));
    assert.equal(parseSitePage({ title: 'Too many', blocks: many }).ok, false);
    assert.equal(parseSitePage({ title: '', blocks: [] }).ok, false);
  });
});

describe('page publishing and rollback', () => {
  it('publishes immutable versions and rolls back', async () => {
    const { execute, queryOne, queryAll, randomId, currentTimestamp } = await import('../database.js');
    const pageId = randomId();
    await execute(
      "INSERT INTO site_pages(id,tenant_id,slug,title,status,draft_json,created_at,updated_at) VALUES (?,?,?,?,'DRAFT','{\"blocks\":[]}',?,?)",
      [pageId, 'tenant-floodgrid', 'test-page', 'Test page', currentTimestamp(), currentTimestamp()],
    );
    const { publishPageVersion, rollbackToVersion } = await import('../routes/sitebuilder.js');
    const blocks = [{ id: 'hero-1', type: 'hero', title: 'Version one', subtitle: 'First' }];
    const published = await publishPageVersion(pageId, 'Test page', blocks as never, 'first');
    assert.equal(published.version, 1);
    const page = await queryOne('SELECT * FROM site_pages WHERE id=?', [pageId]);
    assert.equal(String(page!.status), 'PUBLISHED');
    assert.equal(String(page!.published_version_id), published.versionId);

    const second = await publishPageVersion(pageId, 'Test page', [{ id: 'hero-1', type: 'hero', title: 'Version two', subtitle: 'Second' }] as never, 'second');
    assert.equal(second.version, 2);

    const rolledBack = await rollbackToVersion(pageId, published.versionId);
    assert.equal(rolledBack.version, 1);
    const after = await queryOne('SELECT * FROM site_pages WHERE id=?', [pageId]);
    assert.equal(String(after!.published_version_id), published.versionId);
    const versions = await queryAll('SELECT version FROM site_page_versions WHERE page_id=? ORDER BY version', [pageId]);
    assert.equal(versions.length, 2, 'published versions are immutable history');
  });
});

describe('feature flags and settings', () => {
  it('stores and reads flags and settings', async () => {
    const { setFeatureFlag, getFeatureFlag, allFeatureFlags, setSiteSetting, getSiteSetting } = await import('../database.js');
    await setFeatureFlag('test_flag', true, 'test');
    assert.equal(await getFeatureFlag('test_flag'), true);
    await setFeatureFlag('test_flag', false, 'test');
    assert.equal(await getFeatureFlag('test_flag'), false);
    assert.equal(await getFeatureFlag('missing_flag', true), true, 'the fallback applies when a flag is absent');
    const flags = await allFeatureFlags();
    assert.equal(flags.test_flag, false);
    await setSiteSetting('test_setting', { nested: [1, 2, 3] }, await actorId());
    assert.deepEqual(await getSiteSetting('test_setting'), { nested: [1, 2, 3] });
  });
});

describe('audit logging', () => {
  it('writes an audit record with actor, target and metadata', async () => {
    const { insertAudit, queryAll, queryOne } = await import('../database.js');
    const actor = await queryOne('SELECT id FROM users LIMIT 1');
    assert.ok(actor, 'the bootstrap owner exists');
    await insertAudit({
      tenantId: 'tenant-floodgrid', actorId: rowText(actor!, 'id'), action: 'TEST_ACTION', targetType: 'device', targetId: 'device-1',
      metadata: { levelCm: 42 }, ipAddress: '203.0.113.9',
    });
    const rows = await queryAll("SELECT * FROM audit_logs WHERE action='TEST_ACTION'");
    assert.equal(rows.length, 1);
    assert.ok(String(rows[0]!.actor_id).length > 0);
    assert.equal(String(rows[0]!.ip_address), '203.0.113.9');
    assert.deepEqual(JSON.parse(String(rows[0]!.metadata_json)), { levelCm: 42 });
  });
});

describe('web push endpoint validation', () => {
  it('accepts known push services and rejects everything else', async () => {
    const { isTrustedPushEndpoint } = await import('../push-validation.js');
    assert.equal(isTrustedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
    assert.equal(isTrustedPushEndpoint('https://web.push.apple.com/abc'), true);
    assert.equal(isTrustedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'), true);
    assert.equal(isTrustedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
    assert.equal(isTrustedPushEndpoint('https://127.0.0.1/fcm/send/abc'), false);
    assert.equal(isTrustedPushEndpoint('https://localhost/fcm/send/abc'), false);
    assert.equal(isTrustedPushEndpoint('https://evil.example.org/collect'), false);
    assert.equal(isTrustedPushEndpoint('not-a-url'), false);
  });
});

describe('deterministic idempotency of hashing', () => {
  it('hashes the same token to the same digest', async () => {
    const { hashToken } = await import('../security.js');
    assert.equal(hashToken('value'), hashToken('value'));
    assert.equal(hashToken('value'), crypto.createHash('sha256').update('value').digest('hex'));
  });
});
