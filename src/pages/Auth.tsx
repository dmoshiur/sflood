import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type PublicConfig } from '../api';
import { useAuth } from '../App';
import { Card, Field, Loading, Notice } from '../components/ui';

/** Login, registration, password reset and invitation acceptance. */

type Mode = 'login' | 'register' | 'reset' | 'invite';

export default function AuthPages({ mode }: { mode: Mode }) {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [totp, setTotp] = useState('');
  const [serviceAreaId, setServiceAreaId] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    void api.publicConfig().then(setConfig).catch(() => undefined);
    void api.authStatus().then((status) => {
      if (mode === 'register' && !status.registrationOpen) setMessage('Public registration is currently closed. Ask an administrator for an invitation.');
    }).catch(() => undefined);
  }, [mode]);

  useEffect(() => {
    if (user) navigate('/app', { replace: true });
  }, [user, navigate]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null); setMessage(null); setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password, totp || undefined);
        navigate('/app', { replace: true });
        return;
      }
      if (mode === 'register') {
        const result = await api.register({ displayName, email, password, serviceAreaId, phone: phone || undefined });
        setMessage(result.message);
        navigate('/app', { replace: true });
        return;
      }
      if (mode === 'reset') {
        const token = params.get('token') || '';
        if (token) {
          const result = await api.resetPassword(token, newPassword);
          setMessage(result.message || 'Password updated. You can sign in now.');
          navigate('/login', { replace: true });
          return;
        }
        await api.forgotPassword(email);
        setMessage('If that address has an account, a reset link is on its way.');
        return;
      }
      await api.acceptInvite(params.get('invite') || '', password, displayName || undefined);
      navigate('/app', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'reset' && !params.get('token')) {
    return (
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <Card title="Reset your password" subtitle="We send a single-use link that expires in one hour.">
          <form onSubmit={onSubmit} className="stack" style={{ gap: '0.5rem' }}>
            <Field label="Email address"><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} /></Field>
            <button className="btn block" type="submit" disabled={busy}>Send reset link</button>
          </form>
          {message && <Notice tone="success">{message}</Notice>}
          {error && <Notice tone="critical">{error}</Notice>}
          <p className="subtle" style={{ marginTop: '0.75rem' }}><Link to="/login">Back to sign in</Link></p>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
      <Card
        title={mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create your account' : mode === 'invite' ? 'Accept your invitation' : 'Choose a new password'}
        subtitle={mode === 'register' ? 'Registration is limited to the service areas configured by the site administrators.' : undefined}
      >
        {mode === 'register' && !config && <Loading label="Loading service areas…" />}
        <form onSubmit={onSubmit} className="stack" style={{ gap: '0.4rem' }}>
          {(mode === 'register' || mode === 'invite') && (
            <Field label="Display name"><input required minLength={2} maxLength={100} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
          )}

          {mode !== 'invite' && mode !== 'reset' && (
            <Field label="Email address"><input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} /></Field>
          )}

          {mode === 'reset' && (
            <Field label="New password" hint="At least 10 characters with upper case, lower case and a number.">
              <input type="password" required autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} maxLength={128} />
            </Field>
          )}

          {mode !== 'reset' && (
            <Field label="Password" hint={mode === 'register' || mode === 'invite' ? 'At least 10 characters with upper case, lower case and a number.' : undefined}>
              <input type="password" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} />
            </Field>
          )}

          {mode === 'login' && (
            <Field label="Authenticator code (staff accounts)" hint="Leave empty for member accounts.">
              <input inputMode="numeric" pattern="\d{6}" maxLength={6} value={totp} onChange={(event) => setTotp(event.target.value)} />
            </Field>
          )}

          {mode === 'register' && config && (
            <>
              <Field label="Service area" hint="Only listed cities and countries can register. IP location is a secondary check only.">
                <select required value={serviceAreaId} onChange={(event) => setServiceAreaId(event.target.value)}>
                  <option value="">Select a city…</option>
                  {config.serviceAreas.map((area) => (
                    <option key={area.id} value={area.id}>{area.city}, {area.country}{area.region ? ` — ${area.region}` : ''}</option>
                  ))}
                </select>
              </Field>
              <Field label="Phone (optional)" hint="E.164 format, for example +8801XXXXXXXXX. Required before SMS alerts can be enabled.">
                <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+8801XXXXXXXXX" maxLength={16} />
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
                <span>I agree to receive optional status notifications and understand this prototype is not an emergency alert service.</span>
              </label>
            </>
          )}

          <button className="btn block" type="submit" disabled={busy || (mode === 'register' && !consent)}>
            {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'invite' ? 'Accept invitation' : 'Update password'}
          </button>
        </form>

        {error && <Notice tone="critical">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}

        <div className="row" style={{ justifyContent: 'space-between', marginTop: '0.9rem' }}>
          {mode === 'login' ? (
            <>
              <Link to="/reset-password">Forgot your password?</Link>
              <Link to="/register">Create an account</Link>
            </>
          ) : (
            <Link to="/login">Back to sign in</Link>
          )}
        </div>
      </Card>

      {mode === 'login' && (
        <p className="subtle center" style={{ marginTop: '0.9rem', fontSize: '0.85rem' }}>
          Staff accounts are created by invitation only. The first super admin is created with the one-time bootstrap token.
        </p>
      )}
    </div>
  );
}
