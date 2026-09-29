import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, BellRing, Check, Clock, Droplets, Info, Layers3, RefreshCw, ShieldAlert, TrendingUp, WifiOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import CityVisualization from '../components/CityVisualization';
import { getPublicStatus, getFloodEvents, type FloodEventRow, type PublicStatus } from '../adminApi';
import { formatTime, timeAgo } from '../api';
import type { BarrierState, FloodState } from '../../shared/flood-state';

const stateTone: Record<string, string> = {
  NORMAL: 'safe', RECOVERY: 'safe', WATCH: 'watch', WARNING: 'warning', CRITICAL: 'critical', UNKNOWN: 'unknown', FAULT: 'fault',
};

function StatusStateBadge({ status }: { status: PublicStatus }) {
  const tone = stateTone[status.state] || 'unknown';
  return (
    <div className={`status-hero-badge tone-${tone}`} role="status" aria-live="polite">
      <span className="status-hero-icon" aria-hidden="true">
        {status.state === 'CRITICAL' ? <AlertTriangle size={28} /> : status.state === 'NORMAL' ? <Check size={28} /> : <Droplets size={28} />}
      </span>
      <div>
        <strong>{status.stateLabel}</strong>
        <span>Water system state · text + icon + colour</span>
      </div>
    </div>
  );
}

function SubscribePanel() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setWorking(true); setError(''); setDone('');
    try {
      const response = await fetch('/api/notifications/email', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true, email }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Subscription failed.');
      setDone(body.message || 'Check your inbox to confirm your subscription.');
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : 'Subscription failed.');
    } finally { setWorking(false); }
  };
  return (
    <section className="panel status-subscribe-panel">
      <div className="panel-heading-row"><div><span className="panel-eyebrow"><BellRing size={13} /> PUBLIC UPDATES</span><h2>Get status change emails</h2></div></div>
      <p className="status-subscribe-copy">Optional project updates with double opt-in. This is not an emergency warning service.</p>
      <form className="status-subscribe-form" onSubmit={(event) => void submit(event)}>
        <label className="sr-only" htmlFor="status-email">Email address</label>
        <input id="status-email" type="email" required maxLength={254} placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
        <button type="submit" disabled={working}>{working ? 'Sending…' : 'Subscribe'}</button>
      </form>
      {done && <p className="admin-feedback" role="status"><Check size={14} /> {done}</p>}
      {error && <p className="admin-feedback admin-feedback-error" role="alert">{error}</p>}
    </section>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [events, setEvents] = useState<FloodEventRow[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [statusResult, eventResult] = await Promise.all([getPublicStatus(), getFloodEvents(10)]);
      setStatus(statusResult);
      setEvents(eventResult.events);
      setError('');
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : 'Status API unavailable.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className="inner-page page-width status-page">
      <div className="inner-page-heading">
        <span className="section-kicker">LIVE PUBLIC STATUS</span>
        <h1>Smart Flood Control — current conditions</h1>
        <p>Every value on this page comes from the device API or is explicitly labeled SIMULATION. Educational prototype — not an emergency service.</p>
        <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh status"><RefreshCw size={16} /></button>
      </div>
      {error && <div className="api-error"><WifiOff size={17} /><span><strong>Status unavailable</strong>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
      {status?.simulation && (
        <div className="simulation-stamp" role="note">
          <ShieldAlert size={16} /> <span><strong>SIMULATION MODE</strong> — {status.simulationNotice}</span>
        </div>
      )}
      {status && (
        <>
          <section className="status-hero-grid">
            <StatusStateBadge status={status} />
            <div className="status-hero-readouts">
              <div className="status-readout"><Droplets size={18} /><span>Water level</span><strong>{status.levelCm === null ? '—' : `${status.levelCm.toFixed(1)} cm`}</strong></div>
              <div className="status-readout"><TrendingUp size={18} /><span>Trend</span><strong>{status.trendCm >= 0 ? '+' : ''}{status.trendCm} cm · {status.rateOfRiseCmPerMin >= 0 ? '+' : ''}{status.rateOfRiseCmPerMin} cm/min</strong></div>
              <div className="status-readout"><Layers3 size={18} /><span>Barrier</span><strong>{status.barrier}{status.barrierLatched ? ' · latched' : ''}</strong></div>
              <div className="status-readout"><Clock size={18} /><span>Last update</span><strong>{timeAgo(status.lastSampleAt)} · {formatTime(status.lastSampleAt)}</strong></div>
              <div className="status-readout"><Info size={18} /><span>Sensor health</span><strong>{status.sensorHealthy ? 'Healthy' : 'Fault / stale'}</strong></div>
              <div className="status-readout"><BellRing size={18} /><span>Devices online</span><strong>{status.devicesOnline} / {status.devicesTotal}</strong></div>
            </div>
          </section>

          <CityVisualization
            levelCm={status.levelCm}
            state={status.state as FloodState}
            barrier={status.barrier as BarrierState}
            simulation={status.simulation}
          />

          <div className="status-two-col">
            <section className="panel status-safety-panel">
              <div className="panel-heading-row"><div><span className="panel-eyebrow"><ShieldAlert size={13} /> PUBLIC SAFETY INSTRUCTIONS</span><h2>What to do</h2></div></div>
              <ol className="status-safety-list">
                {status.safetyInstructions.map((instruction, index) => (
                  <li key={instruction}><span>{index + 1}</span>{instruction}</li>
                ))}
              </ol>
            </section>
            <SubscribePanel />
          </div>

          <section className="panel status-events-panel">
            <div className="panel-heading-row"><div><span className="panel-eyebrow"><Droplets size={13} /> RECENT STATE CHANGES</span><h2>Alert timeline</h2></div><Link className="panel-text-link" to="/alerts">Full timeline <ArrowRight size={14} /></Link></div>
            {events.length === 0 && <p className="empty-note">No recorded state changes yet.</p>}
            <ul className="event-timeline">
              {events.map((event) => (
                <li key={event.id} className={`event-timeline-item tone-${stateTone[event.state] || 'unknown'}`}>
                  <div className="event-timeline-marker"><Droplets size={14} /></div>
                  <div>
                    <strong>{event.state}{event.simulation ? ' · SIMULATION' : ''}</strong>
                    <p>{event.reason}</p>
                    <small>{timeAgo(event.createdAt)} · {event.levelCm === null ? '—' : `${event.levelCm.toFixed(1)} cm`}</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      {!status && !error && <div className="app-loading"><span className="loading-spinner"></span><strong>Loading current status…</strong><small>Live values are never served from cache.</small></div>}
    </main>
  );
}
