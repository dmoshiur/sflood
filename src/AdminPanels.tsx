import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, Cpu, Key, Layers3, LockKeyhole, Plus,
  QrCode, RefreshCw, ShieldAlert, Trash2, X,
} from 'lucide-react';
import {
  adminAddServiceArea, adminApproveDevice, adminAutomation, adminContent, adminCreateCommand,
  adminDevices, adminEmergency, adminFeatures, adminFloodEvents, adminMaintenance, adminProvisionToken,
  adminPublish, adminRevokeDevice, adminRollback, adminRotateKey, adminSaveAutomation, adminSaveDraft,
  adminSaveFeatures, adminSaveThresholds, adminServiceAreas, adminThresholds, adminToggleServiceArea,
  opsAudit, opsDeployment, opsLock, opsStatus, opsUnlock,
  type ContentBlock, type ContentRevisionView, type ServiceArea,
} from './adminApi';
import { ContentBlocks, type ContentBlockData } from './components/ContentBlocks';

function useAsync<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try { setData(await loader()); } catch (exception) { setError(exception instanceof Error ? exception.message : 'Request failed.'); }
    finally { setBusy(false); }
  }, [loader]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, busy, reload: load };
}

function PanelError({ message }: { message: string }) {
  return <p className="admin-feedback admin-feedback-error" role="alert">{message}</p>;
}

// ---------------------------------------------------------------- devices ---

type AdminDevice = {
  id: string; name: string; kind: string; zoneName: string; cityName: string; cityId: string;
  approvalState: string; enabled: boolean; firmwareVersion: string; lastSeenAt: string | null;
  limitSwitchState: string | null; faultState: string | null; latestLevelCm: number | null; latestState: string;
  hasProvisioningToken: boolean;
};

