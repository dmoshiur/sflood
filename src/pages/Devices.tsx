import { useEffect, useState } from 'react';
import { api, type DeviceSummary, type PublicConfig } from '../api';
import { Card, Empty, Field, HealthBadge, Notice, StateBadge, Tabs } from '../components/ui';
import { useAuth } from '../App';

/** Devices page: firmware distribution, flashing and wiring guides, provisioning flow and the registry. */

const WIRING = [
  { signal: 'HC-SR04 VCC', esp32: '5V (or 3.3 V on some modules)', esp8266: '5V via regulator', note: 'Sensor supply must be stable; add a 100 nF decoupling capacitor at the module.' },
  { signal: 'HC-SR04 GND', esp32: 'GND', esp8266: 'GND', note: 'Common ground with the controller.' },
  { signal: 'HC-SR04 TRIG', esp32: 'GPIO 5', esp8266: 'GPIO 4 (D2)', note: 'Any free digital output works.' },
  { signal: 'HC-SR04 ECHO', esp32: 'GPIO 18 through a 1k / 2k divider', esp8266: 'GPIO 5 (D1) through a divider', note: 'The ECHO pin is 5 V logic: always divide it down to 3.3 V before the ESP input.' },
  { signal: 'Servo signal', esp32: 'GPIO 13', esp8266: 'not used (sender nodes have no actuator)', note: 'Use a separate 5 V supply for the servo; never power it from the ESP regulator.' },
  { signal: 'Servo power', esp32: 'External 5 V, common ground', esp8266: 'not used', note: 'Add a 470 uF capacitor across the servo supply.' },
  { signal: 'Limit switch LOW', esp32: 'GPIO 26 with INPUT_PULLUP', esp8266: 'not used', note: 'Normally-open switch to GND; used as actuator feedback.' },
  { signal: 'Limit switch HIGH', esp32: 'GPIO 27 with INPUT_PULLUP', esp8266: 'not used', note: 'Normally-open switch to GND.' },
  { signal: 'E-stop (normally closed)', esp32: 'GPIO 25 with INPUT_PULLUP', esp8266: 'not used', note: 'Latched, normally-closed. Opening the circuit inhibits actuation locally.' },
];

const FLASH_STEPS = [
  'Install Visual Studio Code with the Espressif IDF extension, or the Arduino IDE with the ESP32/ESP8266 board packages.',
  'Copy firmware/esp32/include/config.example.h to firmware/esp32/include/config.h (git-ignored) and fill in your Wi-Fi and device values.',
  'Put the board in bootloader mode, select the correct COM port and flash.',
  'Open the serial monitor at 115200 baud. On first boot the device prints its UID and waits for a provisioning token.',
  'In the admin console, register the device, then show the QR code (or paste the token) to the device through the serial console.',
  'The device exchanges the token for its own API key, stores it in NVS and starts streaming telemetry.',
];

