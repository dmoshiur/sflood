import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ShieldAlert, TriangleAlert, Upload, User } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { FloodGuardMark } from '../brand';
import {
  getProfile, getServiceAreas, registerAccount, updateProfile, uploadAvatar,
  type ProfilePayload, type ServiceArea,
} from '../adminApi';

async function requestJson(path: string, method = 'GET', body?: unknown, csrf = '') {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showTotp, setShowTotp] = useState(false);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      const result = await requestJson('/api/auth/login', 'POST', { email, password, ...(totp ? { totp } : {}) });
      if (result.mfaSetupRequired || result.user?.role === 'OWNER' || result.user?.role === 'ADMIN') navigate('/hackeradmin');
      else navigate('/app');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Authentication request failed.';
      if (text.toLowerCase().includes('authenticator code')) setShowTotp(true);
      setMessage(text);
    } finally { setWorking(false); }
  };
  return <main className="admin-auth-page page-width">
    <div className="admin-auth-card">
      <div className="admin-auth-brand"><FloodGuardMark small /><div><strong>FLOODGUARD</strong><span>SECURE PROJECT ACCESS</span></div></div>
      <span className="section-kicker">ACCOUNT SIGN-IN</span>
      <h1>Sign in to your workspace.</h1>
      <p>Members, operators and admins sign in here. Admin accounts additionally require authenticator MFA.</p>
      {message && <p className="admin-feedback" role="status">{message}</p>}
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        <label>Email address<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
        <label>Password<input type="password" required minLength={1} maxLength={128} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {showTotp && <label>Authenticator code<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totp} onChange={(event) => setTotp(event.target.value)} placeholder="6 digits" autoComplete="one-time-code" /></label>}
        <button className="admin-primary-button" type="submit" disabled={working}>{working ? 'Working…' : 'Sign in securely'} <ArrowRight size={15} /></button>
      </form>
      <div className="admin-auth-footer">New resident? <Link to="/register">Create an account</Link> <span>·</span><Link to="/app">Return to demo</Link></div>
    </div>
  </main>;
}

export function RegisterPage() {
  const navigate = useNavigate();
  const inviteToken = new URLSearchParams(window.location.search).get('invite') || '';
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [cityName, setCityName] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (inviteToken) return;
    getServiceAreas().then((result) => {
      setServiceAreas(result.serviceAreas);
      if (result.serviceAreas.length) {
        setCountryCode(result.serviceAreas[0]!.countryCode);
        setCityName(result.serviceAreas[0]!.cityName);
      }
    }).catch(() => setMessage('Service areas could not be loaded. Registration needs the database-backed deployment.'));
  }, [inviteToken]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      if (inviteToken) {
        if (password !== confirmPassword && password) throw new Error('Passwords do not match.');
        const result = await requestJson('/api/auth/accept-invite', 'POST', { token: inviteToken, password: invitePassword || password });
        setMessage(result.message || 'Invitation accepted.');
        setTimeout(() => navigate('/hackeradmin'), 600);
        return;
      }
      if (password !== confirmPassword) throw new Error('Passwords do not match.');
      const result = await registerAccount({ name, email, password, countryCode, cityName, consent: true });
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Registration request failed.');
    } finally { setWorking(false); }
  };

  return <main className="admin-auth-page page-width">
    <div className="admin-auth-card">
      <div className="admin-auth-brand"><FloodGuardMark small /><div><strong>FLOODGUARD</strong><span>ACCOUNT REGISTRATION</span></div></div>
      <span className="section-kicker">{inviteToken ? 'INVITED ADMIN ACCOUNT' : 'PUBLIC REGISTRATION'}</span>
      <h1>{inviteToken ? 'Accept your invitation.' : 'Create your FloodGuard account.'}</h1>
      <p>{inviteToken
        ? 'This one-time link expires after 48 hours. Admin accounts must enroll authenticator MFA before changing settings.'
        : 'Registration is limited to the cities in our service-area allowlist. You will confirm your email before signing in.'}</p>
      {!inviteToken && <div className="admin-inline-info"><ShieldAlert size={15} /> Educational prototype — accounts receive project updates, not emergency warnings.</div>}
      {message && <p className="admin-feedback" role="status">{message}</p>}
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        {inviteToken ? (
          <label>Create a strong password<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={invitePassword} onChange={(event) => setInvitePassword(event.target.value)} placeholder="At least 12 characters" /></label>
        ) : (
          <>
            <label>Full name<input type="text" required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" /></label>
            <label>Email address<input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label>Password<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 12 characters" /></label>
            <label>Confirm password<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
            <label>Service area
              <select value={`${countryCode}|${cityName}`} onChange={(event) => {
                const [country, city] = event.target.value.split('|');
                setCountryCode(country || ''); setCityName(city || '');
              }}>
                {serviceAreas.map((area) => <option key={area.id} value={`${area.countryCode}|${area.cityName}`}>{area.cityName}, {area.countryName}</option>)}
              </select>
            </label>
            {serviceAreas.length === 0 && <div className="admin-inline-warning"><TriangleAlert size={15} /> No service areas are enabled yet.</div>}
          </>
        )}
        <button className="admin-primary-button" type="submit" disabled={working || (!inviteToken && serviceAreas.length === 0)}>
          {working ? 'Working…' : inviteToken ? 'Accept invitation' : 'Create account'} <ArrowRight size={15} />
        </button>
      </form>
      <div className="admin-auth-footer">Already registered? <Link to="/login">Sign in</Link> <span>·</span><Link to="/status">Public status</Link></div>
    </div>
  </main>;
}

