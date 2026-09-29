import { useMemo } from 'react';
import type { PublicStatus } from '../api';
import { STATE_LABELS } from '../../shared/flood-engine';


/**
 * Interactive city visualization.
 *
 * An elevated island city surrounded by water: sensor markers report live levels,
 * the perimeter barrier animates between open and closed, and the water level
 * rises and falls with real telemetry. Every state is also shown as text and an
 * icon, so nothing depends on animation to be understood.
 */

interface CityVisualizationProps {
  levelCm: number | null;
  state: string;
  barrier: string;
  simulated: boolean;
  devices: PublicStatus['devices'];
  maxLevelCm?: number;
}

const WATER_BOTTOM = 300;
const WATER_TOP = 40;
const ISLAND_TOP = 150;

export function CityVisualization({ levelCm, state, barrier, simulated, devices, maxLevelCm = 80 }: CityVisualizationProps) {
  const ratio = Math.max(0, Math.min(1, (levelCm ?? 0) / maxLevelCm));
  const waterY = WATER_BOTTOM - (WATER_BOTTOM - WATER_TOP) * ratio;
  const barrierClosed = barrier === 'RAISED' || barrier === 'RAISING';
  const barrierY = ISLAND_TOP + 6;

  const sensors = useMemo(() => devices.slice(0, 6), [devices]);

  return (
    <div className="city-viz" role="img" aria-label={`Elevated city island with ${(levelCm ?? 0).toFixed(1)} centimetres of surrounding water, state ${STATE_LABELS[state as keyof typeof STATE_LABELS] || state}, barrier ${barrier}`}>
      <svg viewBox="0 0 400 320" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="waterGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82c4" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#0d3a63" stopOpacity="0.95" />
          </linearGradient>
          <linearGradient id="islandGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2f7d54" />
            <stop offset="100%" stopColor="#1c543a" />
          </linearGradient>
        </defs>

        {/* water */}
        <rect className="water-fill" x="0" y={waterY} width="400" height={WATER_BOTTOM - waterY} fill="url(#waterGradient)" />
        <line x1="0" y1={waterY} x2="400" y2={waterY} stroke="#8fd0ff" strokeWidth="1.5" opacity="0.9" />

        {/* raised island city */}
        <path d={`M 90 ${ISLAND_TOP + 60} L 120 ${ISLAND_TOP + 20} L 280 ${ISLAND_TOP + 20} L 310 ${ISLAND_TOP + 60} Z`} fill="url(#islandGradient)" stroke="#0f3d29" strokeWidth="1.5" />
        {/* buildings */}
        {[
          { x: 140, w: 26, h: 46 }, { x: 174, w: 34, h: 66 }, { x: 216, w: 24, h: 52 }, { x: 246, w: 30, h: 40 },
        ].map((building) => (
          <g key={building.x}>
            <rect x={building.x} y={ISLAND_TOP + 74 - building.h} width={building.w} height={building.h} rx="2" fill="#dfe7f2" stroke="#9fb0c8" />
            <rect x={building.x + 4} y={ISLAND_TOP + 80 - building.h} width={building.w - 8} height={6} fill="#7f93ae" opacity="0.6" />
          </g>
        ))}

        {/* perimeter barrier */}
        <g>
          <rect x="112" y={barrierY - 4} width="176" height="6" rx="2" fill="#8a6d1f" />
          {Array.from({ length: 15 }).map((_, index) => {
            const x = 116 + index * 11.6;
            const raised = barrierClosed;
            return (
              <rect key={x} x={x} y={raised ? barrierY - 26 : barrierY} width="6" height={raised ? 26 : 4} rx="1.5"
                fill={raised ? '#d4af37' : '#b9c7da'} stroke="#6b5210" strokeWidth="0.5" style={{ transition: 'y 500ms ease, height 500ms ease' }} />
            );
          })}
          <text x="200" y={barrierY - 32} textAnchor="middle" fill="#f0d888" fontSize="9" fontWeight="700">
            {barrierClosed ? 'BARRIER UP' : 'BARRIER DOWN'}
          </text>
        </g>

        {/* sensor markers */}
        {sensors.map((device, index) => {
          const angle = (index / Math.max(1, sensors.length)) * Math.PI * 2;
          const cx = 200 + Math.cos(angle) * 128;
          const cy = ISLAND_TOP + 52 + Math.sin(angle) * 46;
          const active = device.online;
          return (
            <g key={device.deviceId}>
              <circle cx={cx} cy={cy} r="7" fill={active ? '#22c55e' : '#64748b'} stroke="#0b1220" strokeWidth="1.5" />
              <circle cx={cx} cy={cy} r="12" fill="none" stroke={active ? '#22c55e' : '#64748b'} strokeWidth="1" opacity="0.45" />
              <title>{`${device.name} — ${device.levelCm === null ? 'no data' : `${device.levelCm.toFixed(1)} cm`}`}</title>
            </g>
          );
        })}

        {/* water level marker */}
        <g>
          <line x1="370" y1={waterY} x2="386" y2={waterY} stroke="#8fd0ff" strokeWidth="2" />
          <text x="366" y={waterY - 6} textAnchor="end" fill="#cfe6ff" fontSize="11" fontWeight="700">
            {(levelCm ?? 0).toFixed(1)} cm
          </text>
        </g>

        {/* state label */}
        <text x="16" y="26" fill="#eaf1fb" fontSize="12" fontWeight="800" letterSpacing="0.08em">
          {STATE_LABELS[state as keyof typeof STATE_LABELS] || state}
        </text>
      </svg>
      {simulated && <span className="sim-flag">SIMULATION</span>}
      <div className="legend">
        <span>Island city</span>
        <span>Sensor nodes</span>
        <span>Perimeter barrier</span>
        <span>Surrounding water</span>
      </div>
    </div>
  );
}

