/**
 * Schema-driven site tools.
 *
 * Page content is composed only from allowlisted block types (hero, text, image,
 * card, status, alert, button, chart). Every block is validated with zod before
 * storage; no arbitrary HTML, CSS or JavaScript is ever executed from user input.
 * Revisions are versioned (DRAFT / PUBLISHED / ARCHIVED) with publish and rollback.
 */
import { z } from 'zod';
import { execute, isTursoConfigured, randomId, rowText, currentTimestamp, DatabaseRequestError } from './database.js';

/** Internal paths or absolute https URLs only — no javascript:, data: or inline schemes. */
const safeHref = z.string().max(500).refine((value) => {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; }
}, 'Links must be an internal path (/...) or an https:// URL.');
const safeImageSrc = z.string().max(500).refine((value) => {
  if (/^\/[\w\-./]+$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'res.cloudinary.com' || url.hostname.endsWith('.cloudinary.com')); } catch { return false; }
}, 'Images must be an internal path or a Cloudinary https URL.');

export const heroBlock = z.object({
  type: z.literal('hero'),
  eyebrow: z.string().max(120).optional().default(''),
  title: z.string().min(1).max(160),
  body: z.string().max(1000).optional().default(''),
  image: z.object({ src: safeImageSrc, alt: z.string().max(200) }).optional(),
  button: z.object({ label: z.string().max(60), href: safeHref }).optional(),
});
export const textBlock = z.object({
  type: z.literal('text'),
  title: z.string().max(160).optional().default(''),
  body: z.string().min(1).max(4000),
});
export const imageBlock = z.object({
  type: z.literal('image'),
  src: safeImageSrc,
  alt: z.string().min(1).max(200),
  caption: z.string().max(300).optional().default(''),
});
export const cardBlock = z.object({
  type: z.literal('card'),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(1000),
  icon: z.string().max(40).optional().default(''),
});
export const statusBlock = z.object({
  type: z.literal('status'),
  title: z.string().max(160).optional().default('Live status'),
});
export const alertBlock = z.object({
  type: z.literal('alert'),
  level: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(1000),
});
export const buttonBlock = z.object({
  type: z.literal('button'),
  label: z.string().min(1).max(60),
  href: safeHref,
  style: z.enum(['primary', 'secondary']).optional().default('primary'),
});
export const chartBlock = z.object({
  type: z.literal('chart'),
  title: z.string().max(160).optional().default('Water level (live telemetry)'),
});

export const contentBlock = z.discriminatedUnion('type', [
  heroBlock, textBlock, imageBlock, cardBlock, statusBlock, alertBlock, buttonBlock, chartBlock,
]);
export type ContentBlock = z.infer<typeof contentBlock>;

export const pageDocument = z.object({
  blocks: z.array(contentBlock).max(40),
});
export type PageDocument = z.infer<typeof pageDocument>;

export const BLOCK_TYPES = ['hero', 'text', 'image', 'card', 'status', 'alert', 'button', 'chart'] as const;

export interface ContentRevision {
  id: string;
  slug: string;
  locale: string;
  title: string;
  content: PageDocument;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  createdAt: string;
  publishedAt: string | null;
  createdBy: string | null;
}

function toRevision(raw: unknown): ContentRevision {
  const row = raw as Record<string, unknown>;
  let content: PageDocument = { blocks: [] };
  try { content = pageDocument.parse(JSON.parse(rowText(row, 'content_json'))); } catch { /* keep empty document */ }
  return {
    id: rowText(row, 'id'),
    slug: rowText(row, 'slug'),
    locale: rowText(row, 'locale', 'en'),
    title: rowText(row, 'title'),
    content,
    status: rowText(row, 'status', 'DRAFT') as ContentRevision['status'],
    createdAt: rowText(row, 'created_at'),
    publishedAt: rowText(row, 'published_at') || null,
    createdBy: rowText(row, 'created_by') || null,
  };
}

export async function listRevisions(slug: string, locale = 'en'): Promise<ContentRevision[]> {
  if (!isTursoConfigured) return [];
  const result = await execute('SELECT * FROM content_revisions WHERE slug=? AND locale=? ORDER BY created_at DESC LIMIT 50', [slug, locale]);
  return result.rows.map(toRevision);
}

export async function getPublishedPage(slug: string, locale = 'en'): Promise<ContentRevision | null> {
  if (!isTursoConfigured) return null;
  const result = await execute(
    "SELECT * FROM content_revisions WHERE slug=? AND locale=? AND status='PUBLISHED' ORDER BY published_at DESC LIMIT 1",
    [slug, locale],
  );
  return result.rows.length ? toRevision(result.rows[0]) : null;
}

export async function saveDraft(input: { slug: string; locale?: string; title: string; document: unknown; createdBy: string | null }): Promise<ContentRevision> {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Site content requires the database-backed deployment.');
  const parsed = pageDocument.safeParse(input.document);
  if (!parsed.success) {
    throw new DatabaseRequestError(400, `Content block rejected: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  }
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  if (!slug) throw new DatabaseRequestError(400, 'A page slug is required.');
  const id = randomId();
  const now = currentTimestamp();
  await execute(
    'INSERT INTO content_revisions(id,slug,locale,title,content_json,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [id, slug, input.locale || 'en', input.title.slice(0, 200), JSON.stringify(parsed.data), 'DRAFT', input.createdBy, now],
  );
  return {
    id, slug, locale: input.locale || 'en', title: input.title.slice(0, 200), content: parsed.data,
    status: 'DRAFT', createdAt: now, publishedAt: null, createdBy: input.createdBy,
  };
}

export async function publishRevision(revisionId: string): Promise<ContentRevision> {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Site content requires the database-backed deployment.');
  const result = await execute('SELECT * FROM content_revisions WHERE id=?', [revisionId]);
  if (!result.rows.length) throw new DatabaseRequestError(404, 'Revision not found.');
  const revision = toRevision(result.rows[0]);
  const now = currentTimestamp();
  await execute("UPDATE content_revisions SET status='ARCHIVED' WHERE slug=? AND locale=? AND status='PUBLISHED'", [revision.slug, revision.locale]);
  await execute("UPDATE content_revisions SET status='PUBLISHED',published_at=? WHERE id=?", [now, revisionId]);
  return { ...revision, status: 'PUBLISHED', publishedAt: now };
}

/** Rollback publishes a copy of an earlier revision so history is never rewritten. */
export async function rollbackToRevision(revisionId: string, createdBy: string | null): Promise<ContentRevision> {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Site content requires the database-backed deployment.');
  const result = await execute('SELECT * FROM content_revisions WHERE id=?', [revisionId]);
  if (!result.rows.length) throw new DatabaseRequestError(404, 'Revision not found.');
  const revision = toRevision(result.rows[0]);
  const copy = await saveDraft({
    slug: revision.slug, locale: revision.locale,
    title: revision.title, document: revision.content, createdBy,
  });
  return publishRevision(copy.id);
}