export function ProfilePage() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [cityName, setCityName] = useState('');
  const [country, setCountry] = useState('');
  const [prefs, setPrefs] = useState({ floodAlerts: true, email: true, push: true, sms: false });
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [pushState, setPushState] = useState('');

  useEffect(() => {
    getProfile().then((result) => {
      setProfile(result.profile);
      setDisplayName(result.profile.displayName);
      setPhone(result.profile.phone);
      setCityName(result.profile.cityName);
      setCountry(result.profile.country);
      setPrefs(result.profile.notificationPrefs);
    }).catch((error) => {
      if (String(error).toLowerCase().includes('sign in')) navigate('/login');
      else setMessage(error instanceof Error ? error.message : 'Profile unavailable.');
    });
  }, [navigate]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      await updateProfile({ displayName, phone, cityName, country, notificationPrefs: prefs });
      setMessage('Profile saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed.');
    } finally { setWorking(false); }
  };

  const pickAvatar = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 2_500_000) { setMessage('Image must be under 2.5 MB.'); return; }
      setWorking(true); setMessage('');
      try {
        const dataUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Could not read the image.'));
          reader.readAsDataURL(file);
        });
        const result = await uploadAvatar(dataUri, file.type);
        setProfile((current) => current ? { ...current, avatarUrl: result.avatarUrl } : current);
        setMessage('Profile image uploaded to Cloudinary.');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Upload failed.');
      } finally { setWorking(false); }
    };
    input.click();
  };

  const enablePush = async () => {
    setPushState('Working…');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setPushState('Permission not granted.'); return; }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: (await (await fetch('/api/notifications/config')).json()).vapidPublicKey || undefined });
      const response = await fetch('/api/notifications/push', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true, subscription: subscription.toJSON() }),
      });
      const body = await response.json().catch(() => ({}));
      setPushState(response.ok ? 'Browser push enabled on this device.' : body.error || 'Push subscription failed.');
    } catch (error) {
      setPushState(error instanceof Error ? error.message : 'Push is unavailable in this browser.');
    }
  };

  if (!profile) return <main className="inner-page page-width"><div className="app-loading"><span className="loading-spinner"></span><strong>Loading profile…</strong></div></main>;

  return <main className="inner-page page-width profile-page">
    <div className="inner-page-heading">
      <span className="section-kicker">YOUR ACCOUNT</span>
      <h1>Profile & notification preferences</h1>
      <p>Manage your details, profile image and how the project may contact you. All changes are audit-logged.</p>
    </div>
    {message && <p className="admin-feedback" role="status">{message}</p>}
    <div className="profile-grid">
      <section className="panel profile-avatar-panel">
        <div className="profile-avatar">
          {profile.avatarUrl ? <img src={profile.avatarUrl} alt="Profile" /> : <span><User size={36} /></span>}
        </div>
        <button className="admin-primary-button" onClick={pickAvatar} disabled={working}><Upload size={15} /> Upload image</button>
        <p className="gauge-footnote">JPEG, PNG or WebP up to 2.5 MB. Stored on Cloudinary; the server validates real image bytes.</p>
        <div className="profile-meta">
          <div><span>Email</span><strong>{profile.email} {profile.emailVerified ? '· verified' : '· unverified'}</strong></div>
          <div><span>Member since</span><strong>{new Date(profile.createdAt).toLocaleDateString()}</strong></div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading-row"><div><span className="panel-eyebrow"><User size={13} /> DETAILS</span><h2>Edit profile</h2></div></div>
        <form className="admin-form" onSubmit={(event) => void save(event)}>
          <label>Display name<input type="text" minLength={2} maxLength={100} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label>Phone (E.164, for optional SMS)<input type="tel" placeholder="+8801XXXXXXXXX" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
          <label>City<input type="text" maxLength={80} value={cityName} onChange={(event) => setCityName(event.target.value)} /></label>
          <label>Country<input type="text" maxLength={80} value={country} onChange={(event) => setCountry(event.target.value)} /></label>
          <fieldset className="pref-fieldset">
            <legend>Notification preferences</legend>
            <label className="pref-toggle"><input type="checkbox" checked={prefs.floodAlerts} onChange={(event) => setPrefs({ ...prefs, floodAlerts: event.target.checked })} /> Flood state alerts</label>
            <label className="pref-toggle"><input type="checkbox" checked={prefs.email} onChange={(event) => setPrefs({ ...prefs, email: event.target.checked })} /> Email updates</label>
            <label className="pref-toggle"><input type="checkbox" checked={prefs.push} onChange={(event) => setPrefs({ ...prefs, push: event.target.checked })} /> Browser push</label>
            <label className="pref-toggle"><input type="checkbox" checked={prefs.sms} onChange={(event) => setPrefs({ ...prefs, sms: event.target.checked })} /> SMS updates (verified phone only)</label>
          </fieldset>
          <button className="admin-primary-button" type="submit" disabled={working}>{working ? 'Saving…' : 'Save profile'} <Check size={15} /></button>
        </form>
        <div className="profile-push-row">
          <button className="admin-secondary-button" onClick={() => void enablePush()}>Enable browser push on this device</button>
          {pushState && <span role="status">{pushState}</span>}
        </div>
      </section>
    </div>
  </main>;
}
