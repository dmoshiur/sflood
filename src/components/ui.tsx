import type { ReactNode } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock, Droplets, Gauge, Info, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';

/** Shared presentational primitives used across every page. */

export type Tone = 'normal' | 'watch' | 'warning' | 'critical' | 'recovery' | 'unknown' | 'neutral';

const STATE_TONE: Record<string, Tone> = {
  NORMAL: 'normal', WATCH: 'watch', WARNING: 'warning', CRITICAL: 'critical', RECOVERY: 'recovery',
  UNKNOWN: 'unknown', FAULT: 'critical',
};

export function toneForState(state: string): Tone {
  return STATE_TONE[(state || '').toUpperCase()] || 'unknown';
}

const STATE_ICON: Record<string, ReactNode> = {
  normal: <CheckCircle2 size={14} aria-hidden />,
  watch: <Clock size={14} aria-hidden />,
  warning: <AlertTriangle size={14} aria-hidden />,
  critical: <ShieldAlert size={14} aria-hidden />,
  recovery: <RefreshCw size={14} aria-hidden />,
  unknown: <Info size={14} aria-hidden />,
  neutral: <Gauge size={14} aria-hidden />,
};

export function StateBadge({ state, label, compact = false }: { state: string; label?: string; compact?: boolean }) {
  const tone = toneForState(state);
  return (
    <span className={`badge ${tone}`} title={`State: ${state}`}>
      {STATE_ICON[tone]}
      <span>{label || state}</span>
      {!compact && <span className="sr-only"> state indicator</span>}
    </span>
  );
}

export function HealthBadge({ health }: { health: string }) {
  const tone: Tone = health === 'ONLINE' ? 'normal' : health === 'STALE' ? 'watch' : health === 'DISABLED' ? 'neutral' : 'critical';
  return <span className={`badge ${tone}`}>{STATE_ICON[tone]}<span>{health}</span></span>;
}

export function Card({ title, subtitle, actions, children, tone }: { title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode; tone?: Tone }) {
  return (
    <section className="card" style={tone ? { borderLeft: `4px solid var(--state-${tone === 'neutral' ? 'unknown' : tone})` } : undefined}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: `var(--state-${tone === 'neutral' ? 'unknown' : tone})` } : undefined}>{value}</div>
      {detail && <div className="detail">{detail}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'success' | 'warning' | 'critical' | 'simulation'; children: ReactNode }) {
  return <div className={`notice ${tone}`} role={tone === 'critical' ? 'alert' : 'status'}>{children}</div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading"><span className="spinner" aria-hidden /> <span>{label}</span></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="error" role="alert">{children}</p>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="error">{error}</span>}
    </label>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={active === tab.id} className={active === tab.id ? 'active' : ''} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TrendArrow({ trendCm }: { trendCm: number }) {
  if (!Number.isFinite(trendCm) || trendCm === 0) return <span className="subtle">steady</span>;
  const rising = trendCm > 0;
  return (
    <span style={{ color: rising ? 'var(--state-warning)' : 'var(--state-recovery)', fontWeight: 600 }}>
      {rising ? '▲' : '▼'} {Math.abs(trendCm).toFixed(1)} cm
    </span>
  );
}

export function LevelIcon({ size = 16 }: { size?: number }) {
  return <Droplets size={size} aria-hidden />;
}

export function ActivityIcon() {
  return <Activity size={16} aria-hidden />;
}

export function WrenchIcon() {
  return <Wrench size={16} aria-hidden />;
}
