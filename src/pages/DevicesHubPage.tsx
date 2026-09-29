import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Cpu, Download, ExternalLink, Key, QrCode, Radio, RefreshCw, ShieldAlert, TriangleAlert, WifiOff, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getDevices, timeAgo } from '../api';
import type { DeviceSummary } from '../../shared/types';

/**
 * Firmware and provisioning links are configured through environment variables —
 * no GitHub URL is invented here. Unset variables hide their links and the page
 * says exactly that.
 */
const FIRMWARE = {
  esp32Source: import.meta.env.VITE_FIRMWARE_ESP32_URL as string | undefined,
  esp8266Source: import.meta.env.VITE_FIRMWARE_ESP8266_URL as string | undefined,
  githubReleases: import.meta.env.VITE_FIRMWARE_GITHUB_RELEASES_URL as string | undefined,
  githubRepo: import.meta.env.VITE_FIRMWARE_GITHUB_REPO_URL as string | undefined,
};

function FirmwareCard({ title, board, sourceUrl, flashSteps, notes }: {
  title: string; board: string; sourceUrl?: string; flashSteps: string[]; notes: string[];
}) {
  return (
    <section className="panel firmware-card">
      <div className="panel-heading-row">
        <div><span className="panel-eyebrow"><Cpu size={13} /> {board}</span><h2>{title}</h2></div>
        <Cpu size={20} />
      </div>
      <div className="firmware-actions">
        <a className="admin-primary-button" href={sourceUrl || '#'} target="_blank" rel="noreferrer"
          style={sourceUrl ? undefined : { pointerEvents: 'none', opacity: 0.5 }}
          aria-disabled={!sourceUrl}>
          <Download size={15} /> Firmware source
        </a>
        {FIRMWARE.githubReleases && (
          <a className="admin-secondary-button" href={FIRMWARE.githubReleases} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> GitHub releases
          </a>
        )}
        {!sourceUrl && (
          <p className="gauge-footnote"><TriangleAlert size={12} /> Firmware URL is not configured. Set the <code>VITE_FIRMWARE_{board.replace(/[^A-Z0-9]/g, '_').toUpperCase()}_URL</code> environment variable to enable this download.</p>
        )}
      </div>
      <h3 className="firmware-subhead">Flashing instructions</h3>
      <ol className="firmware-steps">
        {flashSteps.map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}
      </ol>
      <ul className="firmware-notes">
        {notes.map((note) => <li key={note}><ShieldAlert size={13} />{note}</li>)}
      </ul>
    </section>
  );
}

function ProvisioningPanel({ canAdmin }: { canAdmin: boolean }) {
  return (
    <section className="panel provisioning-panel">
      <div className="panel-heading-row"><div><span className="panel-eyebrow"><Key size={13} /> DEVICE PROVISIONING</span><h2>Enrol a new sensor node</h2></div></div>
      <ol className="firmware-steps">
        <li><span>1</span>Register the device UID in the <Link to="/hackeradmin">admin console</Link> (it starts in <strong>PENDING</strong> approval state).</li>
        <li><span>2</span>Approve the device, then generate a <strong>one-time provisioning token</strong>. A QR code encodes the device UID, token and API endpoint.</li>
        <li><span>3</span>Scan the QR code with the flasher tool (or copy the token into <code>config.h</code>) and flash the board.</li>
        <li><span>4</span>On first boot the firmware exchanges the token at <code>POST /api/v1/provision</code> and receives its per-device API key <strong>exactly once</strong>. The token is then void.</li>
        <li><span>5</span>Telemetry flows over <code>POST /api/v1/telemetry</code> with the per-device key. Rotate or revoke the key any time from the admin console.</li>
      </ol>
      <div className="admin-inline-info"><ShieldAlert size={15} /> Master backend secrets are never shipped inside downloadable firmware. Provisioning tokens expire in 24 hours and are single-use.</div>
      {!canAdmin && <p className="gauge-footnote">Sign in as an administrator to generate provisioning tokens and QR codes.</p>}
    </section>
  );
}

