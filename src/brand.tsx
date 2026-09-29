import { Link } from 'react-router-dom';

export function FloodGuardMark({ small = false }: { small?: boolean }) {
  return <svg className={`brand-mark ${small ? 'brand-mark-small' : ''}`} viewBox="0 0 48 48" role="img" aria-label="FloodGuard mark">
    <rect x="1" y="1" width="46" height="46" rx="15" fill="#112D27" />
    <path d="M7 31c5 0 5-7 10-7s5 7 10 7 5-7 10-7" fill="none" stroke="#9FE66C" strokeWidth="3.2" strokeLinecap="round" />
    <path d="M11 38c4 0 4-3.5 8-3.5s4 3.5 8 3.5 4-3.5 8-3.5" fill="none" stroke="#D6F5A6" strokeWidth="2.2" strokeLinecap="round" />
    <path d="M11 16h12" stroke="#AAC3B1" strokeWidth="2.7" strokeLinecap="round" />
    <circle cx="34" cy="15" r="5" fill="#F2A36D" /><circle cx="34" cy="15" r="1.8" fill="#FFF1C7" />
    <path d="M34 6v-2m8 11h2M28 9l-1.5-1.5" stroke="#F6D18D" strokeWidth="1.2" strokeLinecap="round" />
  </svg>;
}

export function Logo() {
  return <Link to="/" className="brand-lockup" aria-label="FloodGuard home">
    <FloodGuardMark />
    <span className="brand-name">Flood<span>Guard</span><small>SMART FLOOD CONTROL</small></span>
  </Link>;
}