export function DevicesPanel() {
  const { data, error, busy, reload } = useAsync(() => adminDevices());
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [qr, setQr] = useState<{ svg: string; payload: string; expiresAt: string; message: string } | null>(null);
  const [keyOnce, setKeyOnce] = useState('');
  const devices = (data?.devices ?? []) as unknown as AdminDevice[];

  const provision = async (deviceId: string) => {
    setActionError(''); setNotice('');
    try {
      const result = await adminProvisionToken(deviceId);
      setQr({ svg: result.qrSvg, payload: result.setupPayload, expiresAt: result.expiresAt, message: result.message });
      await reload();
    } catch (exception) {
      setActionError(exception instanceof Error ? exception.message : 'Provisioning token request failed.');
    }
  };
  const act = async (fn: () => Promise<Record<string, unknown>>, label: string) => {
    setActionError(''); setNotice('');
    try {
      const result = await fn();
      setNotice(typeof result.message === 'string' ? result.message : `${label} completed.`);
      if (typeof result.apiKey === 'string') setKeyOnce(result.apiKey);
      await reload();
    } catch (exception) {
      setActionError(exception instanceof Error ? exception.message : `${label} failed.`);
    }
  };

  return <div className="console-panel">
    <div className="console-panel-head"><div><h2>Device registry</h2><p>Approve, revoke, rotate keys, issue remote commands and generate one-time provisioning tokens.</p></div><button className="icon-button" onClick={() => void reload()} aria-label="Reload devices"><RefreshCw size={15} /></button></div>
    {error && <PanelError message={error} />}
    {actionError && <PanelError message={actionError} />}
    {notice && <p className="admin-feedback" role="status"><Check size={14} /> {notice}</p>}
    {keyOnce && (
      <div className="ops-code-box"><strong>Device API key (shown once):</strong><code>{keyOnce}</code>
        <button onClick={() => setKeyOnce('')}><X size={13} /> Hide</button></div>
    )}
    {qr && (
      <div className="ops-code-box">
        <strong>One-time provisioning token (expires {new Date(qr.expiresAt).toLocaleString()}):</strong>
        <div className="qr-holder" dangerouslySetInnerHTML={{ __html: qr.svg }} />
        <code className="ops-payload">{qr.payload}</code>
        <button onClick={() => setQr(null)}><X size={13} /> Hide</button>
      </div>
    )}
    <div className="device-table-wrap">
      <table className="device-table">
        <thead><tr><th>Device</th><th>Approval</th><th>Health</th><th>Level / state</th><th>Actions</th></tr></thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id}>
              <td><strong>{device.name}</strong><small>{device.id} · {device.kind} · {device.zoneName}, {device.cityName}</small></td>
              <td><span className={`approval-chip approval-${device.approvalState.toLowerCase()}`}>{device.approvalState}</span></td>
              <td><small>FW {device.firmwareVersion}<br />{device.lastSeenAt ? `seen ${new Date(device.lastSeenAt).toLocaleTimeString()}` : 'never seen'}{device.limitSwitchState ? ` · switch ${device.limitSwitchState}` : ''}{device.faultState ? ` · fault ${device.faultState}` : ''}</small></td>
              <td><small>{device.latestLevelCm === null ? '—' : `${device.latestLevelCm.toFixed(1)} cm`} · {device.latestState}</small></td>
              <td className="device-actions">
                {device.approvalState !== 'APPROVED' && <button onClick={() => void act(() => adminApproveDevice(device.id) as Promise<Record<string, unknown>>, 'Approve')}>Approve</button>}
                {device.approvalState === 'APPROVED' && <button onClick={() => void act(() => adminRevokeDevice(device.id) as Promise<Record<string, unknown>>, 'Revoke')}>Revoke</button>}
                <button onClick={() => void provision(device.id)}><QrCode size={13} /> Token</button>
                <button onClick={() => void act(() => adminRotateKey(device.id) as Promise<Record<string, unknown>>, 'Rotate key')}><Key size={13} /> Rotate</button>
                {device.kind === 'ESP32_CONTROLLER' && <>
                  <button onClick={() => void act(() => adminCreateCommand(device.id, 'BARRIER_RAISE').then((r) => ({ message: r.message })), 'Raise')}>Raise</button>
                  <button onClick={() => void act(() => adminCreateCommand(device.id, 'BARRIER_LOWER').then((r) => ({ message: r.message })), 'Lower')}>Lower</button>
                  <button onClick={() => void act(() => adminCreateCommand(device.id, 'BARRIER_HOLD').then((r) => ({ message: r.message })), 'Hold')}>Hold</button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {busy && <p className="gauge-footnote">Working…</p>}
    {devices.length === 0 && !error && <p className="empty-note">No devices in the registry.</p>}
    <p className="gauge-footnote"><ShieldAlert size={12} /> Barrier commands carry a server nonce, expire after 120 seconds and are acknowledged exactly once (replay-protected). Devices fail safe locally regardless of connectivity.</p>
  </div>;
}

// ----------------------------------------------------------------- engine ---

