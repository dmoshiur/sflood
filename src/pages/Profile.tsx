import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PublicConfig } from '../api';
import { Card, Field, Loading, Notice, Tabs } from '../components/ui';
import { useAuth } from '../App';
import { urlBase64ToUint8Array } from '../push';

/** Profile, avatar upload, notification preferences, push subscriptions, sessions and MFA. */

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [tab, setTab] = useState('profile');
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [preferences, setPreferences] = useState<Record<string, unknown> | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [sessions, setSessions] = useState<Array<Record<string, unknown>>>([]);
  const [pushSubscriptions, setPushSubscriptions] = useState<Array<Record<string, unknown>>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [serviceAreaId, setServiceAreaId] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [totpSecret, setTotpSecret] = useState<{ secret: string; otpAuthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [result, publicConfig] = await Promise.all([api.profile(), api.publicConfig()]);
      setProfile(result.profile as unknown as Record<string, unknown>);
      setPreferences(result.preferences as unknown as Record<string, unknown>);
      setConfig(publicConfig);
      setDisplayName(String(result.profile.displayName || ''));
      setPhone(String(result.profile.phone || ''));
      const [sessionResult, pushResult] = await Promise.all([
        api.sessions().catch(() => ({ sessions: [] })),
        fetch('/api/me/push/subscriptions').then((response) => response.json()).catch(() => ({ subscriptions: [] })),
      ]);
      setSessions(sessionResult.sessions as unknown as Array<Record<string, unknown>>);
      setPushSubscriptions((pushResult as { subscriptions: Array<Record<string, unknown>> }).subscriptions || []);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      await api.updateProfile({ displayName, phone: phone || undefined, serviceAreaId: serviceAreaId || undefined });
      setMessage('Profile updated.');
      await refresh();
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function uploadAvatar(file: File) {
    setBusy(true); setMessage(null); setError(null);
    try {
      const signature = await api.avatarSignature();
      if (file.size > signature.maxBytes) throw new Error('Image is larger than 2 MB.');
      const form = new FormData();
      form.append('file', file);
      form.append('api_key', signature.apiKey || '');
      form.append('timestamp', String(signature.timestamp));
      form.append('public_id', signature.publicId);
      form.append('folder', signature.folder);
      form.append('overwrite', 'true');
      if (signature.signature) form.append('signature', signature.signature);
      if (signature.uploadPreset) form.append('upload_preset', signature.uploadPreset);
      const response = await fetch(`https://api.cloudinary.com/v1_1/${signature.cloudName}/image/upload`, { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: { message?: string } }).error?.message || 'Upload failed.');
      await api.saveAvatar(signature.publicId, String((body as { secure_url?: string }).secure_url || ''));
      setMessage('Profile image updated.');
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function savePreferences(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await api.updatePreferences(preferences || {});
      setPreferences(result.preferences);
      setMessage('Notification preferences saved.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function enablePush() {
    setMessage(null); setError(null);
    try {
      if (!config?.vapidPublicKey) throw new Error('Web Push is not configured on this deployment.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Browser notification permission was not granted.');
      const registration = await navigator.serviceWorker.register('/sw.js');
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey) as BufferSource });
      const json = subscription.toJSON();
      await api.savePush({ endpoint: json.endpoint!, keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! } });
      setMessage('Browser notifications enabled.');
      await load();
    } catch (err) { setError((err as Error).message); }
  }

  async function enrolTotp() {
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await api.totpStart();
      setTotpSecret(result);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function confirmTotp(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      await api.totpConfirm(totpCode);
      setTotpSecret(null); setTotpCode('');
      setMessage('Authenticator MFA is enabled for this session.');
      await refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (!profile || !preferences) return <Loading label="Loading your profile…" />;

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p>{String(profile.email)} · role {String(profile.role)}</p>
        </div>
        <div className="row">
          {!profile.emailVerified && <span className="badge watch">Email unconfirmed</span>}
          {user?.totpEnrolled ? <span className="badge normal">MFA enrolled</span> : <span className="badge watch">MFA not enrolled</span>}
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'profile', label: 'Account' },
          { id: 'notifications', label: 'Notifications' },
          { id: 'security', label: 'Security' },
          { id: 'sessions', label: 'Sessions' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="critical">{error}</Notice>}

      {tab === 'profile' && (
        <div className="grid cols-2">
          <Card title="Account details">
            <form onSubmit={saveProfile} className="stack" style={{ gap: '0.4rem' }}>
              <Field label="Display name"><input required minLength={2} maxLength={100} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
              <Field label="Phone (E.164)" hint="Required before SMS notifications can be enabled."><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+8801XXXXXXXXX" maxLength={16} /></Field>
              {config && (
                <Field label="Service area" hint="Only allowlisted cities and countries are accepted.">
                  <select value={serviceAreaId} onChange={(event) => setServiceAreaId(event.target.value)}>
                    <option value="">Keep current area</option>
                    {config.serviceAreas.map((area) => <option key={area.id} value={area.id}>{area.city}, {area.country}</option>)}
                  </select>
                </Field>
              )}
              <button className="btn" type="submit" disabled={busy}>Save profile</button>
            </form>
            <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '1rem 0' }} />
            <dl className="kv">
              <dt>Service area</dt><dd>{profile.serviceArea ? `${(profile.serviceArea as { city: string }).city}, ${(profile.serviceArea as { country: string }).country}` : 'Not set'}</dd>
              <dt>Member since</dt><dd>{String(profile.createdAt || '—')}</dd>
              <dt>Last sign in</dt><dd>{String(profile.lastLoginAt || '—')}</dd>
            </dl>
          </Card>

          <Card title="Profile image" subtitle="Uploaded directly to Cloudinary with a short-lived signed request">
            <div className="row" style={{ alignItems: 'center', gap: '1rem' }}>
              {profile.avatarUrl ? <img className="avatar lg" src={String(profile.avatarUrl)} alt="Your profile image" /> : <div className="avatar lg" aria-hidden />}
              <div className="stack" style={{ gap: '0.4rem' }}>
                <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); }} />
                <span className="subtle" style={{ fontSize: '0.8rem' }}>
                  JPEG, PNG or WebP up to 2 MB. {config?.cloudinary.configured ? 'Signed upload configured.' : 'Image uploads are not configured on this deployment.'}
                </span>
                {Boolean(profile.avatarUrl) && <button type="button" className="btn secondary small" onClick={() => void api.removeAvatar().then(load)}>Remove image</button>}
              </div>
            </div>
          </Card>
        </div>
      )}

      {tab === 'notifications' && (
        <form onSubmit={savePreferences}>
          <Card title="Channels" subtitle="Recovery notifications can be switched off independently of alerts">
            <div className="stack" style={{ gap: '0.55rem' }}>
              <label className="checkbox"><input type="checkbox" checked={Boolean(preferences.emailEnabled)} onChange={(event) => setPreferences({ ...preferences, emailEnabled: event.target.checked })} /> Email alerts to your confirmed address</label>
              <label className="checkbox"><input type="checkbox" checked={Boolean(preferences.pushEnabled)} onChange={(event) => setPreferences({ ...preferences, pushEnabled: event.target.checked })} /> Browser push notifications</label>
              <label className="checkbox"><input type="checkbox" checked={Boolean(preferences.inAppEnabled)} onChange={(event) => setPreferences({ ...preferences, inAppEnabled: event.target.checked })} /> In-app notifications</label>
              <label className="checkbox"><input type="checkbox" checked={Boolean(preferences.smsEnabled)} onChange={(event) => setPreferences({ ...preferences, smsEnabled: event.target.checked })} /> SMS alerts (requires a verified phone and a configured gateway)</label>
              <label className="checkbox"><input type="checkbox" checked={Boolean(preferences.recoveryEnabled)} onChange={(event) => setPreferences({ ...preferences, recoveryEnabled: event.target.checked })} /> Notify me when the level recovers</label>
            </div>
          </Card>
          <Card title="Severity threshold">
            <Field label="Minimum severity" hint="INFO notifies on every transition, CRITICAL only on critical.">
              <select value={String(preferences.minSeverity || 'WATCH')} onChange={(event) => setPreferences({ ...preferences, minSeverity: event.target.value })}>
                <option value="INFO">INFO — every transition</option>
                <option value="WATCH">WATCH and above</option>
                <option value="WARNING">WARNING and above</option>
                <option value="CRITICAL">CRITICAL only</option>
              </select>
            </Field>
            <button className="btn" type="submit" disabled={busy}>Save preferences</button>
          </Card>
        </form>
      )}

      {tab === 'security' && (
        <div className="grid cols-2">
          <Card title="Password">
            <form className="stack" style={{ gap: '0.4rem' }} onSubmit={async (event) => {
              event.preventDefault(); setBusy(true); setMessage(null); setError(null);
              try { await api.changePassword(currentPassword, newPassword); setMessage('Password updated.'); setCurrentPassword(''); setNewPassword(''); }
              catch (err) { setError((err as Error).message); } finally { setBusy(false); }
            }}>
              <Field label="Current password"><input type="password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} maxLength={128} /></Field>
              <Field label="New password" hint="At least 10 characters with upper case, lower case and a number."><input type="password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} maxLength={128} /></Field>
              <button className="btn" type="submit" disabled={busy}>Change password</button>
            </form>
          </Card>

          <Card title="Authenticator MFA" subtitle="Required for operator, admin and super-admin accounts">
            {user?.totpEnrolled ? (
              <p className="muted">An authenticator app is enrolled. To reset it, ask an administrator.</p>
            ) : totpSecret ? (
              <form onSubmit={confirmTotp} className="stack" style={{ gap: '0.5rem' }}>
                <p className="muted">Add this secret to your authenticator app, then enter the current six-digit code.</p>
                <p className="mono" style={{ wordBreak: 'break-all' }}>{totpSecret.secret}</p>
                <Field label="Six-digit code"><input required pattern="\d{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value)} /></Field>
                <button className="btn" type="submit" disabled={busy}>Confirm and enable</button>
              </form>
            ) : (
              <>
                <p className="muted">Enrol an authenticator app (TOTP) to unlock staff consoles.</p>
                <button type="button" className="btn" onClick={() => void enrolTotp()} disabled={busy || !['OPERATOR', 'ADMIN', 'OWNER'].includes(String(profile.role))}>
                  Start enrolment
                </button>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'sessions' && (
        <div className="grid cols-2">
          <Card title="Active sessions" actions={<button type="button" className="btn secondary small" onClick={() => void api.revokeOtherSessions().then(() => { setMessage('Other sessions revoked.'); void load(); })}>Revoke others</button>}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Started</th><th>IP</th><th>Agent</th><th>MFA</th></tr></thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={String(session.id)}>
                      <td className="nowrap">{String(session.createdAt)}{session.current ? ' (this device)' : ''}</td>
                      <td>{String(session.ipAddress || '—')}</td>
                      <td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(session.userAgent || 'unknown')}</td>
                      <td>{session.mfaVerified ? <span className="badge normal">Yes</span> : <span className="badge watch">No</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Browser push subscriptions">
            {pushSubscriptions.length ? (
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {pushSubscriptions.map((subscription) => (
                  <li key={String(subscription.id)} style={{ marginBottom: '0.5rem' }}>
                    <div className="mono subtle">{String(subscription.endpoint)}</div>
                    <div className="row">
                      <span className="subtle" style={{ fontSize: '0.8rem' }}>Zone {String(subscription.zoneId ?? '')}</span>
                      {subscription.active ? <span className="badge normal">Active</span> : <span className="badge neutral">Unsubscribed</span>}
                      {Boolean(subscription.active) && (
                        <button type="button" className="btn secondary small" onClick={() => void api.removePush(String(subscription.endpoint)).then(load)}>Remove</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="muted">No browser push subscriptions yet.</p>
                <button type="button" className="btn" onClick={() => void enablePush()} disabled={!config?.vapidPublicKey}>Enable browser notifications</button>
              </>
            )}
          </Card>
        </div>
      )}

      <p className="subtle"><Link to="/app">Back to the dashboard</Link></p>
    </div>
  );
}
