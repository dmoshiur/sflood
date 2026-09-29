import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, Field, Loading, Notice, StateBadge, Stat, Tabs } from '../components/ui';
import { useAuth } from '../App';

/** Admin console. Super admins see everything; local admins only their assigned site. */

type Row = Record<string, unknown>;

export default function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState<Row | null>(null);
  const [users, setUsers] = useState<Row[]>([]);
  const [invites, setInvites] = useState<Row[]>([]);
  const [policies, setPolicies] = useState<Row[]>([]);
  const [subscribers, setSubscribers] = useState<Row | null>(null);
  const [records, setRecords] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Row[]>([]);
  const [settings, setSettings] = useState<Row | null>(null);
  const [reports, setReports] = useState<Row | null>(null);
  const [audit, setAudit] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'OPERATOR'>('ADMIN');
  const [inviteZone, setInviteZone] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [recordNote, setRecordNote] = useState('');
  const [recordLevel, setRecordLevel] = useState('');
  const [templateBody, setTemplateBody] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: 587, secure: false, username: '', password: '', fromName: 'FloodGrid', fromAddress: '', replyTo: '', enabled: false });
  const [sms, setSms] = useState({ endpoint: '', authHeader: 'Authorization', authPrefix: 'Bearer ', authToken: '', senderId: '', toField: 'to', messageField: 'message', senderField: 'sender', enabled: false });

  const load = useCallback(async () => {
    try {
      const overviewResult = await api.adminOverview();
      setOverview(overviewResult as unknown as Row);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        if (tab === 'users') setUsers((await api.adminUsers()).users as unknown as Row[]);
        if (tab === 'invites') setInvites((await api.invites()).invites as unknown as Row[]);
        if (tab === 'policies') setPolicies((await api.policies()).policies as unknown as Row[]);
        if (tab === 'subscribers') setSubscribers((await api.subscribers()) as unknown as Row);
        if (tab === 'records') setRecords((await api.records()).records as unknown as Row[]);
        if (tab === 'templates') setTemplates((await api.templates()).templates as unknown as Row[]);
        if (tab === 'settings') setSettings(await api.settings() as unknown as Row);
        if (tab === 'reports') setReports(await api.reports() as unknown as Row);
        if (tab === 'audit') setAudit((await api.audit()).entries as unknown as Row[]);
      } catch (err) { setError((err as Error).message); }
    })();
  }, [tab]);

  const superAdmin = user?.role === 'OWNER';

  async function createInvite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await api.createInvite({ email: inviteEmail, displayName: inviteName, role: inviteRole, zoneId: inviteZone || undefined });
      setInviteUrl(result.inviteUrl);
      setMessage(result.message);
      setInvites((await api.invites()).invites as unknown as Row[]);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function addRecord(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      await api.createRecord({ note: recordNote, levelCm: recordLevel === '' ? null : Number(recordLevel) });
      setRecordNote(''); setRecordLevel('');
      setMessage('Manual record saved.');
      setRecords((await api.records()).records as unknown as Row[]);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function saveTemplate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      await api.saveTemplate({ templateKey: 'flood_transition', channel: 'EMAIL', state: 'CRITICAL', subject: '{{zone}}: CRITICAL water level', body: templateBody });
      setMessage('Template saved.');
      setTemplates((await api.templates()).templates as unknown as Row[]);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function saveSmtpSettings(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      await api.saveSmtp(smtp);
      setMessage('SMTP settings encrypted and saved.');
      void api.providers();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function saveSmsSettings(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      await api.saveSms(sms);
      setMessage('SMS gateway settings encrypted and saved.');
      void api.providers();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (!overview) return <Loading label="Loading admin console…" />;

  const counts = (overview.counts || {}) as Row;
  const events = (overview.events || []) as Row[];
  const devices = (overview.devices || []) as Row[];
  const flags = (overview.flags || {}) as Row;

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Admin console</h1>
          <p>
            Role {String(overview.role)} · scope {overview.scope && Object.keys(overview.scope as Row).length ? JSON.stringify(overview.scope) : 'tenant-wide'} ·
            database {String(overview.mode)}
          </p>
        </div>
        <div className="row">
          <Link className="btn secondary small" to="/admin/pages">Site builder</Link>
          <button type="button" className="btn secondary small" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {error && <Notice tone="critical">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {overview.maintenanceMode ? <Notice tone="warning">Maintenance mode is enabled.</Notice> : null}

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'users', label: 'Users' },
          { id: 'invites', label: 'Invitations' },
          { id: 'devices', label: 'Devices' },
          { id: 'policies', label: 'Thresholds' },
          { id: 'alerts', label: 'Alerts' },
          { id: 'subscribers', label: 'Subscribers' },
          { id: 'records', label: 'Manual records' },
          { id: 'templates', label: 'Templates' },
          { id: 'providers', label: 'Providers' },
          { id: 'settings', label: 'Settings' },
          { id: 'reports', label: 'Reports' },
          { id: 'audit', label: 'Audit log' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <>
          <div className="grid cols-4">
            <Stat label="Users" value={String(counts.users ?? 0)} detail="Registered accounts" />
            <Stat label="Devices" value={String(counts.devices ?? 0)} detail={`${devices.filter((device) => device.health === 'ONLINE').length} online`} />
            <Stat label="Telemetry" value={String(counts.telemetry ?? 0)} detail="Stored samples" />
            <Stat label="Flood events" value={String(counts.flood_events ?? 0)} detail="Persisted transitions" />
          </div>
          <div className="grid cols-2">
            <Card title="Recent flood events">
              {events.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>When</th><th>Transition</th><th>Level</th><th>Reason</th></tr></thead>
                    <tbody>
                      {events.slice(0, 10).map((event) => (
                        <tr key={String(event.id)}>
                          <td className="nowrap">{new Date(String(event.createdAt)).toLocaleString()}</td>
                          <td><StateBadge state={String(event.toState)} /></td>
                          <td>{event.levelCm === null || event.levelCm === undefined ? '—' : `${Number(event.levelCm).toFixed(1)} cm`}</td>
                          <td className="muted">{String(event.reason || '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>No events yet.</Empty>}
            </Card>
            <Card title="Feature flags">
              <dl className="kv">
                {Object.entries(flags).map(([key, value]) => (
                  <div key={key} style={{ display: 'contents' }}>
                    <dt>{key}</dt><dd>{value ? 'enabled' : 'disabled'}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
        </>
      )}

      {tab === 'users' && (
        <Card title="Accounts" subtitle="Role and site scope are enforced server-side on every request">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Service area</th><th>Verified</th><th>Last sign in</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map((row) => (
                  <tr key={String(row.id)}>
                    <td>{String(row.displayName)}{row.disabled ? ' (disabled)' : ''}</td>
                    <td>{String(row.email)}</td>
                    <td>{String(row.role)}</td>
                    <td>{row.serviceCity ? `${String(row.serviceCity)}, ${String(row.serviceCountry || '')}` : '—'}</td>
                    <td>{row.emailVerified ? <span className="badge normal">email</span> : <span className="badge watch">pending</span>}</td>
                    <td className="nowrap">{row.lastLoginAt ? new Date(String(row.lastLoginAt)).toLocaleString() : '—'}</td>
                    <td>
                      <div className="row">
                        <button type="button" className="btn secondary small" onClick={() => void api.updateUser(String(row.id), { disabled: !row.disabled }).then(() => api.adminUsers().then((result) => setUsers(result.users as unknown as Row[])))}>
                          {row.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button type="button" className="btn secondary small" onClick={() => void api.resetUserMfa(String(row.id)).then(() => setMessage('MFA reset.'))}>Reset MFA</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'invites' && (
        <div className="grid cols-2">
          <Card title="Invite staff">
            <form onSubmit={createInvite} className="stack" style={{ gap: '0.4rem' }}>
              <Field label="Email"><input type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} maxLength={254} /></Field>
              <Field label="Display name"><input required minLength={2} maxLength={100} value={inviteName} onChange={(event) => setInviteName(event.target.value)} /></Field>
              <Field label="Role">
                <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'ADMIN' | 'OPERATOR')}>
                  <option value="ADMIN">Local admin (scoped)</option>
                  <option value="OPERATOR">Operator (read and acknowledge)</option>
                </select>
              </Field>
              {inviteRole === 'ADMIN' && <Field label="Zone id" hint="Required for a local admin."><input value={inviteZone} onChange={(event) => setInviteZone(event.target.value)} maxLength={64} /></Field>}
              <button className="btn" type="submit" disabled={busy}>Create invitation</button>
            </form>
            {inviteUrl && (
              <Notice tone="warning">Send this link through a secure channel. It is shown only once.<br /><span className="mono" style={{ wordBreak: 'break-all' }}>{inviteUrl}</span></Notice>
            )}
          </Card>
          <Card title="Invitations">
            {invites.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Used</th></tr></thead>
                  <tbody>
                    {invites.map((invite) => (
                      <tr key={String(invite.id)}>
                        <td>{String(invite.email)}</td>
                        <td>{String(invite.role)}</td>
                        <td className="nowrap">{new Date(String(invite.expiresAt)).toLocaleString()}</td>
                        <td>{invite.used ? 'yes' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty>No invitations yet.</Empty>}
          </Card>
        </div>
      )}

      {tab === 'devices' && (
        <Card title="Devices" subtitle="Approve nodes, rotate credentials and inspect live telemetry">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Device</th><th>Board</th><th>Approval</th><th>Health</th><th>State</th><th>Site</th></tr></thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={String(device.id)}>
                    <td><strong>{String(device.name)}</strong><div className="mono subtle">{String(device.uid)}</div></td>
                    <td>{String(device.board)}</td>
                    <td>{String(device.approvalState)}</td>
                    <td>{String(device.health)}</td>
                    <td><StateBadge state={String(device.currentState)} /></td>
                    <td>{String(device.cityName)} · {String(device.zoneName)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="subtle" style={{ marginTop: '0.6rem' }}>
            Full registry, provisioning QR codes and firmware links are in <Link to="/app/devices">device management</Link>.
          </p>
        </Card>
      )}

      {tab === 'policies' && (
        <Card title="Flood policy" subtitle="Absolute thresholds, rate of rise, hysteresis, recovery, cooldown and multi-sensor confirmation">
          {policies.length ? (
            <div className="stack" style={{ gap: '0.75rem' }}>
              {policies.map((policy) => (
                <div key={String(policy.id)} className="card">
                  <div className="card-head">
                    <div>
                      <h3>{String(policy.name)}</h3>
                      <p>{String(policy.scope)} · zone {String(policy.zoneId || 'all')}</p>
                    </div>
                    <span className={`badge ${policy.enabled ? 'normal' : 'neutral'}`}>{policy.enabled ? 'enabled' : 'disabled'}</span>
                  </div>
                  <dl className="kv">
                    <dt>Normal below</dt><dd>{String(policy.normalBelowCm)} cm</dd>
                    <dt>Watch</dt><dd>{String(policy.watchCm)} cm</dd>
                    <dt>Warning</dt><dd>{String(policy.warningCm)} cm</dd>
                    <dt>Critical</dt><dd>{String(policy.criticalCm)} cm</dd>
                    <dt>Rate of rise</dt><dd>{String(policy.rateOfRiseCmPerMin)} cm/min</dd>
                    <dt>Hysteresis</dt><dd>{String(policy.hysteresisCm)} cm</dd>
                    <dt>Recovery</dt><dd>{String(policy.recoveryCm)} cm for {String(policy.recoveryHoldSeconds)} s</dd>
                    <dt>Cooldown</dt><dd>{String(policy.cooldownSeconds)} s</dd>
                    <dt>Confirmation</dt><dd>{String(policy.confirmationSamples)} samples in {String(policy.confirmationWindowSeconds)} s</dd>
                    <dt>Auto barrier</dt><dd>{String((policy.autoBarrierStates as string[])?.join(', ') || '')}</dd>
                    <dt>Channels</dt><dd>{String((policy.notifyChannels as string[])?.join(', ') || '')}</dd>
                  </dl>
                </div>
              ))}
            </div>
          ) : <Empty>No policy configured.</Empty>}
        </Card>
      )}

      {tab === 'alerts' && (
        <Card title="Flood events">
          {events.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Transition</th><th>Level</th><th>Simulated</th><th>Acknowledged</th><th /></tr></thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={String(event.id)}>
                      <td className="nowrap">{new Date(String(event.createdAt)).toLocaleString()}</td>
                      <td>{String(event.fromState)} → {String(event.toState)}</td>
                      <td>{event.levelCm === null ? '—' : `${Number(event.levelCm).toFixed(1)} cm`}</td>
                      <td>{event.simulated ? 'yes' : 'no'}</td>
                      <td>{event.acknowledgedAt ? new Date(String(event.acknowledgedAt)).toLocaleString() : 'open'}</td>
                      <td>
                        {!event.acknowledgedAt && (
                          <button type="button" className="btn secondary small" onClick={() => void api.acknowledgeAlert(String(event.id)).then(() => void load())}>Acknowledge</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>No flood events yet.</Empty>}
        </Card>
      )}

      {tab === 'subscribers' && subscribers && (
        <div className="grid cols-2">
          <Card title="Email subscribers">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Email</th><th>Verified</th><th>Unsubscribed</th><th>Source</th></tr></thead>
                <tbody>
                  {((subscribers.emailSubscribers || []) as Row[]).map((row) => (
                    <tr key={String(row.id)}>
                      <td>{String(row.email)}</td>
                      <td>{row.verified ? 'yes' : 'pending'}</td>
                      <td>{row.unsubscribed ? 'yes' : 'no'}</td>
                      <td>{String(row.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Push subscriptions and members">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Endpoint</th><th>Active</th></tr></thead>
                <tbody>
                  {((subscribers.pushSubscriptions || []) as Row[]).map((row) => (
                    <tr key={String(row.id)}>
                      <td className="mono">{String(row.endpoint)}</td>
                      <td>{row.active ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
              <table className="data">
                <thead><tr><th>Member</th><th>Role</th><th>Service area</th></tr></thead>
                <tbody>
                  {((subscribers.registeredUsers || []) as Row[]).map((row) => (
                    <tr key={String(row.id)}>
                      <td>{String(row.displayName)}<div className="subtle">{String(row.email)}</div></td>
                      <td>{String(row.role)}</td>
                      <td>{String(row.serviceCity || '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === 'records' && (
        <div className="grid cols-2">
          <Card title="Add a manual record">
            <form onSubmit={addRecord} className="stack" style={{ gap: '0.4rem' }}>
              <Field label="Note"><textarea required minLength={2} maxLength={2000} rows={4} value={recordNote} onChange={(event) => setRecordNote(event.target.value)} /></Field>
              <Field label="Measured level (cm, optional)"><input type="number" min={0} max={2000} value={recordLevel} onChange={(event) => setRecordLevel(event.target.value)} /></Field>
              <button className="btn" type="submit" disabled={busy}>Save record</button>
            </form>
          </Card>
          <Card title="Manual records">
            {records.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>When</th><th>Kind</th><th>Level</th><th>Note</th></tr></thead>
                  <tbody>
                    {records.map((record) => (
                      <tr key={String(record.id)}>
                        <td className="nowrap">{new Date(String(record.createdAt)).toLocaleString()}</td>
                        <td>{String(record.kind)}</td>
                        <td>{record.levelCm === null || record.levelCm === undefined ? '—' : `${Number(record.levelCm).toFixed(1)} cm`}</td>
                        <td className="muted">{String(record.note)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty>No manual records yet.</Empty>}
          </Card>
        </div>
      )}

      {tab === 'templates' && (
        <div className="grid cols-2">
          <Card title="Notification template">
            <form onSubmit={saveTemplate} className="stack" style={{ gap: '0.4rem' }}>
              <Field label="Body" hint="Placeholders: {{zone}}, {{level}}, {{device}}, {{reason}}.">
                <textarea required minLength={2} maxLength={4000} rows={6} value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} />
              </Field>
              <button className="btn" type="submit" disabled={busy}>Save template</button>
            </form>
          </Card>
          <Card title="Saved templates">
            {templates.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Key</th><th>Channel</th><th>State</th><th>Subject</th></tr></thead>
                  <tbody>
                    {templates.map((template) => (
                      <tr key={String(template.id)}>
                        <td className="mono">{String(template.templateKey)}</td>
                        <td>{String(template.channel)}</td>
                        <td>{String(template.state)}</td>
                        <td className="muted">{String(template.subject || '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty>No templates saved yet.</Empty>}
          </Card>
        </div>
      )}

      {tab === 'providers' && (
        <div className="grid cols-2">
          <Card title="SMTP email" subtitle="Credentials are encrypted with AES-256-GCM before storage and never returned to the browser">
            <form onSubmit={saveSmtpSettings} className="stack" style={{ gap: '0.4rem' }}>
              <Field label="Host"><input required value={smtp.host} onChange={(event) => setSmtp({ ...smtp, host: event.target.value })} placeholder="smtp.example.org" /></Field>
              <Field label="Port"><input type="number" min={1} max={65535} value={smtp.port} onChange={(event) => setSmtp({ ...smtp, port: Number(event.target.value) })} /></Field>
              <Field label="Username"><input value={smtp.username} onChange={(event) => setSmtp({ ...smtp, username: event.target.value })} /></Field>
              <Field label="Password" hint="Leave empty to keep the stored password."><input type="password" value={smtp.password} onChange={(event) => setSmtp({ ...smtp, password: event.target.value })} /></Field>
              <Field label="From address"><input type="email" required value={smtp.fromAddress} onChange={(event) => setSmtp({ ...smtp, fromAddress: event.target.value })} /></Field>
              <Field label="From name"><input value={smtp.fromName} onChange={(event) => setSmtp({ ...smtp, fromName: event.target.value })} /></Field>
              <label className="checkbox"><input type="checkbox" checked={smtp.enabled} onChange={(event) => setSmtp({ ...smtp, enabled: event.target.checked })} /> Enable SMTP delivery</label>
              <div className="row">
                <button className="btn" type="submit" disabled={busy || !superAdmin}>Save SMTP settings</button>
                {superAdmin && <button type="button" className="btn secondary" onClick={() => void api.testSmtp(user?.email || '').then(() => setMessage('Test email sent.')).catch((err) => setError((err as Error).message))}>Send test email</button>}
              </div>
              {!superAdmin && <p className="subtle">Only a super admin can change provider settings.</p>}
            </form>
          </Card>
          <Card title="SMS gateway" subtitle="Any HTTPS JSON gateway; the token is encrypted at rest">
            <form onSubmit={saveSmsSettings} className="stack" style={{ gap: '0.4rem' }}>
              <Field label="Endpoint"><input required value={sms.endpoint} onChange={(event) => setSms({ ...sms, endpoint: event.target.value })} placeholder="https://gateway.example.org/send" /></Field>
              <Field label="API token" hint="Leave empty to keep the stored token."><input type="password" value={sms.authToken} onChange={(event) => setSms({ ...sms, authToken: event.target.value })} /></Field>
              <Field label="Sender id"><input value={sms.senderId} onChange={(event) => setSms({ ...sms, senderId: event.target.value })} /></Field>
              <Field label="Recipient field"><input value={sms.toField} onChange={(event) => setSms({ ...sms, toField: event.target.value })} /></Field>
              <Field label="Message field"><input value={sms.messageField} onChange={(event) => setSms({ ...sms, messageField: event.target.value })} /></Field>
              <label className="checkbox"><input type="checkbox" checked={sms.enabled} onChange={(event) => setSms({ ...sms, enabled: event.target.checked })} /> Enable the SMS channel</label>
              <div className="row">
                <button className="btn" type="submit" disabled={busy || !superAdmin}>Save SMS settings</button>
                {superAdmin && <button type="button" className="btn secondary" onClick={() => void api.testSms('+8801000000000').then(() => setMessage('Test SMS accepted.')).catch((err) => setError((err as Error).message))}>Send test SMS</button>}
              </div>
            </form>
          </Card>
        </div>
      )}

      {tab === 'settings' && settings && (
        <div className="grid cols-2">
          <Card title="Site settings">
            <form className="stack" style={{ gap: '0.4rem' }} onSubmit={async (event) => {
              event.preventDefault(); setBusy(true); setMessage(null); setError(null);
              try {
                const patch: Row = {};
                for (const [key, value] of Object.entries(((settings.settings || {}) as Row))) patch[key] = value;
                await api.updateSettings(patch);
                setMessage('Settings saved.');
              } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
            }}>
              {Object.entries((settings.settings || {}) as Row).map(([key, value]) => (
                <Field key={key} label={key}>
                  <input
                    value={typeof value === 'string' ? value : JSON.stringify(value)}
                    onChange={(event) => {
                      const next: Row = { ...((settings.settings || {}) as Row) };
                      next[key] = event.target.value;
                      setSettings({ ...settings, settings: next });
                    }}
                  />
                </Field>
              ))}
              <button className="btn" type="submit" disabled={busy}>Save settings</button>
            </form>
          </Card>
          <Card title="Feature flags" subtitle="Super admin only">
            <dl className="kv">
              {Object.entries((settings.flags || {}) as Row).map(([key, value]) => (
                <div key={key} style={{ display: 'contents' }}>
                  <dt>{key}</dt>
                  <dd>
                    {superAdmin ? (
                      <button type="button" className="btn secondary small" onClick={() => void api.setFlag(key, !value).then(async () => setSettings(await api.settings() as unknown as Row))}>
                        {value ? 'disable' : 'enable'}
                      </button>
                    ) : value ? 'enabled' : 'disabled'}
                  </dd>
                </div>
              ))}
            </dl>
            <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '0.9rem 0' }} />
            <div className="row">
              <button type="button" className="btn secondary" onClick={() => void api.setMaintenance(true, 'Admin console').then(() => void load())}>Enable maintenance</button>
              <button type="button" className="btn secondary" onClick={() => void api.setMaintenance(false).then(() => void load())}>Disable maintenance</button>
            </div>
          </Card>
        </div>
      )}

      {tab === 'reports' && reports && (
        <div className="grid cols-2">
          <Card title="Events by state">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>State</th><th>Count</th></tr></thead>
                <tbody>
                  {((reports.eventsByState || []) as Row[]).map((row) => (
                    <tr key={String(row.state)}><td>{String(row.state)}</td><td>{String(row.count)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Events by day">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Day</th><th>Count</th></tr></thead>
                <tbody>
                  {((reports.eventsByDay || []) as Row[]).map((row) => (
                    <tr key={String(row.day)}><td>{String(row.day)}</td><td>{String(row.count)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Notification delivery by channel">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Channel</th><th>Status</th><th>Count</th></tr></thead>
                <tbody>
                  {((reports.deliveriesByChannel || []) as Row[]).map((row, index) => (
                    <tr key={`${String(row.channel)}-${String(row.status)}-${index}`}>
                      <td>{String(row.channel)}</td><td>{String(row.status)}</td><td>{String(row.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Device uptime">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Device</th><th>Health</th><th>Uptime</th><th>Approval</th></tr></thead>
                <tbody>
                  {((reports.deviceUptime || []) as Row[]).map((row) => (
                    <tr key={String(row.uid)}>
                      <td>{String(row.name)}<div className="mono subtle">{String(row.uid)}</div></td>
                      <td>{String(row.health)}</td>
                      <td>{Math.floor(Number(row.uptimeSeconds || 0) / 60)} min</td>
                      <td>{String(row.approvalState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === 'audit' && (
        <Card title="Audit log" subtitle="Every privileged action is recorded with actor, target, metadata and source IP">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th><th>Metadata</th></tr></thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={String(entry.id)}>
                    <td className="nowrap">{new Date(String(entry.createdAt)).toLocaleString()}</td>
                    <td>{String(entry.actorEmail)}</td>
                    <td className="mono">{String(entry.action)}</td>
                    <td className="mono subtle">{String(entry.targetType)}{entry.targetId ? `:${String(entry.targetId).slice(0, 8)}` : ''}</td>
                    <td>{String(entry.ipAddress || '—')}</td>
                    <td className="muted" style={{ maxWidth: 280, overflow: 'hidden' }}>{JSON.stringify(entry.metadata || {})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