export default function DevicesPage({ manage = false }: { manage?: boolean }) {
  const { user } = useAuth();
  const [tab, setTab] = useState(manage ? 'registry' : 'firmware');
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [releases, setReleases] = useState<Array<Record<string, unknown>>>([]);
  const [links, setLinks] = useState<{ esp32: string | null; esp8266: string | null; releases: string | null }>({ esp32: null, esp8266: null, releases: null });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [board, setBoard] = useState<'ESP32' | 'ESP8266'>('ESP32');
  const [zoneId, setZoneId] = useState('');
  const [provisioning, setProvisioning] = useState<{ token: string; expiresAt: string; qrDataUrl: string; qrPayload: string; uid: string } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [publicConfig, firmware] = await Promise.all([api.publicConfig(), api.firmwareReleases()]);
        setConfig(publicConfig);
        setReleases(firmware.releases);
        setLinks(firmware.links);
      } catch (err) { setError((err as Error).message); }
    })();
  }, []);

  useEffect(() => {
    if (manage) void api.devices().then((result) => setDevices(result.devices)).catch((err) => setError((err as Error).message));
  }, [manage]);

  async function registerDevice(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await api.registerDevice({ name, board, zoneId: zoneId || undefined });
      setProvisioning({
        token: result.provisioning.token, expiresAt: result.provisioning.expiresAt,
        qrDataUrl: result.provisioning.qrDataUrl, qrPayload: result.provisioning.qrPayload, uid: result.device.uid,
      });
      setMessage(result.message);
      const refreshed = await api.devices();
      setDevices(refreshed.devices);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const staff = Boolean(user && ['OPERATOR', 'ADMIN', 'OWNER'].includes(user.role));

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Devices &amp; firmware</h1>
          <p>ESP32 controller and ESP8266 sender nodes: flashing instructions, wiring, provisioning and the live registry.</p>
        </div>
        {config && (
          <span className={`badge ${config.firmware.configured ? 'normal' : 'watch'}`}>
            {config.firmware.configured ? 'Firmware links configured' : 'Firmware links not configured'}
          </span>
        )}
      </div>

      {error && <Notice tone="critical">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}

      <Tabs
        tabs={[
          { id: 'firmware', label: 'Firmware' },
          { id: 'flashing', label: 'Flashing' },
          { id: 'wiring', label: 'Wiring' },
          { id: 'provisioning', label: 'Provisioning' },
          ...(manage ? [{ id: 'registry', label: 'Registry' }] : []),
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'firmware' && (
        <div className="grid cols-2">
          <Card title="ESP32 controller" subtitle="Ultrasonic sensing, barrier state machine, limit switches, E-stop fail-safe, command polling">
            <p className="muted">Source and release binaries are distributed from the configured GitHub repository.</p>
            <div className="row">
              {links.esp32
                ? <a className="btn" href={links.esp32} target="_blank" rel="noreferrer noopener">Download ESP32 firmware</a>
                : <span className="badge watch">Not configured</span>}
              {links.releases && <a className="btn secondary" href={links.releases} target="_blank" rel="noreferrer noopener">All releases</a>}
            </div>
          </Card>
          <Card title="ESP8266 sender" subtitle="Telemetry and heartbeat only, no actuator control on this board">
            <p className="muted">Sender nodes report level, signal and uptime. They can never command the barrier.</p>
            <div className="row">
              {links.esp8266
                ? <a className="btn" href={links.esp8266} target="_blank" rel="noreferrer noopener">Download ESP8266 firmware</a>
                : <span className="badge watch">Not configured</span>}
            </div>
          </Card>
          <Card title="Release metadata">
            {releases.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Version</th><th>Board</th><th>Channel</th><th>Notes</th><th>Link</th></tr></thead>
                  <tbody>
                    {releases.map((release) => (
                      <tr key={String(release.id)}>
                        <td className="mono">{String(release.version)}</td>
                        <td>{String(release.board)}</td>
                        <td>{String(release.channel)}</td>
                        <td className="muted">{String(release.notes || '')}</td>
                        <td>{release.downloadUrl ? <a href={String(release.downloadUrl)} target="_blank" rel="noreferrer noopener">Open</a> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty>No releases are published yet.</Empty>}
            <p className="subtle" style={{ marginTop: '0.6rem', fontSize: '0.82rem' }}>
              Firmware links come from FIRMWARE_GITHUB_ESP32_URL, FIRMWARE_GITHUB_ESP8266_URL and FIRMWARE_GITHUB_RELEASES_URL. No backend secret is ever shipped inside firmware.
            </p>
          </Card>
        </div>
      )}

      {tab === 'flashing' && (
        <Card title="Board-specific flashing instructions">
          <ol>
            {FLASH_STEPS.map((step) => <li key={step} style={{ marginBottom: '0.4rem' }}>{step}</li>)}
          </ol>
          <details>
            <summary>Arduino IDE quick reference</summary>
            <ul>
              <li>ESP32: board “ESP32 Dev Module”, flash 4 MB, partition “Default 4MB with spiffs”.</li>
              <li>ESP8266: board “NodeMCU 1.0 (ESP-12E Module)”, flash size 4 MB, CPU 80 MHz.</li>
              <li>Required libraries: ArduinoJson, and WebSockets only if you enable the optional MQTT bridge.</li>
            </ul>
          </details>
          <details>
            <summary>Serial monitor checklist</summary>
            <ul>
              <li>Boot log prints the firmware version and device UID.</li>
              <li>“provisioning required” means no API key is stored yet.</li>
              <li>“telemetry accepted” confirms the server stored the sample and returned the evaluated state.</li>
            </ul>
          </details>
        </Card>
      )}

      {tab === 'wiring' && (
        <Card title="Wiring guide" subtitle="Calibrate the HC-SR04 mounting zero before trusting any reading">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Signal</th><th>ESP32</th><th>ESP8266</th><th>Notes</th></tr></thead>
              <tbody>
                {WIRING.map((row) => (
                  <tr key={row.signal}>
                    <td className="nowrap"><strong>{row.signal}</strong></td>
                    <td>{row.esp32}</td>
                    <td>{row.esp8266}</td>
                    <td className="muted">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Notice tone="warning">Low voltage only. Guard moving parts, add mechanical end stops, keep the E-stop normally closed and supervised, and test with an empty tray first.</Notice>
        </Card>
      )}

      {tab === 'provisioning' && (
        <div className="grid cols-2">
          <Card title="Provisioning flow">
            <ol>
              <li>An administrator registers the device; the server creates a unique UID and a one-time provisioning token.</li>
              <li>The QR code or token is shown once and expires after 24 hours.</li>
              <li>The device posts the token, its UID and board to <span className="mono">/api/v1/provision</span>.</li>
              <li>The server returns a per-device API key exactly once; the device stores it in NVS.</li>
              <li>Only the SHA-256 hash of the key is stored in the database. Keys can be rotated or revoked at any time.</li>
              <li>New devices stay PENDING until an administrator approves them, unless device approval is disabled.</li>
            </ol>
          </Card>
          <Card title="Setup QR code">
            {provisioning ? (
              <div className="stack" style={{ gap: '0.6rem' }}>
                <img className="qr" src={provisioning.qrDataUrl} alt="Device provisioning QR code" />
                <dl className="kv">
                  <dt>UID</dt><dd className="mono">{provisioning.uid}</dd>
                  <dt>Token</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{provisioning.token}</dd>
                  <dt>Expires</dt><dd>{new Date(provisioning.expiresAt).toLocaleString()}</dd>
                </dl>
                <p className="subtle" style={{ fontSize: '0.82rem' }}>Payload: <span className="mono" style={{ wordBreak: 'break-all' }}>{provisioning.qrPayload}</span></p>
              </div>
            ) : (
              <p className="muted">Register a device in the registry tab to generate a one-time QR code.</p>
            )}
          </Card>
        </div>
      )}

      {tab === 'registry' && manage && (
        <>
          {staff && (
            <Card title="Register a device">
              <form onSubmit={registerDevice} className="stack" style={{ gap: '0.4rem' }}>
                <Field label="Device name"><input required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="North Bank sensor 01" /></Field>
                <Field label="Board">
                  <select value={board} onChange={(event) => setBoard(event.target.value as 'ESP32' | 'ESP8266')}>
                    <option value="ESP32">ESP32 controller (barrier control)</option>
                    <option value="ESP8266">ESP8266 sender (telemetry only)</option>
                  </select>
                </Field>
                <Field label="Monitored zone id" hint="Use a zone from the admin console. Leave empty to use your own site.">
                  <input value={zoneId} onChange={(event) => setZoneId(event.target.value)} maxLength={64} />
                </Field>
                <button className="btn" type="submit" disabled={busy}>Register device</button>
              </form>
            </Card>
          )}

          <Card title="Registry" subtitle="Approval state, health, credentials and live telemetry for every registered node">
            {devices.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Device</th><th>Board</th><th>Approval</th><th>Health</th><th>State</th><th>Barrier</th><th>Firmware</th><th>Last seen</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {devices.map((device) => (
                      <tr key={device.id}>
                        <td>
                          <div><strong>{device.name}</strong></div>
                          <div className="mono subtle">{device.uid}</div>
                          {device.simulation && <span className="badge unknown">SIMULATION</span>}
                        </td>
                        <td>{device.board}</td>
                        <td>
                          <span className={`badge ${device.approvalState === 'APPROVED' ? 'normal' : device.approvalState === 'REJECTED' ? 'critical' : 'watch'}`}>
                            {device.approvalState}
                          </span>
                        </td>
                        <td><HealthBadge health={device.health} /></td>
                        <td><StateBadge state={device.currentState} /></td>
                        <td>{device.barrierState}</td>
                        <td className="mono">{device.firmwareVersion}</td>
                        <td>{device.lastHeartbeatAt ? new Date(device.lastHeartbeatAt).toLocaleTimeString() : '—'}</td>
                        <td>
                          <div className="row">
                            {device.approvalState !== 'APPROVED' && (
                              <button type="button" className="btn small" onClick={() => void api.approveDevice(device.id).then(() => api.devices().then((result) => setDevices(result.devices)))}>Approve</button>
                            )}
                            <button type="button" className="btn secondary small" onClick={() => void api.setDeviceEnabled(device.id, !device.enabled).then(() => api.devices().then((result) => setDevices(result.devices)))}>
                              {device.enabled ? 'Disable' : 'Enable'}
                            </button>
                            <button type="button" className="btn secondary small" onClick={() => void api.rotateDeviceCredentials(device.id).then((result) => setNewKey(result.apiKey))}>Rotate key</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty>No devices are registered yet.</Empty>}
          </Card>

          {newKey && (
            <Card title="New device key">
              <Notice tone="warning">Copy this key now. It is shown only once and the previous key is already revoked.</Notice>
              <p className="mono" style={{ wordBreak: 'break-all' }}>{newKey}</p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
