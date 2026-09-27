import { useEffect, useState, type FormEvent } from 'react';
import { BellRing, Check, Mail, ShieldCheck, TriangleAlert } from 'lucide-react';

type NotificationConfig = {
  webPushAvailable: boolean;
  vapidPublicKey: string | null;
  emailAvailable: boolean;
  smsAvailable: boolean;
  mode: string;
};

function decodeApplicationKey(value: string) {
  const padded = value + '='.repeat((4 - value.length % 4) % 4);
  const decoded = window.atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export default function NotificationPanel({ mode }: { mode: string }) {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [pushSubscription, setPushSubscription] = useState<PushSubscription | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [emailConsent, setEmailConsent] = useState(false);

  useEffect(() => {
    fetch('/api/notifications/config', { cache: 'no-store' }).then((response) => response.json()).then(setConfig).catch(() => setConfig(null));
  }, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()).then((subscription) => setPushSubscription(subscription)).catch(() => undefined);
  }, []);

  const enablePush = async () => {
    if (!config?.webPushAvailable || !config.vapidPublicKey) return;
    setWorking(true); setMessage('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('This browser does not support Web Push.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Browser notification permission was not granted.');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeApplicationKey(config.vapidPublicKey) as BufferSource });
      const response = await fetch('/api/notifications/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true, subscription: subscription.toJSON() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The push subscription could not be saved.');
      setPushSubscription(subscription);
      setMessage('Browser notifications are enabled for the configured zone. This is not an emergency warning channel.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not enable browser notifications.'); }
    finally { setWorking(false); }
  };

  const disablePush = async () => {
    if (!pushSubscription) return;
    setWorking(true); setMessage('');
    try {
      await fetch('/api/notifications/push', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: pushSubscription.endpoint }) });
      await pushSubscription.unsubscribe();
      setPushSubscription(null);
      setMessage('This browser has been unsubscribed from the project-zone push channel.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not remove the push subscription.'); }
    finally { setWorking(false); }
  };

  const submitEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setMessage('');
    if (!emailConsent) { setMessage('Please give explicit consent before requesting optional email updates.'); return; }
    setWorking(true);
    try {
      const response = await fetch('/api/notifications/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, consent: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save the email request.');
      setMessage(result.message); setEmail(''); setEmailConsent(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save the email request.'); }
    finally { setWorking(false); }
  };

  return <section className="panel notification-panel"><div className="notification-heading"><div className="notification-icon"><BellRing size={17} /></div><div><span className="panel-eyebrow">CONSENT-FIRST · ZONE-SCOPED</span><h2>Optional notifications</h2><p>Opt in only if you want updates for the configured model zone.</p></div><ShieldCheck className="notification-shield" size={19} /></div>
    <div className="notification-channels">
      <div className="notification-channel"><div className="notification-channel-top"><span className="channel-icon channel-push"><BellRing size={15} /></span><div><strong>Browser push</strong><small>Permission is requested by your browser</small></div></div>{config?.webPushAvailable ? <button className="notification-action" onClick={pushSubscription ? () => void disablePush() : () => void enablePush()} disabled={working}>{working ? 'Working…' : pushSubscription ? 'Unsubscribe this browser' : 'Enable browser push'}</button> : <span className="integration-offline"><i></i> VAPID keys not configured</span>}</div>
      <div className="notification-channel"><div className="notification-channel-top"><span className="channel-icon channel-email"><Mail size={15} /></span><div><strong>Email · double opt-in</strong><small>{config?.emailAvailable ? 'Confirm link required; unsubscribe link included' : 'Requires a verified mail provider'}</small></div></div>{config?.emailAvailable ? <form className="notification-email-form" onSubmit={(event) => void submitEmail(event)}><input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" aria-label="Email address for optional FloodGuard project updates" /><label><input type="checkbox" checked={emailConsent} onChange={(event) => setEmailConsent(event.target.checked)} /> I consent to optional, zone-scoped project updates.</label><button className="notification-action" type="submit" disabled={working || !emailConsent}>{working ? 'Saving…' : 'Request confirmation email'}</button></form> : <span className="integration-offline"><i></i> Email provider not configured</span>}</div>
    </div>
    {message && <p className="notification-feedback" role="status"><Check size={13} />{message}</p>}
    <div className="notification-foot"><TriangleAlert size={13} /><span>No SMS / emergency delivery is active. Even when integrations are configured, FloodGuard is an educational prototype and is not monitored.</span><span className="notification-mode">{mode === 'postgres' ? 'POSTGRES' : 'LOCAL DEMO'}</span></div>
  </section>;
}
