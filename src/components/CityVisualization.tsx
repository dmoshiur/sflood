import type { BarrierState, FloodState } from '../../shared/flood-state';

/**
 * Interactive elevated-city visualization: a raised miniature city island,
 * surrounding water whose surface follows the reported level, sensor markers
 * and a perimeter barrier whose open/closed state matches the actuator status.
 * Purely illustrative — values come from real telemetry props, never invented.
 */
export default function CityVisualization({
  levelCm,
  state,
  barrier,
  sensors = [],
  simulation = false,
}: {
  levelCm: number | null;
  state: FloodState;
  barrier: BarrierState;
  sensors?: Array<{ id: string; label: string; levelCm: number | null; online: boolean }>;
  simulation?: boolean;
}) {
  const level = Math.max(0, Math.min(60, levelCm ?? 0));
  const waterY = 150 - (level / 60) * 60; // water surface between y=90 and y=150
  const barrierUp = barrier === 'RAISED' || barrier === 'RAISING';
  const stateColor = {
    NORMAL: '#2f9e6b', RECOVERY: '#2f9e6b', WATCH: '#c98a12',
    WARNING: '#d9641f', CRITICAL: '#c0362c', UNKNOWN: '#6b7280', FAULT: '#6b7280',
  }[state];
  return (
    <figure className={`city-viz ${simulation ? 'city-viz-simulation' : ''}`} role="img"
      aria-label={`Model city diagram. Water level ${levelCm === null ? 'unknown' : `${level.toFixed(1)} centimeters`}. Flood state ${state}. Barrier ${barrier}.`}>
      <svg viewBox="0 0 520 260" className="city-viz-svg">
        <defs>
          <linearGradient id="vizWater" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4aa3c7" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#1f6f96" stopOpacity="0.95" />
          </linearGradient>
          <linearGradient id="vizIsland" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d9c9a3" />
            <stop offset="100%" stopColor="#a98f63" />
          </linearGradient>
        </defs>
        {/* sky */}
        <rect x="0" y="0" width="520" height="260" rx="14" fill="#eef3f4" />
        {/* tray walls */}
        <rect x="14" y="40" width="492" height="196" rx="10" fill="#cfd8dc" />
        <rect x="22" y="48" width="476" height="180" rx="8" fill="#e2ebee" />
        {/* water body */}
        <rect x="22" y={waterY} width="476" height={228 - waterY} rx="6" fill="url(#vizWater)" />
        <path d={`M22 ${waterY} q 30 -6 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 56 0`} fill="none" stroke="#bfe3ef" strokeWidth="2.5" opacity="0.8" />
        {/* elevated island */}
        <path d="M170 228 L150 228 L175 120 L345 120 L370 228 L350 228 L330 150 L190 150 Z" fill="url(#vizIsland)" />
        <rect x="190" y="128" width="140" height="26" rx="3" fill="#c7b287" />
        {/* city buildings */}
        <rect x="210" y="86" width="26" height="44" rx="2" fill="#5d6d7e" />
        <rect x="244" y="70" width="30" height="60" rx="2" fill="#455a64" />
        <rect x="282" y="92" width="24" height="38" rx="2" fill="#607d8b" />
        <rect x="252" y="80" width="6" height="6" fill="#ffe082" />
        <rect x="262" y="80" width="6" height="6" fill="#ffe082" />
        <rect x="252" y="92" width="6" height="6" fill="#ffe082" />
        {/* trees */}
        <circle cx="200" cy="120" r="8" fill="#3f7d4e" />
        <circle cx="316" cy="122" r="7" fill="#3f7d4e" />
        {/* perimeter barrier posts + wall */}
        <rect x="150" y={barrierUp ? 132 : 150} width="10" height={barrierUp ? 40 : 22} rx="2" fill="#8d6e63" />
        <rect x="360" y={barrierUp ? 132 : 150} width="10" height={barrierUp ? 40 : 22} rx="2" fill="#8d6e63" />
        <g transform={`translate(0 ${barrierUp ? -22 : 0})`}>
          <rect x="150" y="168" width="220" height="10" rx="3" fill={barrierUp ? '#b71c1c' : '#795548'} opacity={barrierUp ? 0.9 : 0.85} />
          <rect x="150" y="168" width="220" height="3" rx="1.5" fill="#ffffff" opacity="0.25" />
        </g>
        {/* sensor markers */}
        <g>
          <circle cx="110" cy={waterY - 8} r="9" fill="#0f4c5c" />
          <text x="110" y={waterY - 4.5} textAnchor="middle" fontSize="9" fill="#e8f6fa">S1</text>
          <line x1="110" y1={waterY - 17} x2="110" y2="70" stroke="#0f4c5c" strokeWidth="2" strokeDasharray="4 3" />
          <rect x="92" y="54" width="36" height="16" rx="4" fill="#0f4c5c" />
          <text x="110" y="65" textAnchor="middle" fontSize="8" fill="#e8f6fa">ULTRA</text>
        </g>
        <g>
          <circle cx="420" cy={waterY - 8} r="9" fill="#0f4c5c" />
          <text x="420" y={waterY - 4.5} textAnchor="middle" fontSize="9" fill="#e8f6fa">S2</text>
          <line x1="420" y1={waterY - 17} x2="420" y2="70" stroke="#0f4c5c" strokeWidth="2" strokeDasharray="4 3" />
          <rect x="402" y="54" width="36" height="16" rx="4" fill="#0f4c5c" />
          <text x="420" y="65" textAnchor="middle" fontSize="8" fill="#e8f6fa">RAIN</text>
        </g>
        {/* state flag */}
        <g transform="translate(392 150)">
          <rect x="0" y="0" width="112" height="34" rx="8" fill="#ffffff" stroke={stateColor} strokeWidth="2" />
          <circle cx="16" cy="17" r="7" fill={stateColor} />
          <text x="30" y="14" fontSize="11" fill="#263238" fontWeight="700">{state}</text>
          <text x="30" y="27" fontSize="9" fill="#546e7a">{barrierUp ? 'BARRIER RAISED' : barrier === 'FAULT' ? 'BARRIER FAULT' : 'BARRIER DOWN'}</text>
        </g>
        {/* water level readout */}
        <g transform="translate(32 150)">
          <rect x="0" y="0" width="96" height="34" rx="8" fill="#ffffff" opacity="0.92" />
          <text x="10" y="14" fontSize="10" fill="#546e7a">WATER LEVEL</text>
          <text x="10" y="28" fontSize="13" fill="#0f4c5c" fontWeight="700">{levelCm === null ? '—' : `${levelCm.toFixed(1)} cm`}</text>
        </g>
      </svg>
      <figcaption>
        {simulation
          ? 'SIMULATION diagram — the water level shown is labeled simulator data, not a live sensor reading.'
          : 'Diagram driven by the latest stored telemetry. The physical tray model is a teaching prototype, not a real flood barrier.'}
        {sensors.length > 0 && (
          <span className="city-viz-sensors">
            {sensors.map((sensor) => (
              <span key={sensor.id} className={`city-viz-sensor ${sensor.online ? 'is-online' : ''}`}>
                <i /> {sensor.label}: {sensor.levelCm === null ? '—' : `${sensor.levelCm.toFixed(1)} cm`}
              </span>
            ))}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
