import { useCallback, useEffect, useState } from 'react';
import { Bell, BellRing, Check, Droplets, RefreshCw, WifiOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getFloodEvents, getInbox, markInboxAllRead, markInboxRead, type FloodEventRow, type InboxItem } from '../adminApi';
import { timeAgo } from '../api';

const stateTone: Record<string, string> = {
  NORMAL: 'safe', RECOVERY: 'safe', WATCH: 'watch', WARNING: 'warning', CRITICAL: 'critical', UNKNOWN: 'unknown', FAULT: 'fault',
};

export default function AlertsPage() {
  const [events, setEvents] = useState<FloodEventRow[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const eventResult = await getFloodEvents(30);
      setEvents(eventResult.events);
      try {
        const inboxResult = await getInbox();
        setInbox(inboxResult.notifications);
        setUnread(inboxResult.unread);
        setSignedIn(true);
      } catch {
        setSignedIn(false);
      }
      setError('');
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : 'Alert feed unavailable.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const markRead = async (id: string) => {
    setBusy(true);
    try { await markInboxRead(id); await refresh(); } finally { setBusy(false); }
  };
  const markAll = async () => {
    setBusy(true);
    try { await markInboxAllRead(); await refresh(); } finally { setBusy(false); }
  };

  return (
    <main className="inner-page page-width alerts-page">
      <div className="inner-page-heading">
        <span className="section-kicker">ALERTS & NOTIFICATIONS</span>
        <h1>State changes and your notification inbox</h1>
        <p>Flood-engine transitions are persisted with reason and level. Notification delivery is queued and retried; states are readable as text, icons and colour — no animation is required to understand an alert.</p>
        <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh alerts"><RefreshCw size={16} /></button>
      </div>
      {error && <div className="api-error"><WifiOff size={17} /><span><strong>Alerts unavailable</strong>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}

      {signedIn && (
        <section className="panel inbox-panel">
          <div className="panel-heading-row">
            <div><span className="panel-eyebrow"><Bell size={13} /> IN-APP NOTIFICATIONS</span><h2>Your inbox {unread > 0 && <span className="inbox-unread">{unread} unread</span>}</h2></div>
            {inbox.length > 0 && <button className="panel-text-link" onClick={() => void markAll()} disabled={busy}><Check size={14} /> Mark all read</button>}
          </div>
          {inbox.length === 0 && <p className="empty-note">No notifications yet. Flood alerts for your service area appear here.</p>}
          <ul className="inbox-list">
            {inbox.map((item) => (
              <li key={item.id} className={`inbox-item ${item.readAt ? 'is-read' : 'is-unread'} tone-${stateTone[item.severity] || 'unknown'}`}>
                <div className="inbox-icon"><BellRing size={15} /></div>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.body}</p>
                  <small>{item.kind} · {timeAgo(item.createdAt)}</small>
                </div>
                {!item.readAt && <button onClick={() => void markRead(item.id)} disabled={busy}>Mark read</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!signedIn && (
        <div className="maintenance-banner"><Bell size={16} /><span>Sign in to see your personal notification inbox. <Link to="/login">Sign in</Link></span></div>
      )}

      <section className="panel events-panel">
        <div className="panel-heading-row"><div><span className="panel-eyebrow"><Droplets size={13} /> FLOOD ENGINE TIMELINE</span><h2>Recorded state changes</h2></div></div>
        {events.length === 0 && <p className="empty-note">No recorded state changes yet.</p>}
        <ul className="event-timeline">
          {events.map((event) => (
            <li key={event.id} className={`event-timeline-item tone-${stateTone[event.state] || 'unknown'}`}>
              <div className="event-timeline-marker"><Droplets size={14} /></div>
              <div>
                <strong>{event.state}{event.simulation ? ' · SIMULATION' : ''} <small>· {event.severity}</small></strong>
                <p>{event.reason}</p>
                <small>{timeAgo(event.createdAt)} · {event.levelCm === null ? 'level —' : `level ${event.levelCm.toFixed(1)} cm`}</small>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