export function EnginePanel() {
  const thresholds = useAsync(() => adminThresholds());
  const automation = useAsync(() => adminAutomation());
  const features = useAsync(() => adminFeatures());
  const events = useAsync(() => adminFloodEvents(15));
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [config, setConfig] = useState<Record<string, number> | null>(null);
  const [policy, setPolicy] = useState<Record<string, boolean> | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);

  useEffect(() => { if (thresholds.data) setConfig(thresholds.data.config); }, [thresholds.data]);
  useEffect(() => { if (automation.data) setPolicy(automation.data.policy); }, [automation.data]);
  useEffect(() => { if (features.data) setFlags(features.data.flags); }, [features.data]);

  const save = async (fn: () => Promise<unknown>, label: string) => {
    setActionError(''); setNotice('');
    try { await fn(); setNotice(`${label} saved.`); }
    catch (exception) { setActionError(exception instanceof Error ? exception.message : `${label} save failed.`); }
  };

  return <div className="console-panel">
    <div className="console-panel-head"><div><h2>Flood engine & automation</h2><p>Thresholds, hysteresis, rate-of-rise, cooldowns, multi-sensor confirmation and barrier policy.</p></div></div>
    {actionError && <PanelError message={actionError} />}
    {notice && <p className="admin-feedback" role="status"><Check size={14} /> {notice}</p>}
    {config && (
      <div className="console-grid">
        <fieldset className="console-fieldset">
          <legend>Engine thresholds</legend>
          {Object.entries(config).map(([key, value]) => (
            <label key={key}>{key}
              <input type="number" step="0.1" value={value}
                onChange={(event) => setConfig({ ...config, [key]: Number(event.target.value) })} />
            </label>
          ))}
          <button className="admin-primary-button" onClick={() => void save(() => adminSaveThresholds(config), 'Thresholds')}>Save thresholds</button>
        </fieldset>
        {policy && <fieldset className="console-fieldset">
          <legend>Automation & notification policy</legend>
          {Object.entries(policy).map(([key, value]) => (
            <label key={key} className="pref-toggle">
              <input type="checkbox" checked={value} onChange={(event) => setPolicy({ ...policy, [key]: event.target.checked })} /> {key}
            </label>
          ))}
          <button className="admin-primary-button" onClick={() => void save(() => adminSaveAutomation(policy), 'Automation policy')}>Save policy</button>
        </fieldset>}
        {flags && <fieldset className="console-fieldset">
          <legend>Feature flags</legend>
          {Object.entries(flags).map(([key, value]) => (
            <label key={key} className="pref-toggle">
              <input type="checkbox" checked={value} onChange={(event) => setFlags({ ...flags, [key]: event.target.checked })} /> {key}
            </label>
          ))}
          <button className="admin-primary-button" onClick={() => void save(() => adminSaveFeatures(flags), 'Feature flags')}>Save flags</button>
        </fieldset>}
      </div>
    )}
    {(thresholds.error || automation.error || features.error) && <PanelError message={thresholds.error || automation.error || features.error || ''} />}
    <h3 className="console-subhead"><Layers3 size={14} /> Recent flood-engine events</h3>
    <ul className="console-list">
      {(events.data?.events ?? []).map((event) => (
        <li key={String(event.id)}>
          <strong>{String(event.state)}</strong> · {String(event.reason)}
          <small>{new Date(String(event.createdAt)).toLocaleString()} · {event.duplicateSuppressed ? 'duplicate suppressed' : 'notified'}{event.simulation ? ' · SIMULATION' : ''}</small>
        </li>
      ))}
      {events.data?.events?.length === 0 && <li className="empty-note">No flood events recorded yet.</li>}
    </ul>
  </div>;
}

// ----------------------------------------------------------------- content ---

const BLOCK_TYPES = ['hero', 'text', 'image', 'card', 'status', 'alert', 'button', 'chart'] as const;

function blockDefaults(type: string): ContentBlock {
  switch (type) {
    case 'hero': return { type, eyebrow: 'SMART FLOOD CONTROL', title: 'New hero heading', body: 'Supporting text.', button: { label: 'Open dashboard', href: '/app' } };
    case 'text': return { type, title: 'Section heading', body: 'Body text.' };
    case 'image': return { type, src: '/floodguard-mark.svg', alt: 'Illustration', caption: '' };
    case 'card': return { type, title: 'Card title', body: 'Card body.' };
    case 'status': return { type, title: 'Live status' };
    case 'alert': return { type, level: 'INFO', title: 'Notice title', body: 'Notice body.' };
    case 'button': return { type, label: 'Learn more', href: '/about', style: 'primary' };
    case 'chart': return { type, title: 'Water level (live telemetry)' };
    default: return { type: 'text', body: '' };
  }
}

