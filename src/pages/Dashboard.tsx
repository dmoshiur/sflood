import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime, formatLevel, timeAgo, type PublicStatus } from '../api';
import { CityVisualization, WaterChart, type ChartPoint } from '../components/visuals';
import { Card, Empty, HealthBadge, Loading, Notice, StateBadge, Stat, TrendArrow } from '../components/ui';
import { useAuth } from '../App';

/**
 * Member dashboard: real-time telemetry, live city visualization, water-level
 * chart, device cards, the alert timeline and quick barrier controls for staff.
 * Every value comes from the API; nothing is fabricated client-side.
 */

export default function DashboardPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [devices, setDevices] = useState<Array<Record<string, unknown>>>([]);
  const [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [live, deviceList] = await Promise.all([api.publicStatus(), api.devices().catch(() => ({ mode: 'unavailable', devices: [] }))]);
      setStatus(live);
      setDevices(deviceList.devices as unknown as Array<Record<string, unknown>>);
      setError(null);
      if (user && ['OPERATOR', 'ADMIN', 'OWNER'].includes(user.role)) {
        try { const result = await api.alerts(); setAlerts(result.alerts as unknown as Array<Record<string, unknown>>); } catch { /* alerts need staff */ }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 12_000);
    return () => clearInterval(timer);
  }, [load]);

  async function command(deviceId: string, action: string) {
    setBusy(true); setCommandMessage(null);
    try {
      const result = await api.issueBarrierCommand(deviceId, action, 'Manual command from the dashboard');
      setCommandMessage(result.message);
    } catch (err) {
      setCommandMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !status) return <Loading label="Loading live telemetry…" />;
  if (error && !status) return <Notice tone="critical">{error}</Notice>;
  if (!status) return <Empty>No telemetry is available yet.</Empty>;

  const staff = Boolean(user && ['OPERATOR', 'ADMIN', 'OWNER'].includes(user.role));
  const liveDevices: Array<Record<string, unknown>> = devices.length
    ? (devices as unknown as Array<Record<string, unknown>>)
    : (status.devices as unknown as Array<Record<string, unknown>>);

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Command centre</h1>
          <p>{status.site.city} — {status.site.zone} · last update {timeAgo(status.current.lastUpdateAt)} · database mode {status.mode}</p>
        </div>
        <div className="row">
          <StateBadge state={status.current.state} label={status.current.label} />
          <button type="button" className="btn secondary small" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {!user?.emailVerified && <Notice tone="warning">Confirm your email address to receive alerts. <Link to="/app/profile">Resend the confirmation link</Link>.</Notice>}
      {status.current.simulated && <Notice tone="simulation">SIMULATION: this reading comes from a labelled simulation node.</Notice>}

      <div className="grid cols-4">
        <Stat label="Water level" value={formatLevel(status.current.levelCm)} detail={<TrendArrow trendCm={status.current.trendCm} />} tone={status.current.state as 'normal' | 'watch' | 'warning' | 'critical' | 'recovery' | 'unknown'} />
        <Stat label="Rate of rise" value={status.current.rateCmPerMin === null ? '—' : `${status.current.rateCmPerMin.toFixed(1)} cm/min`} detail="Last 60 seconds" />
        <Stat label="Barrier" value={status.current.barrier} detail={status.current.barrier === 'RAISED' ? 'Latched up' : 'Down'} />
        <Stat label="Devices online" value={`${liveDevices.filter((device) => String(device.health || '') === 'ONLINE').length}/${liveDevices.length}`} detail="Reporting in the last 3 intervals" />
      </div>

      <div className="grid cols-2">
        <CityVisualization levelCm={status.current.levelCm} state={status.current.state} barrier={status.current.barrier} simulated={status.current.simulated} devices={status.devices} />
        <Card title="Policy state" subtitle="Absolute thresholds, rate of rise, hysteresis and cooldown are applied by the server-side engine.">
          <dl className="kv">
            <dt>State</dt><dd><StateBadge state={status.current.state} label={status.current.label} /></dd>
            <dt>Guidance</dt><dd>{status.current.guidance}</dd>
            <dt>Last event</dt><dd>{status.current.lastEvent ? `${status.current.lastEvent.fromState} → ${status.current.lastEvent.toState}` : 'None recorded'}</dd>
            <dt>Event reason</dt><dd>{status.current.lastEvent?.reason || '—'}</dd>
            <dt>Sensor</dt><dd>{status.current.sensorHealthy ? 'Healthy' : 'Fault reported'}</dd>
            <dt>Fault state</dt><dd>{status.current.faultState}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Water level" subtitle="Purple markers are labelled simulation samples">
        {status.history.length ? <WaterChart history={status.history as unknown as ChartPoint[]} thresholds={{ watchCm: 25, warningCm: 40, criticalCm: 55 }} /> : <Empty>No telemetry recorded yet.</Empty>}
      </Card>

      <section>
        <h2>Devices</h2>
        <div className="grid cols-3">
          {liveDevices.map((device) => {
            const id = String(device.id || '');
            const uid = String(device.uid || '');
            return (
              <Card
                key={id}
                title={String(device.name || '')}
                subtitle={`${String(device.board || '')} · ${String(device.zoneName || status.site.zone)}`}
                actions={<HealthBadge health={String(device.health || 'UNKNOWN')} />}
              >
                <dl className="kv">
                  <dt>UID</dt><dd className="mono">{uid}</dd>
                  <dt>State</dt><dd><StateBadge state={String(device.currentState || device.state || 'NORMAL')} /></dd>
                  <dt>Level</dt><dd>{formatLevel(device.latestLevelCm === undefined ? (device.levelCm as number | null) ?? null : (device.latestLevelCm as number | null))}</dd>
                  <dt>Barrier</dt><dd>{String(device.barrierState || device.barrier || 'DOWN')}</dd>
                  <dt>Firmware</dt><dd>{String(device.firmwareVersion || 'unknown')}</dd>
                  <dt>Signal</dt><dd>{device.signalDbm === null || device.signalDbm === undefined ? '—' : `${String(device.signalDbm)} dBm`}</dd>
                  <dt>Uptime</dt><dd>{device.uptimeSeconds ? `${Math.floor(Number(device.uptimeSeconds) / 60)} min` : '—'}</dd>
                  <dt>Approval</dt><dd>{String(device.approvalState || 'APPROVED')}{device.simulation ? ' · SIMULATION' : ''}</dd>
                </dl>
                {staff && !device.simulation && (
                  <div className="row" style={{ marginTop: '0.75rem' }}>
                    <button type="button" className="btn small" disabled={busy} onClick={() => void command(id, 'RAISE')}>Raise</button>
                    <button type="button" className="btn secondary small" disabled={busy} onClick={() => void command(id, 'LOWER')}>Lower</button>
                    <button type="button" className="btn danger small" disabled={busy} onClick={() => void command(id, 'EMERGENCY_STOP')}>E-stop</button>
                  </div>
                )}
              </Card>
            );
          })}
          {!liveDevices.length && <Empty>No devices are registered yet. Register one from the admin console.</Empty>}
        </div>
        {commandMessage && <Notice tone="info">{commandMessage}</Notice>}
      </section>

      <section>
        <h2>Alert timeline</h2>
        <Card title="Recent flood events">
          {status.events.length ? (
            <ol style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {status.events.map((event) => (
                <li key={event.id} style={{ marginBottom: '0.7rem' }}>
                  <div className="row">
                    <StateBadge state={event.toState} />
                    <span className="subtle" style={{ fontSize: '0.8rem' }}>{formatDateTime(event.createdAt)}</span>
                    {event.simulated && <span className="badge unknown">SIMULATION</span>}
                  </div>
                  <div className="muted" style={{ fontSize: '0.88rem' }}>{event.fromState} → {event.toState} · {formatLevel(event.levelCm)} · {event.reason}</div>
                </li>
              ))}
            </ol>
          ) : <Empty>No events recorded yet.</Empty>}
        </Card>
        {staff && alerts.length > 0 && (
          <Card title="Unacknowledged events">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Transition</th><th>Level</th><th>Reason</th><th /></tr></thead>
                <tbody>
                  {alerts.filter((alert) => !alert.acknowledged).slice(0, 8).map((alert) => (
                    <tr key={String(alert.id)}>
                      <td>{timeAgo(String(alert.createdAt))}</td>
                      <td>{String(alert.fromState)} → {String(alert.toState)}</td>
                      <td>{formatLevel(alert.levelCm as number | null)}</td>
                      <td className="muted">{String(alert.reason || '')}</td>
                      <td>
                        <button type="button" className="btn secondary small" onClick={() => void api.acknowledgeAlert(String(alert.id)).then(load)}>Acknowledge</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
