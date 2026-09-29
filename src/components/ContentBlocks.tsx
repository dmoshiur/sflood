/**
 * Public renderer for schema-driven site content.
 *
 * Renders only the allowlisted block types validated server-side (hero, text,
 * image, card, status, alert, button, chart). Links and image sources are
 * re-checked client-side (internal /path or https:// only) before rendering.
 * The status and chart blocks read live values from the public API — real
 * telemetry or explicitly labeled SIMULATION — and never fabricate data.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, BarChart3, Bell, ExternalLink, Info, ShieldAlert, TriangleAlert, Waves } from 'lucide-react';
import { getFloodEvents, getPublicStatus, type FloodEventRow, type PublicStatus } from '../adminApi';

export interface ContentBlockData {
  type: 'hero' | 'text' | 'image' | 'card' | 'status' | 'alert' | 'button' | 'chart';
  eyebrow?: string;
  title?: string;
  body?: string;
  image?: { src: string; alt: string };
  button?: { label: string; href: string };
  src?: string;
  alt?: string;
  caption?: string;
  icon?: string;
  level?: 'INFO' | 'WARNING' | 'CRITICAL';
  label?: string;
  href?: string;
  style?: 'primary' | 'secondary';
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** Internal paths or absolute https URLs only — mirrors the server-side rule. */
export function isSafeHref(href: string): boolean {
  if (href.startsWith('/') && !href.startsWith('//')) return true;
  try { return new URL(href).protocol === 'https:'; } catch { return false; }
}

function isSafeImageSrc(src: string): boolean {
  if (/^\/[\w\-./]+$/.test(src)) return true;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && (url.hostname === 'res.cloudinary.com' || url.hostname.endsWith('.cloudinary.com'));
  } catch { return false; }
}

function SafeLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  if (!isSafeHref(href)) return <span className={className}>{children}</span>;
  const external = href.startsWith('https://');
  return <a className={className} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>;
}

function useLiveStatus(): { status: PublicStatus | null; error: string | null } {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getPublicStatus().then(setStatus).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Status unavailable.'));
  }, []);
  return { status, error };
}

function StatusBlock({ block }: { block: ContentBlockData }) {
  const { status, error } = useLiveStatus();
  return <div className="cb cb-status">
    <div className="cb-status-head">
      <Waves size={18} />
      <strong>{str(block.title, 'Live status')}</strong>
      {status && <span className={`cb-status-chip ${String(status.state).toLowerCase()}`}>{status.stateLabel}</span>}
    </div>
    {status ? (
      <div className="cb-status-grid">
        <div><span>Water level</span><strong>{status.levelCm === null ? '—' : `${status.levelCm.toFixed(1)} cm`}</strong></div>
        <div><span>Trend</span><strong>{status.trendCm >= 1 ? 'RISING' : status.trendCm <= -1 ? 'FALLING' : 'STEADY'}</strong></div>
        <div><span>Barrier</span><strong>{status.barrier}{status.barrierLatched ? ' (latched)' : ''}</strong></div>
        <div><span>Updated</span><strong>{new Date(status.lastUpdate).toLocaleTimeString()}</strong></div>
      </div>
    ) : <p className="cb-muted">{error ?? 'Loading live status…'}</p>}
    {status?.simulationNotice && <p className="cb-simulation">{status.simulationNotice}</p>}
    <SafeLink href="/status" className="cb-inline-link">Open the full live status board <ArrowRight size={13} /></SafeLink>
  </div>;
}

function ChartBlock({ block }: { block: ContentBlockData }) {
  const { status } = useLiveStatus();
  const [events, setEvents] = useState<FloodEventRow[] | null>(null);
  useEffect(() => {
    getFloodEvents(30).then((payload) => setEvents(payload.events)).catch(() => setEvents([]));
  }, []);

  // Real series only: water levels recorded at flood-event transitions + the
  // current level as the newest point. Sparse is honest; fabricated curves are not.
  const series: Array<{ at: number; level: number }> = (events ?? [])
    .filter((event) => typeof event.levelCm === 'number')
    .map((event) => ({ at: new Date(event.createdAt).getTime(), level: event.levelCm as number }))
    .reverse();
  if (status && typeof status.levelCm === 'number') {
    series.push({ at: new Date(status.lastSampleAt).getTime(), level: status.levelCm });
  }

  return <div className="cb cb-chart">
    <div className="cb-status-head"><BarChart3 size={18} /><strong>{str(block.title, 'Water level (live telemetry)')}</strong></div>
    {series.length >= 2 ? <LevelSparkline points={series} /> : <p className="cb-muted">Not enough recorded samples yet — the chart appears once real telemetry exists.</p>}
    <p className="cb-chart-note">Recorded levels at flood-event transitions and the latest sample{status?.simulation ? ' (SIMULATION feed)' : ''}.</p>
    {status?.simulationNotice && <p className="cb-simulation">{status.simulationNotice}</p>}
  </div>;
}