export function ContentPanel() {
  const [slug, setSlug] = useState('home');
  const [title, setTitle] = useState('Home page');
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [revisions, setRevisions] = useState<ContentRevisionView[]>([]);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState(false);
  const dragIndex = useRef<number | null>(null);

  const load = useCallback(async () => {
    setActionError('');
    try {
      const result = await adminContent(slug);
      setRevisions(result.revisions);
      const published = result.revisions.find((revision) => revision.status === 'PUBLISHED');
      if (published) { setBlocks(published.content.blocks); setTitle(published.title); }
    } catch (exception) { setActionError(exception instanceof Error ? exception.message : 'Could not load revisions.'); }
  }, [slug]);
  useEffect(() => { void load(); }, [load]);

  const move = (index: number, delta: number) => {
    const next = [...blocks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setBlocks(next);
  };
  const updateBlock = (index: number, patch: Record<string, unknown>) => {
    const next = [...blocks];
    next[index] = { ...next[index]!, ...patch };
    setBlocks(next);
  };

  const saveDraft = async () => {
    setActionError(''); setNotice('');
    try {
      const result = await adminSaveDraft(slug, title, blocks);
      setNotice(`Draft revision ${result.revision.id.slice(0, 8)} saved.`);
      await load();
    } catch (exception) { setActionError(exception instanceof Error ? exception.message : 'Draft save failed.'); }
  };

  return <div className="console-panel">
    <div className="console-panel-head"><div><h2>Site tools — schema-driven editor</h2><p>Compose pages from allowlisted blocks only. No arbitrary HTML, CSS or JavaScript can be injected. Every save is a version; publishing archives the previous release and rollback re-publishes an earlier revision.</p></div></div>
    {actionError && <PanelError message={actionError} />}
    {notice && <p className="admin-feedback" role="status"><Check size={14} /> {notice}</p>}
    <div className="content-toolbar">
      <label>Page slug<input value={slug} onChange={(event) => setSlug(event.target.value.replace(/[^a-z0-9-]/g, '-'))} /></label>
      <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <button className="admin-secondary-button" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
      <button className="admin-primary-button" onClick={() => void saveDraft()}>Save draft</button>
      <a className="admin-secondary-button" href={`/page/${slug || 'home'}`} target="_blank" rel="noopener noreferrer">View public page</a>
    </div>
    {!preview && (
      <div className="content-blocks">
        {blocks.map((block, index) => (
          <div key={index} className="content-block-card"
            draggable
            onDragStart={() => { dragIndex.current = index; }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragIndex.current === null || dragIndex.current === index) return;
              const next = [...blocks];
              const [moved] = next.splice(dragIndex.current, 1);
              next.splice(index, 0, moved!);
              setBlocks(next);
              dragIndex.current = null;
            }}>
            <div className="content-block-head">
              <strong>{block.type}</strong>
              <span>
                <button onClick={() => move(index, -1)} aria-label="Move up"><ArrowUp size={13} /></button>
                <button onClick={() => move(index, 1)} aria-label="Move down"><ArrowDown size={13} /></button>
                <button onClick={() => setBlocks(blocks.filter((_, i) => i !== index))} aria-label="Remove"><Trash2 size={13} /></button>
              </span>
            </div>
            {Object.entries(block).filter(([key]) => key !== 'type').map(([key, value]) => (
              <label key={key}>{key}
                {typeof value === 'boolean'
                  ? <input type="checkbox" checked={value} onChange={(event) => updateBlock(index, { [key]: event.target.checked })} />
                  : typeof value === 'object' && value !== null
                    ? <input value={JSON.stringify(value)} onChange={(event) => {
                      try { updateBlock(index, { [key]: JSON.parse(event.target.value) }); } catch { /* keep typing */ }
                    }} />
                    : <input value={String(value)} onChange={(event) => updateBlock(index, { [key]: event.target.value })} />}
              </label>
            ))}
          </div>
        ))}
        <div className="content-add-row">
          {BLOCK_TYPES.map((type) => (
            <button key={type} onClick={() => setBlocks([...blocks, blockDefaults(type)])}><Plus size={12} /> {type}</button>
          ))}
        </div>
      </div>
    )}
    {preview && (
      <div className="content-preview">
        <p className="gauge-footnote">Rendering exactly what the public page shows, with live data for status and chart blocks.</p>
        <ContentBlocks blocks={blocks as ContentBlockData[]} />
      </div>
    )}
    <h3 className="console-subhead"><Layers3 size={14} /> Revisions</h3>
    <ul className="console-list">
      {revisions.map((revision) => (
        <li key={revision.id}>
          <strong>{revision.title}</strong> · {revision.status} · {new Date(revision.createdAt).toLocaleString()}
          <span className="revision-actions">
            <button onClick={() => void adminPublish(slug, revision.id).then(() => { setNotice('Revision published.'); void load(); }).catch((error) => setActionError(String(error)))}>Publish</button>
            <button onClick={() => void adminRollback(slug, revision.id).then(() => { setNotice('Rolled back to this revision (published as a new version).'); void load(); }).catch((error) => setActionError(String(error)))}>Roll back</button>
          </span>
        </li>
      ))}
      {revisions.length === 0 && <li className="empty-note">No revisions yet — save a draft to start versioning.</li>}
    </ul>
  </div>;
}