/** Minimal telemetry shape the chart needs. */
export interface ChartPoint { id?: string; seq?: number; levelCm: number | null; state?: string; rateCmPerMin?: number | null; simulated?: boolean; createdAt: string }

/** Water level chart with threshold bands. */
export function WaterChart({ history, thresholds }: { history: ChartPoint[]; thresholds?: { watchCm: number; warningCm: number; criticalCm: number } }) {
  const width = 640;
  const height = 220;
  const padding = { top: 14, right: 12, bottom: 24, left: 34 };
  const points: ChartPoint[] = history.slice(-60);
  const maxLevel = Math.max(60, ...points.map((point) => point.levelCm ?? 0), thresholds?.criticalCm ?? 0) * 1.1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index: number) => padding.left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (level: number) => padding.top + plotHeight - (Math.max(0, Math.min(maxLevel, level)) / maxLevel) * plotHeight;
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(point.levelCm ?? 0).toFixed(1)}`).join(' ');
  const areaPath = points.length ? `${linePath} L ${x(points.length - 1).toFixed(1)} ${(padding.top + plotHeight).toFixed(1)} L ${x(0).toFixed(1)} ${(padding.top + plotHeight).toFixed(1)} Z` : '';

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Water level chart, ${points.length} samples, latest ${points.length ? (points[points.length - 1]!.levelCm ?? 0).toFixed(1) : 0} centimetres`}>
      <defs>
        <linearGradient id="waterGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
        <g key={fraction}>
          <line className="grid-line" x1={padding.left} y1={padding.top + plotHeight * fraction} x2={width - padding.right} y2={padding.top + plotHeight * fraction} />
          <text className="axis-label" x={padding.left - 6} y={padding.top + plotHeight * fraction + 3} textAnchor="end">
            {Math.round(maxLevel * (1 - fraction))}
          </text>
        </g>
      ))}
      {thresholds && (
        <>
          <line className="threshold" x1={padding.left} y1={y(thresholds.watchCm)} x2={width - padding.right} y2={y(thresholds.watchCm)} stroke="var(--state-watch)" />
          <line className="threshold" x1={padding.left} y1={y(thresholds.warningCm)} x2={width - padding.right} y2={y(thresholds.warningCm)} stroke="var(--state-warning)" />
          <line className="threshold" x1={padding.left} y1={y(thresholds.criticalCm)} x2={width - padding.right} y2={y(thresholds.criticalCm)} stroke="var(--state-critical)" />
        </>
      )}
      {areaPath && <path className="area" d={areaPath} fill="url(#waterGradient)" />}
      {linePath && <path className="line" d={linePath} />}
      {points.map((point, index) => (
        <circle key={point.id || index} cx={x(index)} cy={y(point.levelCm ?? 0)} r={point.simulated ? 2.4 : 3} fill={point.simulated ? '#7c3aed' : 'var(--brand)'} opacity={point.simulated ? 0.85 : 1}>
          <title>{`${point.createdAt} — ${(point.levelCm ?? 0).toFixed(1)} cm${point.simulated ? ' (simulation)' : ''}`}</title>
        </circle>
      ))}
      <text className="axis-label" x={padding.left} y={height - 6}>older</text>
      <text className="axis-label" x={width - padding.right} y={height - 6} textAnchor="end">now</text>
    </svg>
  );
}