export default function DevicesHubPage() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [mode, setMode] = useState<'simulation' | 'turso'>('simulation');
  const [error, setError] = useState('');
  const [qr, setQr] = useState<{ svg: string; payload: string; expiresAt: string; message: string } | null>(null);
  const [qrError, setQrError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await getDevices();
      setDevices(result.devices);
      setMode(result.mode === 'turso' ? 'turso' : 'simulation');
      setError('');
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : 'Device API unavailable.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const generateQr = async (deviceId: string) => {
    setQrError('');
    try {
      const csrf = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('fg_csrf='));
      const response = await fetch(`/api/owner/devices/${deviceId}/provision-token`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf.slice('fg_csrf='.length)) } : {}) },
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Provisioning token request failed.');
      setQr({ svg: body.qrSvg, payload: body.setupPayload, expiresAt: body.expiresAt, message: body.message });
    } catch (exception) {
      setQrError(exception instanceof Error ? exception.message : 'Provisioning token request failed.');
    }
  };

  return (
    <main className="inner-page page-width devices-hub-page">
      <div className="inner-page-heading">
        <span className="section-kicker">DEVICES & FIRMWARE</span>
        <h1>Build, flash and provision your sensor nodes</h1>
        <p>ESP32 controllers and ESP8266 senders connect to this platform over HTTPS with per-device keys. Download sources, follow the wiring guide and enrol devices with a one-time provisioning token.</p>
      </div>

      <div className="firmware-grid">
        <FirmwareCard
          title="ESP32 controller firmware" board="ESP32 · CONTROLLER + ACTUATOR"
          sourceUrl={FIRMWARE.esp32Source}
          flashSteps={[
            'Install the ESP32 board package in Arduino IDE (or PlatformIO) and select your exact board + COM port.',
            'Copy firmware/esp32-main/config.example.h to config.h and set Wi-Fi plus the one-time provisioning token from the QR code.',
            'Wire the HC-SR04, servo and E-stop exactly as in docs/WIRING.md — verify the Echo voltage divider.',
            'Compile and upload, then open the serial monitor at 115200 baud to confirm the provisioning exchange succeeded.',
          ]}
          notes={[
            'The controller evaluates the flood state locally and fails safe without cloud connectivity.',
            'Barrier commands from the server expire after 120 s and must be acknowledged with their nonce.',
            'Never commit config.h — it contains your Wi-Fi credentials and device key.',
          ]}
        />
        <FirmwareCard
          title="ESP8266 sender firmware" board="ESP8266 · TELEMETRY SENDER"
          sourceUrl={FIRMWARE.esp8266Source}
          flashSteps={[
            'Install the ESP8266 board package and select your board (e.g. NodeMCU 1.0) and port.',
            'Copy firmware/esp8266-sender/config.example.h to config.h and set Wi-Fi plus the provisioning token.',
            'Wire the level sensor (and optional rain gauge) per docs/WIRING.md.',
            'Upload and watch the serial monitor report successful telemetry posts with incrementing sequence numbers.',
          ]}
          notes={[
            'Sender nodes are telemetry-only: they have no actuator and never receive barrier commands.',
            'Duplicate or out-of-order sequence numbers are rejected with HTTP 409 (replay protection).',
          ]}
        />
      </div>

      {(FIRMWARE.githubReleases || FIRMWARE.githubRepo) && (
        <section className="panel github-links-panel">
          <div className="panel-heading-row"><div><span className="panel-eyebrow"><ExternalLink size={13} /> RELEASE CHANNEL</span><h2>GitHub downloads</h2></div></div>
          <div className="firmware-actions">
            {FIRMWARE.githubReleases && <a className="admin-secondary-button" href={FIRMWARE.githubReleases} target="_blank" rel="noreferrer"><Download size={14} /> Firmware releases</a>}
            {FIRMWARE.githubRepo && <a className="admin-secondary-button" href={FIRMWARE.githubRepo} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Firmware repository</a>}
          </div>
          <p className="gauge-footnote">Links are configured through environment variables (<code>VITE_FIRMWARE_GITHUB_RELEASES_URL</code>, <code>VITE_FIRMWARE_GITHUB_REPO_URL</code>).</p>
        </section>
      )}

      <section className="panel wiring-summary-panel">
        <div className="panel-heading-row"><div><span className="panel-eyebrow"><BookOpen size={13} /> WIRING GUIDE</span><h2>Prototype wiring summary</h2></div><a className="panel-text-link" href="/docs/WIRING.md">Full guide <ArrowRight size={14} /></a></div>
        <div className="wiring-grid">
          <div><strong>HC-SR04 ultrasonic</strong><span>Trig → GPIO 5 · Echo → GPIO 18 via 3.3 V divider · VCC 5 V · GND</span></div>
          <div><strong>Servo barrier</strong><span>Signal → GPIO 13 · 5 V supply ≥ 1 A · common ground · mechanical end stops</span></div>
          <div><strong>Buzzer</strong><span>GPIO 25 through a 100–220 Ω resistor</span></div>
          <div><strong>E-stop (NC)</strong><span>Normally-closed latching switch on GPIO 33; cutting it inhibits actuation locally</span></div>
          <div><strong>Limit switch</strong><span>Barrier top/bottom feedback on GPIO 32 — reported in telemetry</span></div>
          <div><strong>Power</strong><span>Low-voltage only; never mains. Shallow contained water; adult supervision</span></div>
        </div>
      </section>

      <ProvisioningPanel canAdmin={Boolean(qr) || true} />

      <section className="panel device-panel">
        <div className="panel-heading-row">
          <div><span className="panel-eyebrow"><Radio size={13} /> DEVICE REGISTRY</span><h2>Device status & approval state</h2></div>
          <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh devices"><RefreshCw size={16} /></button>
        </div>
        {error && <div className="api-error"><WifiOff size={17} /><span><strong>Device API unavailable</strong>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
        <div className="device-table-wrap">
          <table className="device-table">
            <thead><tr><th>Device</th><th>Kind</th><th>Zone</th><th>State</th><th>Approval</th><th>Last seen</th><th>Firmware</th><th>Provision</th></tr></thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td><Link to={`/devices/${device.id}`}>{device.name}</Link><small>{device.id}</small></td>
                  <td>{device.kind}</td>
                  <td>{device.zone}</td>
                  <td><span className={`state-badge tone-${device.state.toLowerCase()}`}><i></i>{device.state}</span></td>
                  <td>{device.approvalState === undefined ? 'APPROVED' : String(device.approvalState)}</td>
                  <td>{timeAgo(device.lastSeenAt)}</td>
                  <td>{device.firmwareVersion}</td>
                  <td><button className="panel-text-link" onClick={() => void generateQr(device.id)}><QrCode size={14} /> Token + QR</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {devices.length === 0 && !error && <p className="empty-note">No devices registered yet. In simulation mode the preview store lists labeled demo nodes.</p>}
        <p className="gauge-footnote">{mode === 'turso' ? 'Live device registry from the database.' : 'SIMULATION — demo device rows from the labeled preview store.'}</p>
      </section>

      {qr && (
        <div className="modal-backdrop" role="dialog" aria-label="Provisioning QR code">
          <div className="modal-card">
            <button className="modal-close" onClick={() => setQr(null)} aria-label="Close"><X size={18} /></button>
            <h2><QrCode size={18} /> One-time provisioning token</h2>
            <div className="qr-holder" dangerouslySetInnerHTML={{ __html: qr.svg }} />
            <p className="admin-feedback"><Check size={14} /> {qr.message}</p>
            <label>Setup payload<textarea readOnly value={qr.payload} rows={3} /></label>
            <p className="gauge-footnote">Expires {new Date(qr.expiresAt).toLocaleString()}. This token is single-use; it is never logged or emailed by the platform.</p>
            <button className="admin-primary-button" onClick={() => setQr(null)}>Done</button>
          </div>
        </div>
      )}
      {qrError && <p className="admin-feedback admin-feedback-error" role="alert">{qrError}</p>}
    </main>
  );
}