// ------------------------------------------------------------ service areas ---

export function ServiceAreasPanel() {
  const { data, error, reload } = useAsync(() => adminServiceAreas());
  const [countryCode, setCountryCode] = useState('');
  const [countryName, setCountryName] = useState('');
  const [cityName, setCityName] = useState('');
  const [actionError, setActionError] = useState('');
  const areas = (data?.serviceAreas ?? []) as ServiceArea[];

  return <div className="console-panel">
    <div className="console-panel-head"><div><h2>Service areas</h2><p>Public registration is limited to these cities/countries. IP geolocation is advisory only and never a security boundary.</p></div></div>
    {error && <PanelError message={error} />}
    {actionError && <PanelError message={actionError} />}
    <div className="content-toolbar">
      <label>Country code<input maxLength={2} value={countryCode} onChange={(event) => setCountryCode(event.target.value.toUpperCase())} placeholder="BD" /></label>
      <label>Country name<input value={countryName} onChange={(event) => setCountryName(event.target.value)} placeholder="Bangladesh" /></label>
      <label>City<input value={cityName} onChange={(event) => setCityName(event.target.value)} placeholder="Dhaka" /></label>
      <button className="admin-primary-button" onClick={() => {
        setActionError('');
        adminAddServiceArea({ countryCode, countryName, cityName }).then(() => { setCountryCode(''); setCountryName(''); setCityName(''); void reload(); }).catch((error) => setActionError(String(error)));
      }}><Plus size={13} /> Add</button>
    </div>
    <ul className="console-list">
      {areas.map((area) => (
        <li key={area.id}>
          <strong>{area.cityName}</strong>, {area.countryName} ({area.countryCode})
          <span className="revision-actions">
            <button onClick={() => void adminToggleServiceArea(area.id, !area.enabled).then(() => reload())}>{area.enabled ? 'Disable' : 'Enable'}</button>
          </span>
        </li>
      ))}
    </ul>
  </div>;
}

// --------------------------------------------------- maintenance & emergency ---

export function MaintenancePanel() {
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const run = async (fn: () => Promise<unknown>, label: string) => {
    setActionError(''); setNotice('');
    try { await fn(); setNotice(`${label} saved.`); } catch (exception) { setActionError(exception instanceof Error ? exception.message : `${label} failed.`); }
  };
  return <div className="console-panel">
    <div className="console-panel-head"><div><h2>Maintenance & emergency status</h2><p>Maintenance mode marks the site read-only. Emergency status is shown on the public status page. Both are audit-logged.</p></div></div>
    {actionError && <PanelError message={actionError} />}
    {notice && <p className="admin-feedback" role="status"><Check size={14} /> {notice}</p>}
    <fieldset className="console-fieldset">
      <legend>Maintenance mode</legend>
      <label>Note<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></label>
      <div className="content-toolbar">
        <button className="admin-primary-button" onClick={() => void run(() => adminMaintenance(true, note), 'Maintenance on')}>Enable maintenance</button>
        <button className="admin-secondary-button" onClick={() => void run(() => adminMaintenance(false, note), 'Maintenance off')}>Disable maintenance</button>
      </div>
    </fieldset>
    <fieldset className="console-fieldset">
      <legend>Emergency site status</legend>
      <label>Public message<input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500} /></label>
      <div className="content-toolbar">
        <button className="admin-primary-button" onClick={() => void run(() => adminEmergency(true, message), 'Emergency status')}><AlertTriangle size={13} /> Declare emergency</button>
        <button className="admin-secondary-button" onClick={() => void run(() => adminEmergency(false, message), 'All-clear')}>All clear</button>
      </div>
    </fieldset>
  </div>;
}

