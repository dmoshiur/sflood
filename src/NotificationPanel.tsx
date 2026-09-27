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
  const [phone, setPhone] = useState('');
  const [pendingPhone, setPendingPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);

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

  const requestSmsCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setMessage('');
    if (!smsConsent) { setMessage('Please give explicit consent before requesting optional SMS updates.'); return; }
    setWorking(true);
    try {
      const response = await fetch('/api/notifications/sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, consent: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not send the SMS verification code.');
      setPendingPhone(result.verified ? '' : phone); setPhone(''); setSmsConsent(false); setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not send the SMS verification code.'); }
    finally { setWorking(false); }
  };

  const verifySmsCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setMessage(''); setWorking(true);
    try {
      const response = await fetch('/api/notifications/sms/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: pendingPhone, code: smsCode }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not verify the SMS code.');
      setPendingPhone(''); setSmsCode(''); setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not verify the SMS code.'); }
    finally { setWorking(false); }
  };

  return <section className="panel notification-panel"><div className="notification-heading"><div className="notification-icon"><BellRing size={17} /></div><div><span className="panel-eyebrow">CONSENT-FIRST · ZONE-SCOPED</span><h2>Optional notifications</h2><p>Opt in only if you want updates for the configured model zone.</p></div><ShieldCheck className="notification-shield" size={19} /></div>
    <div className="notification-channels">
      <div className="notification-channel"><div className="notification-channel-top"><span className="channel-icon channel-push"><BellRing size={15} /></span><div><strong>Browser push</strong><small>Permission is requested by your browser</small></div></div>{config?.webPushAvailable ? <button className="notification-action" onClick={pushSubscription ? () => void disablePush() : () => void enablePush()} disabled={working}>{working ? 'Working…' : pushSubscription ? 'Unsubscribe this browser' : 'Enable browser push'}</button> : <span className="integration-offline"><i></i> VAPID keys not configured</span>}</div>
      <div className="notification-channel"><div className="notification-channel-top"><span className="channel-icon channel-email"><Mail size={15} /></span><div><strong>Email · double opt-in</strong><small>{config?.emailAvailable ? 'Confirm link required; unsubscribe link included' : 'Requires SMTP and a canonical public app URL'}</small></div></div>{config?.emailAvailable ? <form className="notification-email-form" onSubmit={(event) => void submitEmail(event)}><input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" aria-label="Email address for optional FloodGuard project updates" /><label><input type="checkbox" checked={emailConsent} onChange={(event) => setEmailConsent(event.target.checked)} /> I consent to optional, zone-scoped project updates.</label><button className="notification-action" type="submit" disabled={working || !emailConsent}>{working ? 'Saving…' : 'Request confirmation email'}</button></form> : <span className="integration-offline"><i></i> SMTP provider not configured</span>}</div>
      <div className="notification-channel"><div className="notification-channel-top"><span className="channel-icon channel-sms"><BellRing size={15} /></span><div><strong>SMS · verify phone</strong><small>{config?.smsAvailable ? 'One-time code required; carrier rates may apply' : 'Requires gateway, public URL and SESSION_SECRET'}</small></div></div>{config?.smsAvailable ? pendingPhone ? <form className="notification-email-form" onSubmit={(event) => void verifySmsCode(event)}><small>Code sent to {pendingPhone}</small><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={smsCode} onChange={(event) => setSmsCode(event.target.value)} placeholder="6-digit code" aria-label="SMS verification code" /><button className="notification-action" type="submit" disabled={working || smsCode.length !== 6}>{working ? 'Verifying…' : 'Verify phone'}</button></form> : <form className="notification-email-form" onSubmit={(event) => void requestSmsCode(event)}><input type="tel" required maxLength={16} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+8801XXXXXXXXX" aria-label="Phone number in international E.164 format" /><label><input type="checkbox" checked={smsConsent} onChange={(event) => setSmsConsent(event.target.checked)} /> I consent to optional FloodGuard project SMS.</label><button className="notification-action" type="submit" disabled={working || !smsConsent}>{working ? 'Sending…' : 'Request verification code'}</button></form> : <span className="integration-offline"><i></i> SMS gateway not configured</span>}</div>
    </div>
    {message && <p className="notification-feedback" role="status"><Check size={13} />{message}</p>}
    <div className="notification-foot"><TriangleAlert size={13} /><span>Email, SMS and browser push depend on configured providers and verified consent. FloodGuard is an educational prototype, not an emergency alert service.</span><span className="notification-mode">{mode === 'turso' ? 'TURSO' : 'LOCAL DEMO'}</span></div>
  </section>;
}