function LevelSparkline({ points }: { points: Array<{ at: number; level: number }> }) {
  const width = 560; const height = 150; const pad = 18;
  const times = points.map((point) => point.at);
  const levels = points.map((point) => point.level);
  const minT = Math.min(...times); const maxT = Math.max(...times);
  const maxLevel = Math.max(...levels, 60);
  const x = (time: number) => pad + (maxT === minT ? 0.5 : (time - minT) / (maxT - minT)) * (width - pad * 2);
  const y = (level: number) => height - pad - (level / maxLevel) * (height - pad * 2);
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.at).toFixed(1)} ${y(point.level).toFixed(1)}`).join(' ');
  return <svg className="cb-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Water level history">
    <line x1={pad} y1={y(0)} x2={width - pad} y2={y(0)} className="cb-chart-grid" />
    <line x1={pad} y1={y(50)} x2={width - pad} y2={y(50)} className="cb-chart-grid cb-chart-grid-critical" />
    <text x={width - pad} y={y(50) - 4} className="cb-chart-label" textAnchor="end">critical 50 cm</text>
    <path d={path} className="cb-chart-line" fill="none" />
    {points.map((point, index) => <circle key={index} cx={x(point.at)} cy={y(point.level)} r={3.5} className="cb-chart-dot" />)}
  </svg>;
}

function AlertBlock({ block }: { block: ContentBlockData }) {
  const level = block.level ?? 'INFO';
  const Icon = level === 'CRITICAL' ? ShieldAlert : level === 'WARNING' ? TriangleAlert : Info;
  return <div className={`cb cb-alert cb-alert-${level.toLowerCase()}`}>
    <Icon size={19} />
    <div><strong>{str(block.title)}</strong><p>{str(block.body)}</p></div>
  </div>;
}

function ContentBlockView({ block }: { block: ContentBlockData }) {
  switch (block.type) {
    case 'hero':
      return <section className="cb cb-hero">
        {str(block.eyebrow) && <span className="cb-eyebrow">{str(block.eyebrow)}</span>}
        <h2>{str(block.title)}</h2>
        {str(block.body) && <p>{str(block.body)}</p>}
        {block.image && isSafeImageSrc(block.image.src) && <img src={block.image.src} alt={str(block.image.alt)} />}
        {block.button && <SafeLink href={block.button.href} className="cb-button cb-button-primary">{str(block.button.label)} <ArrowRight size={15} /></SafeLink>}
      </section>;
    case 'text':
      return <section className="cb cb-text">{str(block.title) && <h3>{str(block.title)}</h3>}<p>{str(block.body)}</p></section>;
    case 'image':
      return isSafeImageSrc(str(block.src)) ? <figure className="cb cb-image"><img src={str(block.src)} alt={str(block.alt)} />{str(block.caption) && <figcaption>{str(block.caption)}</figcaption>}</figure> : null;
    case 'card':
      return <div className="cb cb-card"><div className="cb-card-icon"><Bell size={17} /></div><div><strong>{str(block.title)}</strong><p>{str(block.body)}</p></div></div>;
    case 'status': return <StatusBlock block={block} />;
    case 'chart': return <ChartBlock block={block} />;
    case 'alert': return <AlertBlock block={block} />;
    case 'button':
      return <SafeLink href={str(block.href)} className={`cb-button ${block.style === 'secondary' ? 'cb-button-secondary' : 'cb-button-primary'}`}>{str(block.label)} <ExternalLink size={14} /></SafeLink>;
    default: return null;
  }
}

export function ContentBlocks({ blocks }: { blocks: ContentBlockData[] }) {
  return <div className="content-blocks-public">{blocks.map((block, index) => <ContentBlockView key={index} block={block} />)}</div>;
}
