import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Field, Loading, Notice, Stat, Tabs } from '../components/ui';
import { useAuth } from '../App';

/**
 * Restricted operations console.
 *
 * Access needs three factors: an authenticated super-admin session with verified
 * TOTP, the current rotating operations credential (emailed to the configured
 * security mailbox, stored only as a hash, single use), and an allowlisted source
 * IP. The credential value is never shown here or anywhere in the frontend.
 */

type Row = Record<string, unknown>;

export default function HackerAdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('unlock');
  const [status, setStatus] = useState<Row | null>(null);
  const [overview, setOverview] = useState<Row | null>(null);
  const [credential, setCredential] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maintenanceReason, setMaintenanceReason] = useState('');
  const [emergencyStatus, setEmergencyStatus] = useState('WARNING');
  const [emergencyNote, setEmergencyNote] = useState('');
  const [backupNote, setBackupNote] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const result = await api.opsStatus();
      setStatus(result as unknown as Row);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const result = await api.opsOverview();
      setOverview(result as unknown as Row);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setOverview(null);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (status?.opsSessionActive) {
      void loadOverview();
      setTab('console');
    }
  }, [status?.opsSessionActive, loadOverview]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api.opsUnlock(credential.trim(), totp || undefined);
      setMessage(result.message || 'Operations console unlocked.');
      setCredential(''); setTotp('');
      await loadStatus();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function lock() {
    setBusy(true); setError(null);
    try {
      await api.opsLock();
      setOverview(null);
      setMessage('Operations console locked.');
      await loadStatus();
      setTab('unlock');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (!status) return <Loading label="Loading operations console…" />;

  const unlocked = Boolean(status.opsSessionActive);

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Operations console</h1>
          <p>
            Rotating credential · rotation every {String(status.rotationMinutes)} minutes · credential lifetime {String(status.credentialTtlMinutes)} minutes ·
            second factor {status.requireMfa ? 'TOTP required' : 'not enforced'}
          </p>
        </div>
        <div className="row">
          <span className={`badge ${unlocked ? 'normal' : 'critical'}`}>{unlocked ? 'UNLOCKED' : 'LOCKED'}</span>
          {unlocked && <button type="button" className="btn danger" onClick={() => void lock()} disabled={busy}>Lock console</button>}
        </div>
      </div>

      <hr className="gold-rule" />
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="critical">{error}</Notice>}

      {!unlocked ? (
        <div className="grid cols-2">
          <Card title="Unlock with the rotating credential" subtitle="The value is emailed to the configured security mailbox and never appears in this application">
            <form onSubmit={unlock} className="stack" style={{ gap: '0.4rem' }}>
              <Field label="Operations credential" hint="Format FG-OPS-XXX-XXXXXXXXXX. Single use, expires automatically.">
                <input required value={credential} onChange={(event) => setCredential(event.target.value)} maxLength={64} autoComplete="one-time-code" />
              </Field>
              <Field label="Authenticator code" hint="Second factor for this super-admin session.">
                <input required pattern="\d{6}" maxLength={6} value={totp} onChange={(event) => setTotp(event.target.value)} inputMode="numeric" />
              </Field>
              <button className="btn gold" type="submit" disabled={busy}>Unlock console</button>
            </form>
          </Card>
          <Card title="Delivery status">
            <dl className="kv">
              <dt>Security email</dt><dd>{status.securityEmailConfigured ? 'configured' : 'not configured (set OPS_SECURITY_EMAIL)'}</dd>
              <dt>SMTP</dt><dd>{status.smtpConfigured ? 'configured' : 'not configured'}</dd>
              <dt>IP allowlist</dt><dd>{status.ipAllowlistConfigured ? 'configured' : 'not configured'}</dd>
              <dt>Signed in as</dt><dd>{user ? `${user.displayName} (${user.email})` : 'unknown'}</dd>
              <dt>Current credential</dt>
              <dd>
                {(() => {
                  const credential = status.currentCredential as Row | null;
                  if (!credential) return 'none issued yet';
                  return `issued ${new Date(String(credential.issuedAt)).toLocaleString()}, expires ${new Date(String(credential.expiresAt)).toLocaleString()}${credential.consumed ? ', consumed' : ''}`;
                })()}
              </dd>
            </dl>
            <p className="subtle" style={{ marginTop: '0.6rem', fontSize: '0.82rem' }}>{String(status.note || '')}</p>
          </Card>
        </div>
      ) : (
        <>
          <div className="grid cols-4">
            <Stat label="Version" value={String(overview?.version || '—')} detail={`commit ${String(overview?.gitCommit || 'unknown').slice(0, 8)}`} />
            <Stat label="Environment" value={String(overview?.environment || '—')} detail={String((overview?.database as Row | undefined)?.mode || '')} />
            <Stat label="Maintenance" value={overview?.maintenanceMode ? 'ON' : 'OFF'} detail="Public status banner" tone={overview?.maintenanceMode ? 'warning' : 'normal'} />
            <Stat label="Active sessions" value={String(((overview?.sessions as Row[]) || []).length)} detail="Revocable below" />
          </div>

          <Tabs
            tabs={[
              { id: 'console', label: 'Controls' },
              { id: 'credentials', label: 'Credential rotation' },
              { id: 'sessions', label: 'Sessions & super admins' },
              { id: 'deployment', label: 'Deployment' },
              { id: 'audit', label: 'Audit log' },
              { id: 'backups', label: 'Backups' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'console' && (
            <div className="grid cols-2">
              <Card title="Maintenance mode" subtitle="Shows a banner on the public status page and records a maintenance event">
                <Field label="Reason"><input value={maintenanceReason} onChange={(event) => setMaintenanceReason(event.target.value)} maxLength={300} /></Field>
                <div className="row">
                  <button type="button" className="btn" onClick={() => void api.opsSetMaintenance(true, maintenanceReason).then(() => { setMessage('Maintenance enabled.'); return loadOverview(); })} disabled={busy}>Enable</button>
                  <button type="button" className="btn secondary" onClick={() => void api.opsSetMaintenance(false).then(() => { setMessage('Maintenance disabled.'); return loadOverview(); })} disabled={busy}>Disable</button>
                </div>
              </Card>

              <Card title="Emergency site status" subtitle="Publishes an authoritative status override to the public status page">
                <Field label="Status">
                  <select value={emergencyStatus} onChange={(event) => setEmergencyStatus(event.target.value)}>
                    <option value="NORMAL">NORMAL</option>
                    <option value="WATCH">WATCH</option>
                    <option value="WARNING">WARNING</option>
                    <option value="CRITICAL">CRITICAL</option>
                    <option value="RECOVERY">RECOVERY</option>
                  </select>
                </Field>
                <Field label="Note"><input value={emergencyNote} onChange={(event) => setEmergencyNote(event.target.value)} maxLength={300} /></Field>
                <button type="button" className="btn gold" onClick={() => void api.opsEmergencyStatus(emergencyStatus, emergencyNote).then(() => setMessage('Emergency status published.'))} disabled={busy}>Publish status</button>
              </Card>

              <Card title="Device emergency controls" subtitle="Commands are queued for the device with a nonce and short expiry">
                {((overview?.commands as Row[]) || []).length ? (
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>Command</th><th>Device</th><th>Action</th><th>Status</th></tr></thead>
                      <tbody>
                        {((overview?.commands as Row[]) || []).map((command) => (
                          <tr key={String(command.commandId)}>
                            <td className="mono">{String(command.commandId).slice(0, 8)}</td>
                            <td className="mono subtle">{String(command.deviceId).slice(0, 8)}</td>
                            <td>{String(command.action)}</td>
                            <td>{String(command.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted">No barrier commands recorded yet.</p>}
                <p className="subtle" style={{ marginTop: '0.6rem', fontSize: '0.82rem' }}>
                  Issue an emergency stop from the <a href="/app/devices">device registry</a> or the dashboard device cards.
                </p>
              </Card>

              <Card title="Feature flags">
                <dl className="kv">
                  {Object.entries((overview?.flags || {}) as Row).map(([key, value]) => (
                    <div key={key} style={{ display: 'contents' }}>
                      <dt>{key}</dt>
                      <dd>
                        <button type="button" className="btn secondary small" onClick={() => void api.opsSetFlag(key, !value).then(() => loadOverview())} disabled={busy}>
                          {value ? 'disable' : 'enable'}
                        </button>
                      </dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </div>
          )}

          {tab === 'credentials' && (
            <Card title="Rotating operations credential" subtitle="Only hashes are stored. Rotating invalidates every earlier credential immediately.">
              <button type="button" className="btn gold" onClick={() => void api.opsRotate().then((result) => { setMessage(result.message); return loadOverview(); })} disabled={busy}>
                Rotate now
              </button>
              <div className="table-wrap" style={{ marginTop: '0.9rem' }}>
                <table className="data">
                  <thead><tr><th>Issued</th><th>Expires</th><th>Consumed</th><th>Revoked</th><th>Failed attempts</th></tr></thead>
                  <tbody>
                    {((overview?.credentials as Row[]) || []).map((credentialRow) => (
                      <tr key={String(credentialRow.id)}>
                        <td className="nowrap">{new Date(String(credentialRow.issuedAt)).toLocaleString()}</td>
                        <td className="nowrap">{new Date(String(credentialRow.expiresAt)).toLocaleString()}</td>
                        <td>{credentialRow.consumed ? 'yes' : 'no'}</td>
                        <td>{credentialRow.revoked ? 'yes' : 'no'}</td>
                        <td>{String(credentialRow.failedAttempts ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="subtle" style={{ marginTop: '0.6rem', fontSize: '0.82rem' }}>
                The credential value is emailed to the security mailbox and is never returned by any API endpoint, log line or error message.
              </p>
            </Card>
          )}

          {tab === 'sessions' && (
            <div className="grid cols-2">
              <Card title="Active sessions" subtitle="Revoking a session signs that browser out immediately">
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>User</th><th>IP</th><th>MFA</th><th>Expires</th><th /></tr></thead>
                    <tbody>
                      {((overview?.sessions as Row[]) || []).map((session) => (
                        <tr key={String(session.id)}>
                          <td>{String(session.email)}</td>
                          <td>{String(session.ipAddress || '—')}</td>
                          <td>{session.mfaVerified ? 'yes' : 'no'}</td>
                          <td className="nowrap">{new Date(String(session.expiresAt)).toLocaleString()}</td>
                          <td>
                            <button type="button" className="btn danger small" onClick={() => void api.opsRevokeSession(String(session.id)).then(() => loadOverview())} disabled={busy}>Revoke</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="Super admins">
                <SuperAdminList onChanged={loadOverview} />
              </Card>
            </div>
          )}

          {tab === 'deployment' && (
            <Card title="Deployment and rollback information" subtitle="Set APP_VERSION and GIT_COMMIT at deploy time">
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Environment</th><th>Version</th><th>Commit</th><th>Deployed</th><th>Note</th></tr></thead>
                  <tbody>
                    {((overview?.deployments as Row[]) || []).map((deployment) => (
                      <tr key={String(deployment.id)}>
                        <td>{String(deployment.environment)}</td>
                        <td className="mono">{String(deployment.appVersion)}</td>
                        <td className="mono">{String(deployment.gitCommit)}</td>
                        <td className="nowrap">{new Date(String(deployment.deployedAt)).toLocaleString()}</td>
                        <td className="muted">{String(deployment.note || '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="kv" style={{ marginTop: '0.9rem' }}>
                <dt>Database</dt><dd>{String((overview?.database as Row | undefined)?.target || '—')}</dd>
                <dt>Version</dt><dd>{String(overview?.version || '—')}</dd>
                <dt>Commit</dt><dd className="mono">{String(overview?.gitCommit || '—')}</dd>
              </dl>
            </Card>
          )}

          {tab === 'audit' && (
            <Card title="Audit log">
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Metadata</th></tr></thead>
                  <tbody>
                    {((overview?.audit as Row[]) || []).map((entry) => (
                      <tr key={String(entry.id)}>
                        <td className="nowrap">{new Date(String(entry.createdAt)).toLocaleString()}</td>
                        <td className="mono">{String(entry.action)}</td>
                        <td className="mono subtle">{String(entry.targetType)}</td>
                        <td className="muted" style={{ maxWidth: 320, overflow: 'hidden' }}>{JSON.stringify(entry.metadata || {})}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {tab === 'backups' && (
            <Card title="Backup bookkeeping" subtitle="Recorded markers plus the full procedure in docs/DEPLOYMENT.md">
              <Field label="Note"><input value={backupNote} onChange={(event) => setBackupNote(event.target.value)} maxLength={300} /></Field>
              <button type="button" className="btn" onClick={() => void api.opsRecordBackup(backupNote).then((result) => { setMessage(result.message); return loadOverview(); })} disabled={busy}>
                Record backup
              </button>
              <BackupList />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function SuperAdminList({ onChanged }: { onChanged: () => Promise<void> }) {
  const [admins, setAdmins] = useState<Row[]>([]);
  const load = useCallback(async () => {
    try { const result = await api.opsSuperAdmins(); setAdmins(result.superAdmins as unknown as Row[]); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Admin</th><th>MFA</th><th>Status</th><th /></tr></thead>
        <tbody>
          {admins.map((admin) => (
            <tr key={String(admin.id)}>
              <td>{String(admin.displayName)}<div className="subtle">{String(admin.email)}</div></td>
              <td>{admin.mfaEnrolled ? 'enrolled' : 'not enrolled'}</td>
              <td>{admin.disabled ? 'disabled' : 'active'}</td>
              <td>
                <button type="button" className="btn danger small" onClick={() => void api.opsResetSuperAdminMfa(String(admin.id)).then(async () => { await load(); await onChanged(); })}>Reset MFA</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BackupList() {
  const [backups, setBackups] = useState<Row[]>([]);
  const load = useCallback(async () => {
    try { const result = await api.opsBackups(); setBackups(result.backups as unknown as Row[]); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="table-wrap" style={{ marginTop: '0.9rem' }}>
      <table className="data">
        <thead><tr><th>When</th><th>Kind</th><th>Target</th><th>Status</th><th>Note</th></tr></thead>
        <tbody>
          {backups.map((backup) => (
            <tr key={String(backup.id)}>
              <td className="nowrap">{new Date(String(backup.createdAt)).toLocaleString()}</td>
              <td>{String(backup.kind)}</td>
              <td className="mono subtle">{String(backup.target)}</td>
              <td>{String(backup.status)}</td>
              <td className="muted">{String(backup.note || '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
