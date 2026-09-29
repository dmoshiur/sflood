import express from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { currentTimestamp, execute, insertAudit, queryAll, queryOne, randomId, rowText } from '../database.js';
import { requireCsrf, requireSession } from '../auth.js';
import { isLocalAdmin, type AuthUser } from '../rbac.js';
import { parseSitePage, type SiteBlock } from '../../shared/site-blocks.js';
import { asyncHandler, fail, forbidden } from '../http.js';

/**
 * Schema-driven site builder.
 *
 * Editors compose pages from the whitelisted block library, preview them, save
 * drafts, publish immutable versions and roll back to any published version.
 * Content is validated server-side against the block schema, and the frontend
 * renders blocks through a fixed component map, so no user-supplied script can
 * ever run.
 */

export const siteBuilderRouter = express.Router();

siteBuilderRouter.use(requireSession);

async function pageList(user: AuthUser) {
  const rows = await queryAll('SELECT * FROM site_pages WHERE tenant_id=? ORDER BY slug', [user.tenantId]);
  return Promise.all(rows.map(async (row) => {
    const versions = await queryAll('SELECT id,version,title,created_at,published_at FROM site_page_versions WHERE page_id=? ORDER BY version DESC LIMIT 20', [rowText(row, 'id')]);
    return {
      id: rowText(row, 'id'), slug: rowText(row, 'slug'), title: rowText(row, 'title'), status: rowText(row, 'status'),
      publishedVersionId: rowText(row, 'published_version_id') || null,
      updatedAt: rowText(row, 'updated_at'),
      versions: versions.map((version) => ({
        id: rowText(version, 'id'), version: Number(version.version ?? 1), title: rowText(version, 'title'),
        createdAt: rowText(version, 'created_at'), publishedAt: rowText(version, 'published_at') || null,
      })),
    };
  }));
}

siteBuilderRouter.get('/pages', asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  res.json({ pages: await pageList(user) });
}));

siteBuilderRouter.get('/pages/:pageId', asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const row = await queryOne('SELECT * FROM site_pages WHERE id=? AND tenant_id=?', [String(req.params.pageId), user.tenantId]);
  if (!row) { fail(res, 404, 'Page not found.'); return; }
  let blocks: SiteBlock[] = [];
  try { blocks = JSON.parse(rowText(row, 'draft_json', '{"blocks":[]}')); } catch { blocks = []; }
  res.json({
    page: {
      id: rowText(row, 'id'), slug: rowText(row, 'slug'), title: rowText(row, 'title'), status: rowText(row, 'status'),
      publishedVersionId: rowText(row, 'published_version_id') || null, blocks,
    },
  });
}));

const createPageSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'Use lowercase letters, numbers and hyphens.'),
  title: z.string().min(2).max(160),
});

siteBuilderRouter.post('/pages', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = createPageSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Enter a URL slug (lowercase, hyphens) and a title.'); return; }
  const existing = await queryOne('SELECT id FROM site_pages WHERE tenant_id=? AND slug=?', [user.tenantId, parsed.data.slug]);
  if (existing) { fail(res, 409, 'A page with that slug already exists.'); return; }
  const id = randomId();
  const now = currentTimestamp();
  await execute(
    "INSERT INTO site_pages(id,tenant_id,slug,title,status,draft_json,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'DRAFT','{\"blocks\":[]}',?,?,?,?)",
    [id, user.tenantId, parsed.data.slug, parsed.data.title, user.id, user.id, now, now],
  );
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SITE_PAGE_CREATED', targetType: 'page', targetId: id, metadata: { slug: parsed.data.slug }, ipAddress: req.ip });
  res.status(201).json({ id, slug: parsed.data.slug });
}));

siteBuilderRouter.put('/pages/:pageId/draft', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = parseSitePage(req.body);
  if (!parsed.ok) { fail(res, 400, parsed.error); return; }
  const page = await queryOne('SELECT * FROM site_pages WHERE id=? AND tenant_id=?', [String(req.params.pageId), user.tenantId]);
  if (!page) { fail(res, 404, 'Page not found.'); return; }
  await execute('UPDATE site_pages SET draft_json=?,title=?,updated_by=?,updated_at=? WHERE id=?', [
    JSON.stringify({ blocks: parsed.page.blocks }), parsed.page.title, user.id, currentTimestamp(), String(req.params.pageId),
  ]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SITE_PAGE_DRAFT_SAVED', targetType: 'page', targetId: String(req.params.pageId), metadata: { blocks: parsed.page.blocks.length }, ipAddress: req.ip });
  res.json({ saved: true, blocks: parsed.page.blocks.length, message: 'Draft saved. Publish it when you are ready.' });
}));

