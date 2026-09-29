import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime, formatLevel, timeAgo } from '../api';
import { Card, Empty, Loading, Notice, StateBadge } from '../components/ui';
import { useAuth } from '../App';

/** Alert timeline: every flood event persisted by the engine, with acknowledgement. */

export default function AlertsPage() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([]);
  const [deliveries, setDeliveries] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const staff = Boolean(user && ['OPERATOR', 'ADMIN', 'OWNER'].includes(user.role));
      const [status, mine] = await Promise.all([
        api.publicStatus(),
        api.deliveries().catch(() => ({ deliveries: [] })),
      ]);
      setDeliveries(mine.deliveries as unknown as Array<Record<string, unknown>>);
      setAlerts(staff
        ? ((await api.alerts().catch(() => ({ alerts: [] }))).alerts as unknown as Array<Record<string, unknown>>)
        : (status.events as unknown as Array<Record<string, unknown>>));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Loading label="Loading alerts…" />;
  if (error) return <Notice tone="critical">{error}</Notice>;

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Alert timeline</h1>
          <p>Every state transition recorded by the flood engine, with the reason, measured level and delivery status.</p>
        </div>
        <button type="button" className="btn secondary small" onClick={() => void load()}>Refresh</button>
      </div>

      <Card title="Flood events">
        {alerts.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Transition</th><th>Level</th><th>Rate</th><th>Trigger</th><th>Reason</th><th>Flags</th></tr>
              </thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={String(alert.id)}>
                    <td className="nowrap">{timeAgo(String(alert.createdAt))}<div className="subtle" style={{ fontSize: '0.76rem' }}>{formatDateTime(String(alert.createdAt))}</div></td>
                    <td><StateBadge state={String(alert.toState)} /></td>
                    <td>{formatLevel(alert.levelCm as number | null)}</td>
                    <td>{alert.rateCmPerMin === null || alert.rateCmPerMin === undefined ? '—' : `${Number(alert.rateCmPerMin).toFixed(1)} cm/min`}</td>
                    <td>{String(alert.trigger || 'THRESHOLD')}</td>
                    <td className="muted">{String(alert.reason || '')}</td>
                    <td>
                      {Boolean(alert.simulated) && <span className="badge unknown">SIMULATION</span>}
                      {alert.acknowledged !== undefined && (Boolean(alert.acknowledged) ? <span className="badge normal">ACK</span> : <span className="badge watch">OPEN</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No flood events have been recorded yet.</Empty>}
      </Card>

      <Card title="My notification deliveries" subtitle="Provider message ids and failure reasons for email and SMS">
        {deliveries.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Channel</th><th>Status</th><th>Attempts</th><th>Provider id</th><th>Failure reason</th></tr></thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={String(delivery.id)}>
                    <td>{timeAgo(String(delivery.createdAt))}</td>
                    <td>{String(delivery.channel)}</td>
                    <td><span className={`badge ${String(delivery.status) === 'SENT' ? 'normal' : String(delivery.status) === 'DEAD_LETTER' ? 'critical' : 'watch'}`}>{String(delivery.status)}</span></td>
                    <td>{String(delivery.attempts ?? 0)}</td>
                    <td className="mono">{String(delivery.providerMessageId || '—')}</td>
                    <td className="muted">{String(delivery.failureReason || '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No email or SMS deliveries for your account yet.</Empty>}
      </Card>

      <p className="subtle">Configure which channels and severities reach you in <Link to="/app/profile">notification preferences</Link>.</p>
    </div>
  );
}
