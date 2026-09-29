import { z } from 'zod';

/**
 * Schema-driven site blocks.
 *
 * The drag-and-drop editor can only produce these block shapes. There is no
 * escape hatch for arbitrary HTML, scripts or styles: every field is validated
 * here on the server and rendered by a fixed component map on the client. This
 * is what makes user-editable content safe to publish.
 */

const textBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('text'),
  title: z.string().max(120).default(''),
  body: z.string().max(4000),
  align: z.enum(['left', 'center']).default('left'),
});

const heroBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('hero'),
  variant: z.enum(['science', 'alert', 'plain']).default('science'),
  eyebrow: z.string().max(120).default(''),
  title: z.string().max(160),
  subtitle: z.string().max(400).default(''),
  primaryAction: z.object({ label: z.string().max(60), href: z.string().max(200).refine((value) => value.startsWith('/') && !value.startsWith('//'), 'Links must be internal paths.') }).nullable().default(null),
  secondaryAction: z.object({ label: z.string().max(60), href: z.string().max(200).refine((value) => value.startsWith('/') && !value.startsWith('//'), 'Links must be internal paths.') }).nullable().default(null),
});

const imageBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('image'),
  src: z.string().max(2048).refine((value) => /^https:\/\//.test(value) || value.startsWith('/'), 'Images must be an internal path or an HTTPS URL.'),
  alt: z.string().max(200),
  caption: z.string().max(200).default(''),
  width: z.enum(['narrow', 'wide']).default('wide'),
});

const cardItem = z.object({
  title: z.string().max(120),
  body: z.string().max(600),
  icon: z.enum(['sensor', 'cpu', 'shield', 'bell', 'chart', 'wrench', 'map', 'lock']).default('chart'),
});

const cardsBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('cards'),
  title: z.string().max(120).default(''),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  items: z.array(cardItem).max(12),
});

const cardBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('card'),
  title: z.string().max(120),
  body: z.string().max(1200),
  tone: z.enum(['neutral', 'info', 'warning', 'critical', 'success']).default('neutral'),
  href: z.string().max(200).refine((value) => !value || (value.startsWith('/') && !value.startsWith('//')), 'Links must be internal paths.').default(''),
});

const statusBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('status'),
  title: z.string().max(120).default('Current site state'),
  source: z.literal('public-status'),
});

const alertBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('alert'),
  title: z.string().max(120),
  body: z.string().max(1200),
  tone: z.enum(['info', 'warning', 'critical', 'success']).default('info'),
});

const buttonBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('buttons'),
  items: z.array(z.object({
    label: z.string().max(60),
    href: z.string().max(200).refine((value) => value.startsWith('/') && !value.startsWith('//'), 'Links must be internal paths.'),
    variant: z.enum(['primary', 'secondary', 'ghost']).default('primary'),
  })).max(6),
});

const chartBlock = z.object({
  id: z.string().min(3).max(64),
  type: z.literal('chart'),
  title: z.string().max(120).default('Water level'),
  source: z.literal('public-history'),
  limit: z.number().int().min(5).max(200).default(40),
});

export const siteBlockSchema = z.discriminatedUnion('type', [
  heroBlock, textBlock, imageBlock, cardsBlock, cardBlock, statusBlock, alertBlock, buttonBlock, chartBlock,
]);

export const sitePageSchema = z.object({
  title: z.string().min(2).max(160),
  blocks: z.array(siteBlockSchema).max(60),
  note: z.string().max(300).optional().default(''),
});

export type SiteBlock = z.infer<typeof siteBlockSchema>;
export type SitePage = z.infer<typeof sitePageSchema>;

export const BLOCK_TYPES = ['hero', 'text', 'image', 'cards', 'card', 'status', 'alert', 'buttons', 'chart'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Editor palette metadata: label, icon and the empty template for each type. */
export const BLOCK_LIBRARY: Array<{ type: BlockType; label: string; description: string; template: SiteBlock }> = [
  {
    type: 'hero', label: 'Hero banner', description: 'Headline, sub-headline and up to two internal links.',
    template: { id: 'hero-new', type: 'hero', variant: 'science', eyebrow: '', title: 'New headline', subtitle: '', primaryAction: null, secondaryAction: null },
  },
  {
    type: 'text', label: 'Text', description: 'A titled paragraph of body copy.',
    template: { id: 'text-new', type: 'text', title: '', body: '', align: 'left' },
  },
  {
    type: 'image', label: 'Image', description: 'An HTTPS or internal image with alt text and caption.',
    template: { id: 'image-new', type: 'image', src: '/floodguard-mark.svg', alt: 'Describe the image', caption: '', width: 'wide' },
  },
  {
    type: 'cards', label: 'Card grid', description: 'Two to four columns of icon cards.',
    template: { id: 'cards-new', type: 'cards', title: '', columns: 3, items: [{ title: 'Sense', body: '', icon: 'sensor' }] },
  },
  {
    type: 'card', label: 'Single card', description: 'One highlighted panel with a tone.',
    template: { id: 'card-new', type: 'card', title: '', body: '', tone: 'neutral', href: '' },
  },
  {
    type: 'status', label: 'Live status', description: 'Embeds the current public status card.',
    template: { id: 'status-new', type: 'status', title: 'Current site state', source: 'public-status' },
  },
  {
    type: 'alert', label: 'Alert panel', description: 'A safety or information notice.',
    template: { id: 'alert-new', type: 'alert', title: '', body: '', tone: 'info' },
  },
  {
    type: 'buttons', label: 'Button row', description: 'Up to six internal links.',
    template: { id: 'buttons-new', type: 'buttons', items: [{ label: 'Open', href: '/status', variant: 'primary' }] },
  },
  {
    type: 'chart', label: 'Water level chart', description: 'Live water-level chart from public telemetry.',
    template: { id: 'chart-new', type: 'chart', title: 'Water level', source: 'public-history', limit: 40 },
  },
];

export function parseSitePage(input: unknown): { ok: true; page: SitePage } | { ok: false; error: string } {
  const parsed = sitePageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || 'The page definition is invalid.' };
  }
  const ids = new Set(parsed.data.blocks.map((block) => block.id));
  if (ids.size !== parsed.data.blocks.length) return { ok: false, error: 'Block ids must be unique inside a page.' };
  return { ok: true, page: parsed.data };
}