/** Publish the supplied blocks as a new immutable version. */
export async function publishPageVersion(pageId: string, title: string, blocks: SiteBlock[], note = '', actorId: string | null = null) {
  const parsed = parseSitePage({ title, blocks });
  if (!parsed.ok) throw new Error(parsed.error);
  const latest = await queryOne('SELECT MAX(version) AS version FROM site_page_versions WHERE page_id=?', [pageId]);
  const nextVersion = Number(latest?.version || 0) + 1;
  const versionId = randomId();
  const now = currentTimestamp();
  await execute(
    'INSERT INTO site_page_versions(id,page_id,version,title,blocks_json,note,created_by,created_at,published_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [versionId, pageId, nextVersion, parsed.page.title, JSON.stringify(parsed.page.blocks), note, actorId, now, now],
  );
  await execute("UPDATE site_pages SET status='PUBLISHED',published_version_id=?,title=?,updated_by=?,updated_at=? WHERE id=?", [
    versionId, parsed.page.title, actorId, now, pageId,
  ]);
  const page = await queryOne('SELECT tenant_id FROM site_pages WHERE id=?', [pageId]);
  if (page) {
    await insertAudit({ tenantId: rowText(page, 'tenant_id'), actorId, action: 'SITE_PAGE_PUBLISHED', targetType: 'page', targetId: pageId, metadata: { version: nextVersion } });
  }
  return { version: nextVersion, versionId };
}

/** Roll a page back to a previously published version. */
export async function rollbackToVersion(pageId: string, versionId: string, actorId: string | null = null) {
  const version = await queryOne('SELECT * FROM site_page_versions WHERE id=? AND page_id=?', [versionId, pageId]);
  if (!version) throw new Error('That version does not exist.');
  const now = currentTimestamp();
  await execute("UPDATE site_pages SET status='PUBLISHED',published_version_id=?,title=?,updated_by=?,updated_at=? WHERE id=?", [
    versionId, rowText(version, 'title'), actorId, now, pageId,
  ]);
  await execute('UPDATE site_pages SET draft_json=? WHERE id=?', [rowText(version, 'blocks_json'), pageId]);
  const page = await queryOne('SELECT tenant_id FROM site_pages WHERE id=?', [pageId]);
  if (page) {
    await insertAudit({ tenantId: rowText(page, 'tenant_id'), actorId, action: 'SITE_PAGE_ROLLED_BACK', targetType: 'page', targetId: pageId, metadata: { versionId, version: Number(version.version ?? 0) } });
  }
  return { version: Number(version.version ?? 0) };
}

siteBuilderRouter.post('/pages/:pageId/publish', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const page = await queryOne('SELECT * FROM site_pages WHERE id=? AND tenant_id=?', [String(req.params.pageId), user.tenantId]);
  if (!page) { fail(res, 404, 'Page not found.'); return; }
  const parsed = parseSitePage(req.body || { blocks: [], title: rowText(page, 'title') });
  if (!parsed.ok) { fail(res, 400, parsed.error); return; }
  const result = await publishPageVersion(String(req.params.pageId), parsed.page.title, parsed.page.blocks, parsed.page.note || '', user.id);
  res.json({ published: true, version: result.version, versionId: result.versionId, message: `Version ${result.version} is now live.` });
}));

siteBuilderRouter.post('/pages/:pageId/rollback', requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'This action requires an admin role.'); return; }
  const parsed = z.object({ versionId: z.string().min(3).max(64) }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Choose a published version to roll back to.'); return; }
  const page = await queryOne('SELECT * FROM site_pages WHERE id=? AND tenant_id=?', [String(req.params.pageId), user.tenantId]);
  if (!page) { fail(res, 404, 'Page not found.'); return; }
  const version = await queryOne('SELECT * FROM site_page_versions WHERE id=? AND page_id=?', [parsed.data.versionId, String(req.params.pageId)]);
  if (!version) { fail(res, 404, 'That version does not exist.'); return; }
  const result = await rollbackToVersion(String(req.params.pageId), parsed.data.versionId, user.id);
  res.json({ rolledBack: true, version: result.version, message: `Rolled back to version ${result.version}.` });
}));

siteBuilderRouter.get('/library', asyncHandler(async (_req, res) => {
  const { BLOCK_LIBRARY } = await import('../../shared/site-blocks.js');
  res.json({ library: BLOCK_LIBRARY, publicAppUrl: config.publicAppUrl || null });
}));
