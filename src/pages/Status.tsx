import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime, formatLevel, timeAgo, type PublicStatus } from '../api';
import { CityVisualization, WaterChart, type ChartPoint } from '../components/visuals';
import { Card, Empty, Loading, Notice, StateBadge, Stat, TrendArrow } from '../components/ui';
import { urlBase64ToUint8Array } from '../push';

/**
 * Public live status page.
 *
 * No account required. Shows the current state, last update, water level, trend,
 * barrier state, per-device health, the recent event timeline and public safety
 * instructions. Simulation samples are labelled everywhere they appear.
 */

export default function StatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [subscribeMessage, setSubscribeMessage] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pushReady, setPushReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.publicStatus();
      setStatus(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    setPushReady(typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator);
  }, []);

  async function subscribe(event: React.FormEvent) {
    event.preventDefault();
    setSubscribeMessage(null);
    try {
      const result = await api.publicConfig();
      const zone = status?.devices[0];
      void zone;
      const response = await fetch('/api/public/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, consent: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Subscription failed.');
      setSubscribeMessage(body.message || 'Check your inbox to confirm the subscription.');
      setEmail(''); setConsent(false);
      void result;
    } catch (err) {
      setSubscribeMessage((err as Error).message);
    }
  }

  async function enablePush() {
    setPushMessage(null);
    try {
      const config = await api.publicConfig();
      if (!config.webPushAvailable || !config.vapidPublicKey) {
        setPushMessage('Browser notifications are not configured on this deployment yet.');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setPushMessage('Browser notification permission was not granted.'); return; }
      const registration = await navigator.serviceWorker.register('/sw.js');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey) as BufferSource,
      });
      const json = subscription.toJSON();
      await fetch('/api/public/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => undefined);
      await api.savePush({ endpoint: json.endpoint!, keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! } });
      setPushMessage('Browser notifications are enabled for this device.');
    } catch (err) {
      setPushMessage((err as Error).message);
    }
  }

  if (loading && !status) return <Loading label="Loading live status…" />;
  if (error && !status) return <Notice tone="critical">{error}</Notice>;
  if (!status) return <Empty>No status data is available yet.</Empty>;

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Live status</h1>
          <p>{status.site.city} — {status.site.zone} · {status.site.devices} device(s) reporting · {status.site.simulationDevices} simulation node(s)</p>
        </div>
        <div className="row">
          <StateBadge state={status.current.state} label={status.current.label} />
          <span className="badge neutral">Updated {timeAgo(status.current.lastUpdateAt)}</span>
        </div>
      </div>

      {status.maintenanceMode && <Notice tone="warning">Maintenance mode is active. Telemetry ingest and alerts continue, but the site is under scheduled maintenance.</Notice>}
      {status.current.simulated && <Notice tone="simulation">SIMULATION: the current reading comes from a labelled simulation node, not from physical hardware.</Notice>}
      {status.current.emergencyStopActive && <Notice tone="critical">Emergency stop is latched on the controller. Actuation is inhibited.</Notice>}
      {!status.current.sensorHealthy && <Notice tone="warning">The sensor is reporting unhealthy data. The barrier is holding its last safe position.</Notice>}

      <div className="grid cols-2">
        <Card title="Current conditions" actions={<StateBadge state={status.current.state} label={status.current.label} />}>
          <div className="grid cols-2">
            <Stat label="Water level" value={formatLevel(status.current.levelCm)} detail={<TrendArrow trendCm={status.current.trendCm} />} tone={status.current.state as 'normal' | 'watch' | 'warning' | 'critical' | 'recovery' | 'unknown'} />
            <Stat label="Rate of rise" value={status.current.rateCmPerMin === null ? '—' : `${status.current.rateCmPerMin.toFixed(1)} cm/min`} detail="Measured over the last minute" />
            <Stat label="Barrier" value={status.current.barrier} detail={status.current.barrier === 'RAISED' ? 'Latched up' : 'Down'} />
            <Stat label="Sensor" value={status.current.sensorHealthy ? 'Healthy' : 'Fault'} detail={status.current.faultState} />
          </div>
          <p className="muted" style={{ marginTop: '0.85rem' }}>{status.current.guidance}</p>
          <p className="subtle" style={{ fontSize: '0.85rem' }}>Last update: {formatDateTime(status.current.lastUpdateAt)}</p>
        </Card>

        <CityVisualization
          levelCm={status.current.levelCm}
          state={status.current.state}
          barrier={status.current.barrier}
          simulated={status.current.simulated}
          devices={status.devices}
        />
      </div>

      <Card title="Water level — last 60 samples" subtitle="Purple markers are labelled simulation samples">
        {status.history.length ? (
          <WaterChart history={status.history as unknown as ChartPoint[]} thresholds={{ watchCm: 25, warningCm: 40, criticalCm: 55 }} />
        ) : (
          <Empty>No telemetry has been recorded yet.</Empty>
        )}
      </Card>

      <div className="grid cols-2">
        <Card title="Devices">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Device</th><th>Board</th><th>State</th><th>Level</th><th>Barrier</th><th>Last seen</th></tr>
              </thead>
              <tbody>
                {status.devices.map((device) => (
                  <tr key={device.deviceId}>
                    <td>
                      <div><strong>{device.name}</strong></div>
                      <div className="mono subtle">{device.uid}</div>
                      {device.simulation && <span className="badge unknown">SIMULATION</span>}
                    </td>
                    <td>{device.board}</td>
                    <td><StateBadge state={device.state} /></td>
                    <td>{formatLevel(device.levelCm)}</td>
                    <td>{device.barrier}</td>
                    <td>{timeAgo(device.lastUpdateAt)}</td>
                  </tr>
                ))}
                {!status.devices.length && <tr><td colSpan={6} className="muted">No enabled devices are registered yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Recent events">
          {status.events.length ? (
            <ol style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {status.events.map((event) => (
                <li key={event.id} style={{ marginBottom: '0.6rem' }}>
                  <div className="row">
                    <StateBadge state={event.toState} />
                    <span className="subtle" style={{ fontSize: '0.8rem' }}>{formatDateTime(event.createdAt)}</span>
                    {event.simulated && <span className="badge unknown">SIMULATION</span>}
                  </div>
                  <div className="muted" style={{ fontSize: '0.86rem' }}>{event.fromState} → {event.toState} · {formatLevel(event.levelCm)} · {event.reason}</div>
                </li>
              ))}
            </ol>
          ) : <Empty>No flood events have been recorded yet.</Empty>}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Public safety instructions" subtitle="Educational prototype guidance — always follow your local emergency authority">
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {status.safetyInstructions.map((instruction) => <li key={instruction}>{instruction}</li>)}
          </ul>
          <p className="subtle" style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>{status.safetyNotice}</p>
        </Card>

        <Card title="Get status updates" subtitle="Optional, double opt-in, unsubscribe link in every message">
          <form onSubmit={subscribe} className="stack" style={{ gap: '0.6rem' }}>
            <label className="field">
              <span>Email address</span>
              <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.org" maxLength={254} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
              <span>I consent to optional status updates for the monitored zone. I understand this is not an emergency alert service.</span>
            </label>
            <button className="btn" type="submit" disabled={!consent || !email}>Subscribe</button>
            {subscribeMessage && <Notice tone="info">{subscribeMessage}</Notice>}
          </form>
          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '1rem 0' }} />
          <div className="stack" style={{ gap: '0.5rem' }}>
            <strong style={{ fontSize: '0.92rem' }}>Browser notifications</strong>
            <p className="muted" style={{ fontSize: '0.86rem' }}>Get a Web Push notification when the monitored zone changes state.</p>
            <button type="button" className="btn secondary" onClick={() => void enablePush()} disabled={!pushReady}>
              Enable browser notifications
            </button>
            {pushMessage && <Notice tone="info">{pushMessage}</Notice>}
          </div>
          <p className="subtle" style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}>
            Want alerts for your account and device controls? <Link to="/register">Create an account</Link>.
          </p>
        </Card>
      </div>
    </div>
  );
}
