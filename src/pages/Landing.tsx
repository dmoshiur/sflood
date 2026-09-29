import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatTime, type PublicStatus } from '../api';
import { BlockRenderer, CityVisualization, WaterChart, type ChartPoint } from '../components/visuals';
import { Card, Loading, Notice, StateBadge, Stat } from '../components/ui';

/**
 * Landing page.
 *
 * The hero, copy, cards and safety notices come from the published page in the
 * database (see the site builder), with a built-in fallback so the page still
 * renders before an editor publishes anything.
 */

const FALLBACK_BLOCKS = [
  { id: 'hero-1', type: 'hero', variant: 'science', eyebrow: 'Science-fair engineering project', title: 'Smart Flood Control & Automation', subtitle: 'A raised miniature city, ultrasonic water-level sensing, ESP32 controllers and an automated perimeter barrier, with a live command centre.', primaryAction: { label: 'Open live status', href: '/status' }, secondaryAction: { label: 'How it works', href: '/devices' } },
  { id: 'text-1', type: 'text', title: 'The prototype city', body: 'The physical model is a raised island city surrounded by a water tray. Sensor nodes measure the water level around the perimeter, an ESP32 controller runs the flood state machine locally, and a lightweight barrier rises before the water reaches the first building. The web platform is the command centre: it stores telemetry, evaluates the flood policy, records events, fans out notifications and commands the barrier.' },
  { id: 'cards-1', type: 'cards', title: 'How the system fits together', columns: 3, items: [
    { title: 'Sense', body: 'Ultrasonic distance sensors on ESP32 and ESP8266 nodes report water level, signal strength, uptime and fault state.' },
    { title: 'Decide', body: 'The flood engine applies absolute thresholds, rate of rise, hysteresis, cooldown and multi-sensor confirmation.' },
    { title: 'Act', body: 'The controller raises or lowers the perimeter barrier with limit-switch feedback and a local fail-safe.' },
    { title: 'Notify', body: 'Critical events fan out to email, SMS, Web Push and the public status page. In-app alerts are always available.' },
  ] },
  { id: 'alert-1', type: 'alert', title: 'Safety boundary', tone: 'warning', body: 'This is an educational prototype. It is not a real flood defence, evacuation service or emergency warning system. Never rely on it for life-safety decisions.' },
  { id: 'buttons-1', type: 'buttons', items: [
    { label: 'Create an account', href: '/register', variant: 'primary' },
    { label: 'Devices and firmware', href: '/devices', variant: 'secondary' },
    { label: 'Admin console', href: '/admin', variant: 'ghost' },
  ] },
] as unknown as Array<Record<string, unknown>>;

export default function LandingPage() {
  const [blocks, setBlocks] = useState<Array<Record<string, unknown>>>(FALLBACK_BLOCKS);
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [page, live] = await Promise.all([api.publishedPage('home'), api.publicStatus()]);
        if (cancelled) return;
        if (page.blocks?.length) setBlocks(page.blocks as unknown as Array<Record<string, unknown>>);
        setStatus(live);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      {error && <Notice tone="warning">Live data is temporarily unavailable: {error}</Notice>}
      {blocks.map((block) => {
        if (block.type === 'status') {
          return (
            <section className="section" key={String(block.id)}>
              <h2>{String(block.title || 'Current site state')}</h2>
              {status ? (
                <div className="grid cols-2">
                  <Card title={`${status.site.city} — ${status.site.zone}`} subtitle={`Last update ${formatTime(status.current.lastUpdateAt)}`} actions={<StateBadge state={status.current.state} label={status.current.label} />}>
                    <div className="grid cols-2">
                      <Stat label="Water level" value={status.current.levelCm === null ? '—' : `${status.current.levelCm.toFixed(1)} cm`} detail={`Trend ${status.current.trendCm >= 0 ? '+' : ''}${status.current.trendCm.toFixed(1)} cm`} />
                      <Stat label="Barrier" value={status.current.barrier} detail={`${status.site.devices} device(s) reporting`} />
                    </div>
                    <p className="muted" style={{ marginTop: '0.75rem' }}>{status.current.guidance}</p>
                    <Link className="btn" to="/status">Open the full status page</Link>
                  </Card>
                  <CityVisualization levelCm={status.current.levelCm} state={status.current.state} barrier={status.current.barrier} simulated={status.current.simulated} devices={status.devices} />
                </div>
              ) : <Loading label="Loading live status…" />}
            </section>
          );
        }
        if (block.type === 'chart') {
          return (
            <section className="section" key={String(block.id)}>
              <h2>{String(block.title || 'Water level')}</h2>
              <Card>
                {status?.history?.length ? <WaterChart history={status.history as unknown as ChartPoint[]} /> : <Loading label="Loading telemetry…" />}
              </Card>
            </section>
          );
        }
        return <BlockRenderer key={String(block.id)} blocks={[block]} />;
      })}

      <section className="section">
        <h2>Built to be inspected</h2>
        <div className="grid cols-3">
          <Card title="Real persistence">Every value on this site is read from a libSQL/Turso database. There is no mock data and no fake counter.</Card>
          <Card title="Real devices">ESP32 and ESP8266 nodes register with a unique UID, a one-time provisioning token and their own API key.</Card>
          <Card title="Real audit trail">Device approvals, barrier commands, threshold changes and admin actions are written to an audit log.</Card>
        </div>
      </section>
    </div>
  );
}