// ---------------------------------------------------------------------- ops ---

export function OpsPanel({ csrf }: { csrf: string }) {
  void csrf;
  const status = useAsync(() => opsStatus());
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [deployment, setDeployment] = useState<Record<string, unknown> | null>(null);
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([]);

  const loadOpsData = useCallback(async () => {
    try {
      setDeployment(await opsDeployment());
      setAudit((await opsAudit(60)).audit);
    } catch { /* locked — expected until unlocked */ }
  }, []);
  useEffect(() => { void loadOpsData(); }, [loadOpsData]);

  const unlock = async () => {
    setActionError(''); setNotice('');
    try {
      const result = await opsUnlock(code.trim().toUpperCase());
      setNotice(`Operations console unlocked until ${new Date(result.expiresAt).toLocaleTimeString()}.`);
      setCode('');
      await loadOpsData();
      await status.reload();
    } catch (exception) {
      setActionError(exception instanceof Error ? exception.message : 'Unlock failed.');
    }
  };

  return <div className="console-panel">
    <div className="console-panel-head"><div><h2><LockKeyhole size={16} /> Operations console</h2>
      <p>Protected by a rotating operations credential delivered hourly to the security mailbox ({status.data?.securityMailboxConfigured ? 'configured' : 'OPS_SECURITY_EMAIL not set'}). The code is stored hashed only, expires automatically and is never exposed in URLs, logs or the frontend.</p></div></div>
    {actionError && <PanelError message={actionError} />}
    {notice && <p className="admin-feedback" role="status"><Check size={14} /> {notice}</p>}
    <div className="ops-unlock-row">
      <label>Operations code
        <input value={code} maxLength={12} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="12-char code from security email" autoComplete="off" />
      </label>
      <button className="admin-primary-button" onClick={() => void unlock()} disabled={code.length !== 12}>Unlock</button>
      {status.data?.sessionActive && <button className="admin-secondary-button" onClick={() => void opsLock().then(() => status.reload())}>Lock now</button>}
    </div>
    {deployment && (
      <div className="console-grid">
        <fieldset className="console-fieldset">
          <legend>Deployment info</legend>
          <dl className="ops-dl">
            <dt>Version</dt><dd>{String(deployment.version)}</dd>
            <dt>Node</dt><dd>{String(deployment.node)}</dd>
            <dt>Mode</dt><dd>{String(deployment.mode)}</dd>
            <dt>Uptime</dt><dd>{String(deployment.uptimeSeconds)} s</dd>
            <dt>Rollback</dt><dd>{String(deployment.rollbackNote)}</dd>
          </dl>
        </fieldset>
        <fieldset className="console-fieldset">
          <legend>Applied migrations</legend>
          <ul className="console-list">
            {((deployment.migrations as Array<{ version: string; appliedAt: string }>) ?? []).map((migration) => (
              <li key={migration.version}><strong>{migration.version}</strong><small>{migration.appliedAt}</small></li>
            ))}
          </ul>
        </fieldset>
      </div>
    )}
    {!deployment && <p className="gauge-footnote"><Cpu size={12} /> Unlock with the current operations code to view deployment info, feature flags and the full audit trail.</p>}
    {audit.length > 0 && <>
      <h3 className="console-subhead"><ShieldAlert size={14} /> Audit trail</h3>
      <ul className="console-list console-list-compact">
        {audit.map((entry) => (
          <li key={String(entry.id)}>
            <strong>{String(entry.action)}</strong> · {String(entry.targetType)} {entry.targetId ? `· ${String(entry.targetId).slice(0, 8)}` : ''}
            <small>{String(entry.createdAt)} · {String(entry.ipAddress || '—')}</small>
          </li>
        ))}
      </ul>
    </>}
  </div>;
}