/** Renders schema-driven site blocks. Only whitelisted block types exist. */
export function BlockRenderer({ blocks }: { blocks: PublicStatus['history'] | never[] | unknown[] }) {
  const items = (blocks || []) as Array<Record<string, unknown>>;
  if (!items.length) return null;
  return (
    <>
      {items.map((block) => {
        const type = String(block.type || '');
        const key = String(block.id || type);
        if (type === 'hero') {
          return (
            <section className="hero" key={key}>
              {Boolean(block.eyebrow) && <span className="eyebrow">{String(block.eyebrow)}</span>}
              <h1>{String(block.title || '')}</h1>
              {Boolean(block.subtitle) && <p>{String(block.subtitle)}</p>}
              <div className="actions">
                {Boolean(block.primaryAction) && (
                  <a className="btn" href={String((block.primaryAction as { href?: string }).href || '/status')}>
                    {String((block.primaryAction as { label?: string }).label || 'Open')}
                  </a>
                )}
                {Boolean(block.secondaryAction) && (
                  <a className="btn secondary" href={String((block.secondaryAction as { href?: string }).href || '/status')}>
                    {String((block.secondaryAction as { label?: string }).label || 'Learn more')}
                  </a>
                )}
              </div>
            </section>
          );
        }
        if (type === 'text') {
          return (
            <section key={key} className="section">
              {Boolean(block.title) && <h2>{String(block.title)}</h2>}
              <p style={block.align === 'center' ? { textAlign: 'center' } : undefined}>{String(block.body || '')}</p>
            </section>
          );
        }
        if (type === 'image') {
          return (
            <figure className="block-image section" key={key} style={{ maxWidth: block.width === 'narrow' ? 420 : '100%' }}>
              <img src={String(block.src || '')} alt={String(block.alt || '')} loading="lazy" />
              {Boolean(block.caption) && <figcaption>{String(block.caption)}</figcaption>}
            </figure>
          );
        }
        if (type === 'cards') {
          const items2 = (block.items || []) as Array<Record<string, string>>;
          return (
            <section className="section" key={key}>
              {Boolean(block.title) && <h2>{String(block.title)}</h2>}
              <div className="cardgrid" style={{ ['--cols' as string]: String(block.columns || 3) }}>
                {items2.map((item, index) => (
                  <article className="minicard" key={`${key}-${index}`}>
                    <h4>{item.title}</h4>
                    <p>{item.body}</p>
                  </article>
                ))}
              </div>
            </section>
          );
        }
        if (type === 'card') {
          return (
            <section className="section" key={key}>
              <article className="card">
                <h3>{String(block.title || '')}</h3>
                <p className="muted">{String(block.body || '')}</p>
                {Boolean(block.href) && <a className="btn secondary small" href={String(block.href)}>Open</a>}
              </article>
            </section>
          );
        }
        if (type === 'alert') {
          const tone = String(block.tone || 'info');
          return (
            <div className={`notice ${tone}`} key={key} role={tone === 'critical' ? 'alert' : 'status'}>
              <strong>{String(block.title || '')}</strong>
              <div>{String(block.body || '')}</div>
            </div>
          );
        }
        if (type === 'buttons') {
          const buttons = (block.items || []) as Array<Record<string, string>>;
          return (
            <div className="row section" key={key}>
              {buttons.map((button, index) => (
                <a key={`${key}-${index}`} className={`btn ${button.variant === 'primary' ? '' : button.variant || 'secondary'}`} href={button.href || '/'}>
                  {button.label || 'Open'}
                </a>
              ))}
            </div>
          );
        }
        return null;
      })}
    </>
  );
}
