import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  ArrowUpRight, Bell, BookOpen, Check, ChevronDown, ChevronRight, CircleDot, CloudRain,
  Cpu, Droplets, Gauge, History, Home as HomeIcon, Info, Layers3,
  LockKeyhole, MapPin, Menu, Radio, RefreshCw, ShieldAlert, ShieldCheck,
  Signal, TriangleAlert, Waves, WifiOff, X, Zap,
} from 'lucide-react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { getDashboard, getDevices, getHistory, formatTime, simulate, timeAgo } from './api';
import NotificationPanel from './NotificationPanel';
import { translate, type CopyKey, type Language } from './i18n';
import type { DashboardPayload, DeviceSummary, FloodEvent, TelemetryPoint } from '../shared/types';
import type { BarrierState, FloodState } from '../shared/flood-state';

interface AppContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: CopyKey) => string;
}
const AppContext = createContext<AppContextValue | null>(null);
function useAppCopy() {
  const context = useContext(AppContext);
  if (!context) throw new Error('FloodGuard context is missing.');
  return context;
}

const statusTone: Record<FloodState, string> = {
  SAFE: 'safe', WATCH: 'watch', WARNING: 'warning', CRITICAL: 'critical', UNKNOWN: 'unknown', FAULT: 'fault',
};
const stateEnglish: Record<FloodState, string> = {
  SAFE: 'Safe', WATCH: 'Watch', WARNING: 'Warning', CRITICAL: 'Critical', UNKNOWN: 'Unknown', FAULT: 'Fault',
};
const barrierEnglish: Record<BarrierState, string> = {
  DOWN: 'Down', RAISING: 'Raising', RAISED: 'Raised · latched', FAULT: 'Fault / E-stop', HOLD: 'Hold position',
};

function FloodGuardMark({ small = false }: { small?: boolean }) {
  return <svg className={`brand-mark ${small ? 'brand-mark-small' : ''}`} viewBox="0 0 48 48" role="img" aria-label="FloodGuard mark">
    <rect x="1" y="1" width="46" height="46" rx="15" fill="#112D27" />
    <path d="M7 31c5 0 5-7 10-7s5 7 10 7 5-7 10-7" fill="none" stroke="#9FE66C" strokeWidth="3.2" strokeLinecap="round" />
    <path d="M11 38c4 0 4-3.5 8-3.5s4 3.5 8 3.5 4-3.5 8-3.5" fill="none" stroke="#D6F5A6" strokeWidth="2.2" strokeLinecap="round" />
    <path d="M11 16h12" stroke="#AAC3B1" strokeWidth="2.7" strokeLinecap="round" />
    <circle cx="34" cy="15" r="5" fill="#F2A36D" /><circle cx="34" cy="15" r="1.8" fill="#FFF1C7" />
    <path d="M34 6v-2m8 11h2M28 9l-1.5-1.5" stroke="#F6D18D" strokeWidth="1.2" strokeLinecap="round" />
  </svg>;
}

function Logo() {
  return <Link to="/" className="brand-lockup" aria-label="FloodGuard home">
    <FloodGuardMark />
    <span className="brand-name">Flood<span>Guard</span><small>SMART FLOOD CONTROL</small></span>
  </Link>;
}

function Header() {
  const { language, setLanguage, t } = useAppCopy();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const links = [
    { to: '/', key: 'nav.home' as const, end: true },
    { to: '/about', key: 'nav.about' as const },
    { to: '/app', key: 'nav.dashboard' as const },
    { to: '/devices', key: 'nav.devices' as const },
    { to: '/guides', key: 'nav.guides' as const },
  ];
  return <header className="site-header">
    <div className="header-main page-width">
      <Logo />
      <button className={`mobile-menu-toggle ${menuOpen ? 'is-open' : ''}`} type="button" aria-label={menuOpen ? 'Close navigation' : t('nav.menu')} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
        {menuOpen ? <X size={20} /> : <Menu size={20} />}
      </button>
      <nav className={`main-nav ${menuOpen ? 'nav-open' : ''}`} aria-label="Main navigation">
        {links.map((link) => <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => isActive ? 'nav-link nav-link-active' : 'nav-link'}>{t(link.key)}</NavLink>)}
      </nav>
      <div className="header-actions">
        <button className="language-toggle" type="button" onClick={() => setLanguage(language === 'en' ? 'bn' : 'en')} aria-label={language === 'en' ? 'Switch to Bengali' : 'Switch to English'}>
          <span className={language === 'en' ? 'language-active' : ''}>EN</span><i></i><span className={language === 'bn' ? 'language-active' : ''}>বাং</span>
        </button>
        <Link className="header-demo-button" to="/app">{t('nav.openDemo')} <ArrowUpRight size={15} /></Link>
      </div>
    </div>
  </header>;
}

function SafetyBanner() {
  const { t } = useAppCopy();
  return <div className="safety-banner"><div className="page-width safety-inner"><ShieldAlert size={16} /><div><strong>{t('safety.title')}</strong><span>{t('safety.body')}</span></div><span className="demo-stamp">DEMO MODE</span></div></div>;
}

function StateBadge({ state, compact = false }: { state: FloodState; compact?: boolean }) {
  const { language, t } = useAppCopy();
  const label = language === 'bn' ? t(`state.${state}` as CopyKey) : stateEnglish[state];
  return <span className={`state-badge tone-${statusTone[state]} ${compact ? 'state-badge-compact' : ''}`}><i></i>{label}</span>;
}

function Footer() {
  const { t } = useAppCopy();
  return <footer className="site-footer">
    <div className="page-width footer-top">
      <div className="footer-brand"><Logo /><p>A student-built idea for clearer signals<br />and safer science-fair demos.</p></div>
      <div className="footer-column"><strong>PROJECT</strong><Link to="/about">About FloodGuard</Link><Link to="/app">Demo dashboard</Link><Link to="/guides">Build guide</Link></div>
      <div className="footer-column"><strong>RESOURCES</strong><Link to="/guides/wiring">Wiring notes</Link><Link to="/guides/safety">Safety checklist</Link><Link to="/privacy">Privacy</Link></div>
      <div className="footer-note"><span className="footer-warning"><TriangleAlert size={15} /> EDU ONLY</span><p>{t('footer.disclaimer')}</p><p className="project-author">Prepared by <strong>Md Moshiur Rahman Mohi</strong><br />Sep 27, 2026</p></div>
    </div>
    <div className="footer-bottom page-width"><span>© 2026 FloodGuard science-fair prototype</span><span>স্মার্ট সেন্সর-নির্ভর বাঁধ ও সতর্কতা ব্যবস্থা</span></div>
  </footer>;
}

function App() {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('fg-language') === 'bn' ? 'bn' : 'en');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    localStorage.setItem('fg-language', language);
    document.documentElement.lang = language === 'bn' ? 'bn' : 'en';
  }, [language]);
  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', capture);
    return () => window.removeEventListener('beforeinstallprompt', capture);
  }, []);
  const t = useCallback((key: CopyKey) => translate(language, key), [language]);
  const context = useMemo(() => ({ language, setLanguage, t }), [language, t]);
  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };
  return <AppContext.Provider value={context}>
    <Header />
    <SafetyBanner />
    {installPrompt && <div className="install-strip"><span>Install FloodGuard as a demo PWA</span><button onClick={install}>Install <ArrowDown size={14} /></button></div>}
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/app" element={<DashboardPage />} />
      <Route path="/app/history" element={<HistoryPage />} />
      <Route path="/devices" element={<DevicesPage />} />
      <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
      <Route path="/guides" element={<GuidesPage />} />
      <Route path="/guides/:slug" element={<GuideDetailPage />} />
      <Route path="/login" element={<AuthNoticePage kind="login" />} />
      <Route path="/register" element={<AuthNoticePage kind="register" />} />
      <Route path="/hackeradmin" element={<OwnerConsolePage />} />
      <Route path="/maintenance" element={<MaintenancePage />} />
      <Route path="/privacy" element={<PolicyPage kind="privacy" />} />
      <Route path="/terms" element={<PolicyPage kind="terms" />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    <Footer />
  </AppContext.Provider>;
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };

function HomePage() {
  const { t } = useAppCopy();
  const [preview, setPreview] = useState<DashboardPayload | null>(null);
  useEffect(() => { getDashboard().then(setPreview).catch(() => setPreview(null)); }, []);
  const level = preview?.system.levelCm ?? 34.2;
  const state = preview?.system.state ?? 'WATCH';
  const barrier = preview?.system.barrier ?? 'DOWN';
  return <main>
    <section className="home-hero page-width">
      <div className="hero-copy">
        <p className="eyebrow"><span className="eyebrow-mark"><Activity size={13} /></span>{t('hero.eyebrow')} <span className="eyebrow-rule"></span><span className="eyebrow-number">PROJECT 01</span></p>
        <h1>{t('hero.title')}</h1>
        <p className="hero-bangla" lang="bn">স্মার্ট সেন্সর-নির্ভর বাঁধ ও সতর্কতা ব্যবস্থা</p>
        <p className="hero-description">{t('hero.body')}</p>
        <div className="hero-chips"><span><Waves size={13} /> Ultrasonic sensing</span><span><Cpu size={13} /> ESP32 controller</span><span><Radio size={13} /> Local-first alerts</span></div>
        <div className="hero-cta-row"><Link to="/app" className="button button-lime">{t('hero.cta')} <ArrowRight size={16} /></Link><Link to="/guides" className="button button-quiet">{t('hero.secondary')} <ArrowUpRight size={16} /></Link></div>
        <div className="hero-meta"><div className="hero-avatar"><FloodGuardMark small /></div><div><strong>Built for the science fair</strong><span>Tray model · 60 × 45 cm · Md Moshiur Rahman Mohi</span></div><span className="meta-date">27 SEP<br />2026</span></div>
      </div>
      <div className="hero-visual-wrap">
        <div className="hero-visual-top"><div><span className="live-pip"></span><span>MODEL VIEW 01</span></div><span>RIVER ISLAND CITY <MapPin size={12} /></span></div>
        <TrayDiagram />
        <div className="hero-overlay-reading">
          <div className="overlay-reading-icon"><Droplets size={18} /></div>
          <div><span>WATER LEVEL <small>· SAMPLE</small></span><strong>{level.toFixed(1)} <small>cm</small></strong></div>
          <StateBadge state={state} compact />
        </div>
        <div className="hero-overlay-barrier"><div className="barrier-mini-icon"><Layers3 size={16} /></div><div><span>MODEL BARRIER</span><strong>{barrierEnglish[barrier]}</strong></div><i className={barrier === 'RAISED' ? 'barrier-light active' : 'barrier-light'}></i></div>
        <div className="hero-glow hero-glow-one"></div><div className="hero-glow hero-glow-two"></div>
      </div>
    </section>

    <div className="home-safety page-width"><div className="home-safety-icon"><Info size={16} /></div><p><strong>Science-fair prototype, not a real flood barrier.</strong> Preview values are simulated; configured device telemetry remains unverified. This app never sends actuator commands or emergency dispatch.</p><Link to="/about">Read the project limits <ArrowRight size={14} /></Link></div>

    <section className="home-metrics page-width">
      <div className="home-metric-intro"><span className="section-kicker">THE IDEA IN ONE LOOK</span><h2>One small model.<br /><span>Four clear states.</span></h2><p>A physical demonstration of how a reading can become a visible state, a model response, and a useful alert.</p></div>
      <div className="state-steps">
        <StateStep state="SAFE" range="0–19 cm" action="Barrier stays down" icon={<ShieldCheck size={17} />} />
        <StateStep state="WATCH" range="20–34 cm" action="Buzzer chirps" icon={<Bell size={17} />} />
        <StateStep state="WARNING" range="35–49 cm" action="Model barrier raises" icon={<ArrowUp size={17} />} />
        <StateStep state="CRITICAL" range="50+ cm" action="Barrier latches raised" icon={<LockKeyhole size={17} />} />
      </div>
    </section>

    <section className="home-how">
      <div className="page-width">
        <div className="section-heading-row"><div><span className="section-kicker">THE CONTROL LOOP</span><h2>Measure. Decide. Demonstrate.</h2></div><Link to="/guides" className="arrow-link">View the build notes <ArrowUpRight size={15} /></Link></div>
        <div className="how-grid">
          <article className="how-card"><span className="how-index">01</span><div className="how-icon how-icon-aqua"><Waves size={22} /></div><h3>Measure the distance</h3><p>HC-SR04 ultrasonic sensing estimates the gap to the water surface. A median filter helps smooth noisy echoes.</p><span className="how-tag">HC-SR04 · ECHO DIVIDER</span></article>
          <article className="how-card"><span className="how-index">02</span><div className="how-icon how-icon-lime"><Cpu size={22} /></div><h3>Classify the level</h3><p>The ESP32 applies calibrated local thresholds and moves through SAFE → WATCH → WARNING → CRITICAL.</p><span className="how-tag">ESP32 · LOCAL STATE MACHINE</span></article>
          <article className="how-card"><span className="how-index">03</span><div className="how-icon how-icon-peach"><Bell size={22} /></div><h3>Alert and actuate</h3><p>A buzzer makes the state audible; lightweight servo barriers demonstrate the response. E-stop and fault handling come first.</p><span className="how-tag">SERVO MODEL · BUZZER · E-STOP</span></article>
        </div>
      </div>
    </section>

    <section className="architecture-section page-width">
      <div className="architecture-copy"><span className="section-kicker">BUILT TO GROW, NOT OVERCLAIM</span><h2>Prototype now.<br /><span>Production path later.</span></h2><p>The science-fair MVP starts with a local simulation and safe tray model. The project brief’s planned cloud architecture is documented separately from connected production services.</p><Link to="/about" className="arrow-link">Explore architecture &amp; scope <ArrowRight size={15} /></Link></div>
      <div className="architecture-card">
        <div className="architecture-label"><span>PLANNED CLOUD PATH</span><span className="architecture-status"><i></i> SPECIFICATION</span></div>
        <div className="architecture-flow">
          <ArchitectureNode icon={<Cpu size={19} />} label="ESP32 / ESP8266" sub="Signed telemetry" />
          <span className="flow-connector"><ArrowRight size={15} /></span>
          <ArchitectureNode icon={<Radio size={19} />} label="Express API" sub="Auth · validation" />
          <span className="flow-connector"><ArrowRight size={15} /></span>
          <ArchitectureNode icon={<Layers3 size={19} />} label="Turso" sub="Telemetry · outbox" />
          <span className="flow-connector"><ArrowRight size={15} /></span>
          <ArchitectureNode icon={<Bell size={19} />} label="PWA / Push" sub="Zone-scoped alerts" />
        </div>
        <p className="architecture-footnote">Cloud providers, Turso credentials, firmware releases and push keys are intentionally not configured in this preview.</p>
      </div>
    </section>

    <section className="home-bottom-cta page-width"><div className="bottom-cta-art" aria-hidden="true"><span></span><span></span><span></span></div><div><span className="section-kicker">TRY THE SAFE SIMULATOR</span><h2>Watch a threshold change<br />without moving real hardware.</h2><p>Raise and lower sample water readings, test sensor-fault behavior, and inspect the state history.</p></div><Link to="/app" className="button button-light">Open dashboard <ArrowRight size={16} /></Link></section>
  </main>;
}

function TrayDiagram() {
  return <div className="tray-diagram" role="img" aria-label="Illustration of a tabletop flood model: water tray, raised city island, guided walls, and movable barrier">
    <svg viewBox="0 0 680 440" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="tray-water" x1="87" y1="67" x2="576" y2="365" gradientUnits="userSpaceOnUse"><stop stopColor="#27786E" /><stop offset=".55" stopColor="#155850" /><stop offset="1" stopColor="#174337" /></linearGradient>
        <linearGradient id="island-face" x1="255" y1="119" x2="455" y2="273" gradientUnits="userSpaceOnUse"><stop stopColor="#D7E7AD" /><stop offset="1" stopColor="#A4C67E" /></linearGradient>
        <linearGradient id="tray-front" x1="69" y1="319" x2="610" y2="389" gradientUnits="userSpaceOnUse"><stop stopColor="#1B5044" /><stop offset="1" stopColor="#12392F" /></linearGradient>
        <pattern id="tray-grid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M34 0H0V34" fill="none" stroke="#9AD7B6" strokeOpacity=".13" strokeWidth=".7" /></pattern>
        <filter id="tray-shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="13" stdDeviation="11" floodColor="#061a16" floodOpacity=".45" /></filter>
      </defs>
      <rect width="680" height="440" fill="#15352E" />
      <circle cx="565" cy="95" r="176" fill="#193F34" opacity=".54" />
      <circle cx="117" cy="349" r="137" fill="#194137" opacity=".5" />
      <g filter="url(#tray-shadow)">
        <path d="M67 123 339 54 615 127 347 201 67 123Z" fill="#2C6E5E" stroke="#76B893" strokeOpacity=".67" strokeWidth="2" />
        <path d="M67 123 347 201 347 358 67 278V123Z" fill="url(#tray-water)" stroke="#6BC39E" strokeOpacity=".6" strokeWidth="2" />
        <path d="m347 201 268-74v155l-268 76V201Z" fill="url(#tray-water)" stroke="#6BC39E" strokeOpacity=".6" strokeWidth="2" />
        <path d="M67 123 339 54l276 73-268 74L67 123Z" fill="url(#tray-water)" />
        <path d="M67 123 339 54l276 73-268 74L67 123Z" fill="url(#tray-grid)" />
        <path d="m182 129 164-43 165 45-166 47-163-49Z" fill="#8BAA70" stroke="#D8E8B6" strokeWidth="2" />
        <path d="m182 129 163 49v44l-163-49v-44Z" fill="#799C64" />
        <path d="m345 178 166-47v44l-166 47v-44Z" fill="#6E8C5A" />
        <path d="m213 136 132-35 129 35-129 37-132-37Z" fill="url(#island-face)" />
        <path d="m249 139 34-9 34 10-34 10-34-11Zm70 19 24-7 22 7-24 7-22-7Zm28-43 23-6 22 6-23 7-22-7Z" fill="#7BA96C" opacity=".65" />
        <path d="m121 185 0 44m0-44-10 10m10-10 10 10m441 16v44m0-44-10 10m10-10 10 10" fill="none" stroke="#A8D48D" strokeWidth="2" strokeLinecap="round" />
        <path d="m107 241 20 6m416-32 20-6" stroke="#80C9A4" strokeWidth="2" strokeLinecap="round" />
        <path d="m191 198 155 47 164-47" fill="none" stroke="#E0A86B" strokeWidth="5" strokeLinecap="round" strokeDasharray="6 8" />
        <path d="m248 220 11 3v80l-11-3v-80Zm207-3 11-3v80l-11 3v-80Z" fill="#D9C69A" stroke="#F3E5C5" strokeWidth="2" />
        <path d="m303 246 78-22v67l-78 23v-68Z" fill="#E0A86B" stroke="#FCE1AD" strokeWidth="2" />
        <path d="M323 252v31m38-42v31" stroke="#FFF1CE" strokeWidth="2" strokeDasharray="3 5" />
        <path d="m299 231 82-23v-14" fill="none" stroke="#F1CB8F" strokeWidth="1.5" strokeDasharray="4 4" />
      </g>
      <g className="tray-annotations" fill="#C4DBCA" fontFamily="Inter,Arial,sans-serif" fontSize="10" fontWeight="650" letterSpacing="1.1">
        <text x="83" y="105">60 CM TRAY</text><text x="274" y="121">RAISED CITY ISLAND</text>
        <text x="69" y="310">SURROUNDING WATER</text><text x="438" y="316">GUIDED WALL</text>
      </g>
      <g transform="translate(474 57)"><rect width="120" height="28" rx="6" fill="#102B25" stroke="#456C56" /><circle cx="13" cy="14" r="3" fill="#B5EF71" /><text x="23" y="18" fill="#C5DACA" fontFamily="Inter,Arial,sans-serif" fontSize="8" fontWeight="700" letterSpacing="1">MODEL ONLY</text></g>
      <path d="M68 347 347 427l269-78" fill="none" stroke="#71B68D" strokeOpacity=".55" strokeWidth="2" />
      <text x="345" y="411" fill="#83AD91" fontFamily="Inter,Arial,sans-serif" fontSize="9" textAnchor="middle" letterSpacing="1.6">FLOODGUARD TRAY MODEL · 60 × 45 CM</text>
    </svg>
  </div>;
}

function StateStep({ state, range, action, icon }: { state: FloodState; range: string; action: string; icon: ReactNode }) {
  return <article className={`state-step step-${state.toLowerCase()}`}><div className="state-step-top"><span className="step-icon">{icon}</span><StateBadge state={state} compact /></div><strong className="state-range">{range}</strong><span className="state-action">{action}</span><i className="state-step-line" /></article>;
}

function ArchitectureNode({ icon, label, sub }: { icon: ReactNode; label: string; sub: string }) {
  return <div className="architecture-node"><span>{icon}</span><strong>{label}</strong><small>{sub}</small></div>;
}

function AboutPage() {
  return <main className="inner-page page-width">
    <div className="inner-page-heading"><span className="section-kicker">PROJECT BRIEF · 01 / 16</span><h1>FloodGuard, from water reading to model response.</h1><p>A complete science-fair concept for a sensor-led barrier and warning demonstration—kept deliberately separate from real flood infrastructure.</p></div>
    <div className="project-summary-grid"><article className="summary-card summary-card-dark"><span>PROJECT OWNER</span><strong>Md Moshiur Rahman Mohi</strong><small>Student science-fair prototype · Sep 27, 2026</small></article><article className="summary-card"><span>MODEL FOOTPRINT</span><strong>60 × 45 cm</strong><small>Raised island · guided wall · surrounding tray</small></article><article className="summary-card"><span>CONTROL CORE</span><strong>ESP32 + ESP8266</strong><small>Controller plus sender-only sensor node</small></article></div>
    <section className="brief-section"><div className="brief-section-title"><span>01</span><div><h2>What the prototype demonstrates</h2><p>Four layers turn a sensor reading into a visible, testable idea.</p></div></div><div className="brief-points"><BriefPoint icon={<Waves />} title="Sense" text="Two ultrasonic sensors measure the water-to-sensor distance. Calibrated zero reference and a 7-sample median filter are planned to reduce noisy echoes." /><BriefPoint icon={<Activity />} title="Classify" text="The controller converts distance into water height and applies SAFE, WATCH, WARNING, CRITICAL, UNKNOWN and FAULT states." /><BriefPoint icon={<ArrowUp />} title="Respond" text="A lightweight, guided servo barrier demonstrates raising at WARNING/CRITICAL. Critical remains latched until an authorized local reset." /><BriefPoint icon={<Bell />} title="Communicate" text="The demo dashboard, buzzer and optional notification design make the state easier to understand at a science-fair table." /></div></section>
    <section className="brief-section tray-detail-section"><div className="brief-section-title"><span>02</span><div><h2>Physical tray &amp; model layout</h2><p>Use a small contained tray with the electronics protected from splash.</p></div></div><div className="tray-detail-grid"><div className="tray-plan-card"><TrayDiagram /></div><div className="safety-list"><h3>Build safety checklist</h3><SafetyPoint number="01" title="Start with one wall" text="Test a single light panel for five smooth up/down cycles before adding the second guide." /><SafetyPoint number="02" title="Limit the travel" text="Use physical end stops and a torque-limited servo range; a stall or jam must go to FAULT." /><SafetyPoint number="03" title="Keep electronics dry" text="Keep the ESP32, power supply and signal connections in a raised splash-protected enclosure." /><SafetyPoint number="04" title="Power deliberately" text="Power the servo rail separately (rated supply, typically ≥2 A for the model), with a shared ground and no 5 V backfeed into ESP32 GPIO." /></div></div></section>
    <section className="brief-section"><div className="brief-section-title"><span>03</span><div><h2>Bill of materials worksheet</h2><p>Quote local parts before purchase; the cost cells are intentionally left open.</p></div></div><BOMTable /></section>
    <section className="brief-section"><div className="brief-section-title"><span>04</span><div><h2>Planned software architecture</h2><p>The specification separates demo simulation from any future verified live deployment.</p></div></div><ArchitectureSpec /></section>
    <section className="big-safety-callout"><ShieldAlert size={20} /><div><strong>Not an operational flood defense</strong><p>A tabletop model cannot represent river, tide, surge or structural loads. No life-safety claim is made. Keep water shallow, use low-voltage power, include a physical emergency stop, and never install this prototype in a real drainage or flood-control system.</p></div></section>
  </main>;
}

function BriefPoint({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <article className="brief-point"><span>{icon}</span><div><h3>{title}</h3><p>{text}</p></div></article>;
}
function SafetyPoint({ number, title, text }: { number: string; title: string; text: string }) {
  return <div className="safety-point"><span>{number}</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}
function BOMTable() {
  const items = [
    ['ESP32 WROOM DevKit', '1', 'Main state machine + barrier control'],
    ['NodeMCU ESP8266', '1', 'Sender-only sensor node'],
    ['HC-SR04 ultrasonic sensor', '2', 'Water-level distance sensing'],
    ['SG90 / MG90S micro servo', '2', 'Light model barrier lift'],
    ['1 kΩ + 2 kΩ divider pair', '2 sets', 'Echo level shift to 3.3 V GPIO'],
    ['5 V supply + battery option', '1', 'Separate regulated servo power'],
    ['Active buzzer + NPN driver', '1', 'Audible state signal'],
    ['NC latching emergency stop', '1', 'Physical actuator power cut'],
    ['Guide rail + soft seal strip', '2 + 1 m', 'Wall track and model seal'],
    ['Tray, foam board, wires', 'As needed', '60 × 45 cm tabletop model'],
  ];
  return <div className="bom-table-wrap"><table className="bom-table"><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Purpose</th><th>Unit ৳</th><th>Total ৳</th></tr></thead><tbody>{items.map((item, index) => <tr key={item[0]}><td>{String(index + 1).padStart(2, '0')}</td><td><strong>{item[0]}</strong></td><td>{item[1]}</td><td>{item[2]}</td><td className="blank-price">____</td><td className="blank-price">____</td></tr>)}</tbody></table><p className="table-note">Quote-first worksheet · verify ESP32/ESP8266 GPIO voltage and servo torque before buying. Prices are not estimates.</p></div>;
}
function ArchitectureSpec() {
  const items = [
    { icon: <Radio />, title: 'ESP32 / ESP8266', text: 'Device credential + monotonic sequence' },
    { icon: <Activity />, title: 'Express + TypeScript', text: 'Telemetry validation + role scope' },
    { icon: <Layers3 />, title: 'Turso / libSQL', text: 'Telemetry, users, consent and outbox' },
    { icon: <Bell />, title: 'Outbox worker', text: 'Idempotent retry + Web Push / email' },
    { icon: <Gauge />, title: 'React / Vite PWA', text: 'Zone-scoped dashboard + offline shell' },
  ];
  return <div className="architecture-spec-grid">{items.map((item, i) => <div className="architecture-spec-item" key={item.title}><span className="arch-spec-icon">{item.icon}</span><span className="arch-spec-index">0{i + 1}</span><strong>{item.title}</strong><small>{item.text}</small>{i < items.length - 1 && <ArrowRight className="arch-spec-arrow" size={15} />}</div>)}</div>;
}

function AppShell({ children, title, subtitle, actions, mode }: { children: ReactNode; title: string; subtitle?: string; actions?: ReactNode; mode?: 'simulation' | 'turso' }) {
  const { t } = useAppCopy();
  const nav = [
    { to: '/app', label: t('nav.dashboard'), icon: <Gauge size={17} />, end: true },
    { to: '/app/history', label: 'History & trends', icon: <History size={17} /> },
    { to: '/devices', label: t('nav.devices'), icon: <Radio size={17} /> },
    { to: '/guides', label: t('nav.guides'), icon: <BookOpen size={17} /> },
  ];
  return <main className="app-layout page-width">
    <aside className="app-sidebar">
      <div className="sidebar-label">PROJECT WORKSPACE</div>
      <div className="workspace-switcher"><div className="workspace-avatar">RI</div><div><strong>River Island City</strong><span>Ward 04 · North Bank</span></div><ChevronDown size={14} /></div>
      <nav className="app-side-nav" aria-label="Demo workspace">{nav.map((item) => <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => isActive ? 'side-link active' : 'side-link'}>{item.icon}<span>{item.label}</span>{item.to === '/app' && <span className="side-live-dot" />}</NavLink>)}</nav>
      <div className="sidebar-divider"></div>
      <div className="sidebar-label">PROJECT</div>
      <NavLink to="/about" className={({ isActive }) => isActive ? 'side-link active' : 'side-link'}><Info size={17} /><span>Project brief</span></NavLink>
      <NavLink to="/hackeradmin" className="side-link"><LockKeyhole size={17} /><span>Owner console</span><LockKeyhole className="side-lock" size={12} /></NavLink>
      <div className="sidebar-bottom"><div className="sidebar-demo-icon"><TriangleAlert size={15} /></div><strong>Preview environment</strong><p>Sample data only. Telemetry is not connected to real hardware.</p><Link to="/about">Read safety notes <ArrowRight size={12} /></Link></div>
    </aside>
    <section className="app-content">
      <div className="app-page-heading"><div><div className="breadcrumb"><Link to="/">FloodGuard</Link><ChevronRight size={12} /><span>Workspace</span><ChevronRight size={12} /><span>{title}</span></div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="app-heading-actions">{actions}<span className={`demo-mode-chip ${mode === 'turso' ? 'mode-turso' : ''}`}><i></i> {mode === 'turso' ? 'TURSO API' : 'SIMULATION'}</span></div></div>
      {children}
    </section>
  </main>;
}

function DashboardPage() {
  const { language, t } = useAppCopy();
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    try { setData(await getDashboard()); setError(''); }
    catch (exception) { setError(exception instanceof Error ? exception.message : 'Dashboard API unavailable.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const runAction = async (action: Parameters<typeof simulate>[0], label: string, confirm = false) => {
    if (confirm && !window.confirm(`${label}\n\nThis changes only saved simulation data; no physical actuator is connected.`)) return;
    setPending(action); setNotice('');
    try {
      const result = await simulate(action);
      setData(result.dashboard);
      setNotice(result.message);
      setError('');
    } catch (exception) { setError(exception instanceof Error ? exception.message : 'Could not update the simulation.'); }
    finally { setPending(null); }
  };
  const system = data?.system;
  const simulationDisabled = Boolean(pending) || data?.mode === 'turso';
  const title = t('dashboard.title');
  return <AppShell title={title} subtitle={t('dashboard.subtitle')} mode={data?.mode} actions={<button className="icon-button" onClick={() => void refresh()} aria-label="Refresh dashboard"><RefreshCw size={16} /></button>}>
    {error && <div className="api-error"><WifiOff size={17} /><span><strong>API unavailable</strong>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
    {data && <>
      <div className="dashboard-meta-strip"><span className="meta-system-tag"><span className="meta-pulse"></span> {data.mode === 'turso' ? 'TURSO API CONNECTED' : 'DEMO API CONNECTED'}</span><span>{data.mode === 'simulation' ? t('dashboard.updated') : `Server snapshot · ${formatTime(data.updatedAt)}`}</span><span>{data.city} <i>/</i> {data.zone}</span></div>
      {data.maintenanceMode && <div className="maintenance-banner"><Info size={16} /><span>Read-only maintenance mode is active for this demo.</span></div>}
      <div className="dashboard-overview-grid">
        <section className={`panel water-level-panel level-${system?.state.toLowerCase()}`}>
          <div className="panel-heading-row"><div><span className="panel-eyebrow"><Droplets size={13} /> PRIMARY SENSOR · {system?.seq ? `SEQ ${system.seq}` : '—'}</span><h2>{t('dashboard.level')}</h2></div><StateBadge state={system?.state || 'UNKNOWN'} /></div>
          <div className="water-level-main"><div className="water-level-number">{system?.levelCm === null || system?.levelCm === undefined ? '—' : system.levelCm.toFixed(1)}<span>cm</span></div><div className="trend-chip"><ArrowUpRight size={14} /> +{system?.trendCm ?? 0} cm <small>last 30 min</small></div></div>
          <WaterGauge value={system?.levelCm ?? 0} state={system?.state || 'UNKNOWN'} />
          <div className="water-scale"><span>0 cm</span><span>20</span><span>35</span><span>50</span><span>60 cm</span></div>
          <div className="level-threshold-key"><span className="threshold-key-safe"><i></i> SAFE &lt;20</span><span className="threshold-key-watch"><i></i> WATCH 20–34</span><span className="threshold-key-warning"><i></i> WARNING 35–49</span><span className="threshold-key-critical"><i></i> CRITICAL ≥50</span></div>
          <p className="gauge-footnote"><Info size={12} /> Height relative to the model tray's calibrated sensor zero—not sea level.</p>
        </section>
        <section className="panel barrier-panel">
          <div className="panel-heading-row"><div><span className="panel-eyebrow"><Layers3 size={13} /> ACTUATOR STATUS · MODEL</span><h2>{t('dashboard.barrier')}</h2></div><span className={system?.barrier === 'FAULT' ? 'status-signal signal-danger' : 'status-signal'}><i></i>{system?.emergencyStopActive ? 'E-STOP' : 'LOCAL SIM'}</span></div>
          <div className={`barrier-illustration barrier-visual-${system?.barrier.toLowerCase()}`}><div className="barrier-water-side"><span>WATER SIDE</span><Waves size={32} /></div><div className="barrier-wall"><i></i><i></i><i></i><i></i></div><div className="barrier-city-side"><div className="barrier-city-icon"><HomeIcon size={20} /></div><span>MODEL CITY</span></div><div className="barrier-ground"></div><div className="barrier-status-note"><span className="barrier-status-icon"><Layers3 size={16} /></span><div><small>WALL POSITION</small><strong>{language === 'bn' ? t(`barrier.${system?.barrier || 'HOLD'}` as CopyKey) : barrierEnglish[system?.barrier || 'HOLD']}</strong></div></div></div>
          <div className="barrier-readouts"><div><span>Barrier response</span><strong>{system?.barrierLatched ? 'Latched raised' : system?.barrier === 'FAULT' ? 'Outputs inhibited' : 'Auto-demo state'}</strong></div><div><span>Buzzer</span><strong className={system?.buzzer ? 'buzzer-on' : ''}>{system?.buzzer ? '● Audible pattern active' : '○ Silent'}</strong></div></div>
          <div className="latch-note"><LockKeyhole size={13} /> WARNING/CRITICAL stays latched. Lowering requires a safe local reset in real hardware.</div>
        </section>
      </div>

      <div className="stat-cards-grid">
        <StatCard icon={<Radio size={17} />} label={t('dashboard.devices')} value={`${data.stats.activeDevices} / ${data.devices.length}`} detail="ESP32 + ESP8266 sample nodes" tone="green" />
        <StatCard icon={<CloudRain size={17} />} label="Rainfall · sample" value={system?.rainfallMm === null || system?.rainfallMm === undefined ? '—' : `${system.rainfallMm} mm`} detail="Illustrative accumulated input" tone="blue" />
        <StatCard icon={<Signal size={17} />} label="Network heartbeat" value="Stable" detail="Local demo response · not a field link" tone="amber" />
        <StatCard icon={<Bell size={17} />} label="Open state signals" value={String(data.stats.alerts).padStart(2, '0')} detail={`${data.stats.samplesToday} sample points today`} tone="peach" />
      </div>

      <section className="panel trend-panel"><div className="panel-heading-row trend-heading"><div><span className="panel-eyebrow"><Activity size={13} /> WATER LEVEL · HISTORY</span><h2>How the sample level changed</h2></div><Link to="/app/history" className="panel-text-link">View full history <ArrowRight size={14} /></Link></div><TrendChart points={data.history} compact /><div className="chart-meta"><span><i className="chart-legend-line"></i> Level · cm</span><span><i className="chart-legend-threshold"></i> Thresholds</span><span>Updates on simulator action</span></div></section>

      <div className="dashboard-lower-grid">
        <section className="panel device-panel"><div className="panel-heading-row"><div><span className="panel-eyebrow"><Cpu size={13} /> DEVICE NETWORK</span><h2>Field nodes</h2></div><Link to="/devices" className="panel-text-link">All devices <ArrowRight size={14} /></Link></div><div className="device-list">{data.devices.map((device) => <DeviceRow key={device.id} device={device} />)}</div></section>
        <section className="panel events-panel"><div className="panel-heading-row"><div><span className="panel-eyebrow"><Activity size={13} /> EVENT LOG</span><h2>{t('dashboard.watchlist')}</h2></div><span className="event-live-label"><i></i> LOCAL</span></div><EventList events={data.events.slice(0, 4)} empty="No sample events yet." /></section>
      </div>

      <section className="panel simulator-panel"><div className="simulator-heading"><div className="simulator-icon"><Activity size={18} /></div><div><span className="panel-eyebrow">{data.mode === 'turso' ? 'TELEMETRY VIEW · CONTROL DISABLED' : 'DEMO CONTROLS · NO HARDWARE CONNECTION'}</span><h2>{t('dashboard.simulator')}</h2><p>{data.mode === 'turso' ? 'Simulation buttons are disabled while Turso is connected. This API accepts sensor readings only and never sends actuator commands.' : t('dashboard.simulatorNote')}</p></div><div className="simulator-readout"><strong>{system?.levelCm?.toFixed(1) ?? '—'}<small>cm</small></strong><StateBadge state={system?.state || 'UNKNOWN'} compact /></div></div>
        <div className="simulation-actions"><button className="sim-action action-rise" onClick={() => void runAction('rise', 'Raise sample water level')} disabled={simulationDisabled}><ArrowUp size={16} />{pending === 'rise' ? 'Updating…' : t('action.rise')}</button><button className="sim-action" onClick={() => void runAction('recede', 'Lower sample water level')} disabled={simulationDisabled}><ArrowDown size={16} />{pending === 'recede' ? 'Updating…' : t('action.recede')}</button>{system?.sensorHealthy ? <button className="sim-action action-fault" onClick={() => void runAction('sensor-fault', 'Simulate sensor fault')} disabled={simulationDisabled}><TriangleAlert size={15} />{t('action.sensorFault')}</button> : <button className="sim-action" onClick={() => void runAction('sensor-recovered', 'Restore sample sensor')} disabled={simulationDisabled}><Check size={15} />{t('action.recover')}</button>}{system?.emergencyStopActive ? <button className="sim-action" onClick={() => void runAction('estop-reset', 'Release simulated E-stop')} disabled={simulationDisabled}><Check size={15} />{t('action.clearEstop')}</button> : <button className="sim-action action-fault" onClick={() => void runAction('estop', 'Test simulated E-stop', true)} disabled={simulationDisabled}><Zap size={15} />{t('action.estop')}</button>}<button className="sim-action sim-reset" onClick={() => void runAction('reset', 'Reset simulation', true)} disabled={simulationDisabled}><RefreshCw size={15} />{t('action.reset')}</button></div>
        {notice && <p className="simulator-feedback" role="status"><Check size={14} />{notice}</p>}
        <div className="simulator-disclaimer"><ShieldAlert size={14} /><span>Each button only updates the local preview database. The HTTP telemetry route accepts sensor data only; it never sends barrier or motor commands.</span></div>
      </section>
      <NotificationPanel mode={data.mode} />
    </>}
    {!data && !error && <div className="app-loading"><span className="loading-spinner"></span><strong>Loading sample telemetry…</strong><small>The dashboard will never use a cached reading as current data.</small></div>}
  </AppShell>;
}

function WaterGauge({ value, state }: { value: number; state: FloodState }) {
  const percentage = Math.max(2, Math.min(100, (value / 60) * 100));
  return <div className={`water-gauge gauge-${statusTone[state]}`} aria-label={`Sample water level ${value.toFixed(1)} centimeters`}>
    <div className="gauge-track"><div className="gauge-zones"><i></i><i></i><i></i><i></i></div><div className="gauge-fill" style={{ height: `${percentage}%` }}><span className="gauge-wave"></span></div><div className="gauge-mark mark-20"><span>20</span></div><div className="gauge-mark mark-35"><span>35</span></div><div className="gauge-mark mark-50"><span>50</span></div></div>
    <div className="gauge-side"><span className="gauge-peak">60</span><div className="gauge-pointer" style={{ bottom: `${percentage}%` }}><span></span><i>{value.toFixed(1)} cm</i></div><span className="gauge-zero">0</span></div>
  </div>;
}

function StatCard({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <article className={`stat-card stat-${tone}`}><div className="stat-card-head"><span className="stat-icon">{icon}</span><span className="stat-label">{label}</span><ArrowUpRight size={13} className="stat-arrow" /></div><strong className="stat-value">{value}</strong><span className="stat-detail">{detail}</span></article>;
}

function TrendChart({ points, compact = false }: { points: TelemetryPoint[]; compact?: boolean }) {
  const width = 740, height = compact ? 190 : 280;
  const padding = { left: 38, right: 15, top: 18, bottom: 28 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const series = [...points].slice(-36);
  const safePoints = series.length ? series : [{ id: 'empty', seq: 0, deviceId: '', levelCm: 0, rainfallMm: null, state: 'UNKNOWN' as FloodState, sensorHealthy: false, createdAt: new Date().toISOString() }];
  const x = (index: number) => padding.left + (safePoints.length === 1 ? chartWidth / 2 : index / (safePoints.length - 1) * chartWidth);
  const y = (level: number) => padding.top + chartHeight - Math.max(0, Math.min(60, level)) / 60 * chartHeight;
  const line = safePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(point.levelCm).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(safePoints.length - 1)} ${padding.top + chartHeight} L ${x(0)} ${padding.top + chartHeight} Z`;
  const tickValues = [0, 20, 35, 50, 60];
  const last = safePoints.at(-1)!;
  return <div className={`trend-chart ${compact ? 'trend-chart-compact' : ''}`}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Sample water level trend chart with ${series.length} readings`}>
      <defs><linearGradient id="chart-area-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#AEE972" stopOpacity=".26" /><stop offset="1" stopColor="#AEE972" stopOpacity="0" /></linearGradient></defs>
      {tickValues.map((tick) => <g key={tick}><line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} className={`chart-gridline ${[20, 35, 50].includes(tick) ? 'chart-threshold-line' : ''}`} /><text x={padding.left - 9} y={y(tick) + 3} textAnchor="end" className="chart-axis-label">{tick}</text></g>)}
      <path d={area} fill="url(#chart-area-fill)" />
      <path d={line} fill="none" className="chart-water-line" />
      {safePoints.map((point, index) => index === safePoints.length - 1 || (!compact && index % 6 === 0) ? <circle key={point.id} cx={x(index)} cy={y(point.levelCm)} r={index === safePoints.length - 1 ? 4.4 : 3} className="chart-point" /> : null)}
      <text x={padding.left} y={height - 7} className="chart-axis-label">{series[0] ? formatTime(series[0].createdAt) : ''}</text>
      <text x={width - padding.right} y={height - 7} textAnchor="end" className="chart-axis-label">{formatTime(last.createdAt)}</text>
    </svg>
  </div>;
}

function DeviceRow({ device }: { device: DeviceSummary }) {
  return <Link to={`/devices/${device.id}`} className="device-row"><span className={`device-row-icon ${device.kind.startsWith('ESP32') ? 'controller-icon' : ''}`}>{device.kind.startsWith('ESP32') ? <Cpu size={17} /> : <Radio size={17} />}</span><span className="device-row-main"><strong>{device.name}</strong><small>{device.id} <i>·</i> {device.kind}</small></span><StateBadge state={device.state} compact /><span className="device-row-connectivity"><i className={device.online ? 'online' : 'offline'}></i>{device.online ? 'Online' : 'Offline'}</span><ChevronRight size={15} className="device-row-chevron" /></Link>;
}

function EventList({ events, empty }: { events: FloodEvent[]; empty: string }) {
  if (!events.length) return <p className="empty-events">{empty}</p>;
  return <div className="event-list">{events.map((event) => <article className="event-row" key={event.id}><span className={`event-point event-${event.state.toLowerCase()}`}>{event.state === 'INFO' ? <Info size={13} /> : <CircleDot size={13} />}</span><div><strong>{event.title}</strong><p>{event.message}</p><small>{timeAgo(event.createdAt)} <i>·</i> {formatTime(event.createdAt)}</small></div></article>)}</div>;
}

function HistoryPage() {
  const [history, setHistory] = useState<TelemetryPoint[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { getHistory(100).then((result) => setHistory(result.history)).catch((exception) => setError(exception.message)); }, []);
  return <AppShell title="History & trends" subtitle="Sample telemetry sequence and state transitions for the science-fair controller.">
    {error && <div className="api-error"><WifiOff size={17} /><span>{error}</span></div>}
    <section className="panel history-chart-panel"><div className="panel-heading-row"><div><span className="panel-eyebrow"><Activity size={13} /> SAMPLE SENSOR · FG-ESP32-01</span><h2>Water level history</h2></div><div className="history-window-tag">LAST {history.length} SAMPLE POINTS</div></div><TrendChart points={history} /><div className="chart-meta"><span><i className="chart-legend-line"></i> Level · cm</span><span><i className="chart-legend-threshold"></i> State thresholds</span><span>Stored locally for the demo</span></div></section>
    <section className="panel history-table-panel"><div className="panel-heading-row"><div><span className="panel-eyebrow"><History size={13} /> EVENT-ORDERED TELEMETRY</span><h2>Recent readings</h2></div><span className="local-only-tag"><LockKeyhole size={12} /> DEMO STORE</span></div><div className="table-scroll"><table className="telemetry-table"><thead><tr><th>Time</th><th>Sequence</th><th>Level</th><th>State</th><th>Sensor</th><th>Rainfall</th></tr></thead><tbody>{[...history].reverse().map((point) => <tr key={point.id}><td>{formatTime(point.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</td><td className="mono-cell">{point.seq}</td><td><strong>{point.levelCm.toFixed(1)} cm</strong></td><td><StateBadge state={point.state} compact /></td><td>{point.sensorHealthy ? <span className="sensor-ok"><Check size={12} /> Healthy</span> : <span className="sensor-fault"><TriangleAlert size={12} /> Fault</span>}</td><td>{point.rainfallMm === null ? '—' : `${point.rainfallMm} mm`}</td></tr>)}{history.length === 0 && <tr><td colSpan={6} className="table-empty">No readings loaded.</td></tr>}</tbody></table></div></section>
    <div className="history-note"><Info size={14} /><span>In a connected deployment, telemetry would be persisted with a monotonic per-device sequence and duplicate/replay protection. This preview stores generated simulator readings only.</span></div>
  </AppShell>;
}

function DevicesPage() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { getDevices().then((result) => setDevices(result.devices)).catch((exception) => setError(exception.message)); }, []);
  return <AppShell title="Devices" subtitle="A read-only view of the demo sensor network and controller roles.">
    {error && <div className="api-error"><WifiOff size={17} /><span>{error}</span></div>}
    <div className="device-intro-banner"><div className="device-intro-icon"><Radio size={20} /></div><div><strong>Device commands are disabled in this preview</strong><p>The ESP32 firmware owns offline barrier logic. The web API accepts telemetry only and cannot raise or lower a physical actuator.</p></div><span className="read-only-chip"><LockKeyhole size={12} /> READ ONLY</span></div>
    <div className="devices-full-list">{devices.map((device) => <DeviceCard key={device.id} device={device} />)}</div>
    <section className="device-roles-grid"><article><Cpu size={19} /><span className="section-kicker">ACTUATOR NODE</span><h3>ESP32 WROOM</h3><p>Measures/receives local readings, evaluates thresholds, drives two small servo channels and buzzer through safe interfaces, and monitors E-stop.</p><div className="pin-strip"><span>GPIO 25 · TRIG</span><span>GPIO 34 · ECHO</span><span>GPIO 18/19 · PWM</span></div></article><article><Radio size={19} /><span className="section-kicker">SENDER-ONLY NODE</span><h3>NodeMCU ESP8266</h3><p>Reads a second HC-SR04 and sends HTTPS telemetry with a device key and monotonic sequence. It never owns a servo, motor or barrier command.</p><div className="pin-strip"><span>D1 · TRIG</span><span>D2 · ECHO</span><span>DIVIDER · 5V → 3.3V</span></div></article></section>
  </AppShell>;
}

function DeviceCard({ device }: { device: DeviceSummary }) {
  const controller = device.kind.startsWith('ESP32');
  return <Link to={`/devices/${device.id}`} className="device-card"><div className={`device-card-icon ${controller ? 'device-card-controller' : ''}`}>{controller ? <Cpu size={21} /> : <Radio size={21} />}</div><div className="device-card-main"><div className="device-card-title"><h2>{device.name}</h2><StateBadge state={device.state} compact /></div><p>{device.id} <span>·</span> {device.kind} <span>·</span> {device.zone}</p><div className="device-card-meta"><span><i className="online"></i>{device.online ? 'Sample heartbeat present' : 'No recent heartbeat'}</span><span>FW {device.firmwareVersion}</span><span>Signal {device.signal}%</span></div></div><div className="device-card-level"><span>LAST SAMPLE LEVEL</span><strong>{device.latestLevelCm === null ? '—' : `${device.latestLevelCm.toFixed(1)} cm`}</strong><span>{timeAgo(device.lastSeenAt)}</span></div><ChevronRight size={18} /></Link>;
}

function DeviceDetailPage() {
  const { deviceId } = useParams();
  const [device, setDevice] = useState<DeviceSummary | null>(null);
  const [history, setHistory] = useState<TelemetryPoint[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/devices/${encodeURIComponent(deviceId || '')}`, { cache: 'no-store' }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Device not found.');
      setDevice(body.device); setHistory(body.history);
    }).catch((exception: Error) => setError(exception.message));
  }, [deviceId]);
  if (error) return <AppShell title="Device details"><div className="api-error"><WifiOff size={17} /><span>{error}</span><Link to="/devices">Back to devices</Link></div></AppShell>;
  if (!device) return <AppShell title="Device details"><div className="app-loading"><span className="loading-spinner"></span><strong>Loading device…</strong></div></AppShell>;
  return <AppShell title={device.name} subtitle={`${device.id} · ${device.kind} · ${device.zone}`} actions={<Link to="/devices" className="back-link"><ArrowLeft size={14} /> All devices</Link>}>
    <div className="device-detail-overview"><div className="device-detail-card"><span className="panel-eyebrow"><Cpu size={13} /> DEVICE STATUS</span><div className="device-detail-state"><StateBadge state={device.state} /><span className="device-heartbeat"><i className="online"></i> Demo heartbeat</span></div><div className="device-detail-reading"><strong>{device.latestLevelCm?.toFixed(1) ?? '—'}<small>cm</small></strong><span>last sample water level</span></div><div className="device-detail-kv"><span>Firmware <strong>{device.firmwareVersion}</strong></span><span>Signal quality <strong>{device.signal}%</strong></span><span>Last seen <strong>{timeAgo(device.lastSeenAt)}</strong></span></div></div><div className="panel device-detail-info"><span className="panel-eyebrow"><Info size={13} /> ROLE &amp; SAFETY</span><h2>{device.kind.startsWith('ESP32') ? 'Main actuator controller' : 'Sender-only sensor node'}</h2><p>{device.kind.startsWith('ESP32') ? 'Barrier state machine and local buzzer are intended to run on the ESP32, even without cloud access. Physical emergency stop stays local.' : 'This ESP8266 sends signed, ordered telemetry. It is not permitted to issue barrier, buzzer, servo, or motor commands.'}</p><div className="no-commands"><LockKeyhole size={13} /> Remote commands are disabled</div></div></div>
    <section className="panel device-detail-chart"><div className="panel-heading-row"><div><span className="panel-eyebrow"><Activity size={13} /> DEVICE TELEMETRY</span><h2>Water level samples</h2></div></div><TrendChart points={history} /></section>
  </AppShell>;
}

function GuidesPage() {
  const guides = [
    { slug: 'wiring', number: '01', title: 'ESP32 wiring & power', description: 'Pin map, common ground, echo voltage divider, servo supply and no-backfeed checklist.', icon: <Cpu size={20} />, tag: 'HARDWARE' },
    { slug: 'sender-node', number: '02', title: 'ESP8266 sender node', description: 'Sender-only wiring for D1/D2, its own Echo divider and HTTPS telemetry role.', icon: <Radio size={20} />, tag: 'DEVICE' },
    { slug: 'thresholds', number: '03', title: 'Flood states & barrier logic', description: 'Median filtering, hysteresis, SAFE → WATCH → WARNING → CRITICAL and FAULT behavior.', icon: <Activity size={20} />, tag: 'FIRMWARE' },
    { slug: 'safety', number: '04', title: 'Tray model & safety', description: '60 × 45 cm model layout, single-wall test plan, shallow water and physical E-stop.', icon: <ShieldCheck size={20} />, tag: 'SAFETY' },
    { slug: 'architecture', number: '05', title: 'Backend & cloud architecture', description: 'Express API, Turso/libSQL migrations, protected Hackeradmin and consent-based notification outbox.', icon: <Layers3 size={20} />, tag: 'SOFTWARE' },
    { slug: 'demo-script', number: '06', title: 'Four-minute demo script', description: 'Rehearse WATCH, CRITICAL, sensor-fault and E-stop using the safe simulator.', icon: <Zap size={20} />, tag: 'PRESENTATION' },
  ];
  return <main className="inner-page page-width guide-index-page">
    <div className="inner-page-heading"><span className="section-kicker">BUILD NOTES · EDUCATIONAL PROTOTYPE</span><h1>Clear notes for a careful build.</h1><p>Hardware, firmware, web dashboard and demonstration flow—organized for a student project, with safety boundaries visible.</p></div>
    <div className="guide-grid">{guides.map((guide) => <Link to={`/guides/${guide.slug}`} className="guide-card" key={guide.slug}><div className="guide-card-top"><span className="guide-number">{guide.number}</span><span className="guide-icon">{guide.icon}</span><span className="guide-tag">{guide.tag}</span></div><h2>{guide.title}</h2><p>{guide.description}</p><span className="guide-card-link">Open guide <ArrowUpRight size={14} /></span></Link>)}</div>
    <div className="guide-precision-note"><TriangleAlert size={17} /><div><strong>Check wiring and sensor calibration against your exact board revision.</strong><p>The pin and divider values in these notes are a starting point. Test with low voltage and no water near exposed electronics.</p></div></div>
  </main>;
}

const guideDetails: Record<string, { number: string; title: string; intro: string; sections: Array<{ title: string; body: string; bullets?: string[] }> }> = {
  wiring: { number: '01', title: 'ESP32 wiring & power', intro: 'The main controller reads the water-level sensor, drives two small model servos through PWM, and monitors buzzer and E-stop signals.', sections: [
    { title: 'ESP32 WROOM pin map', body: 'Use ADC1 for the optional analog sensor if Wi-Fi is active. Confirm your exact ESP32 board pin labels before wiring.', bullets: ['GPIO 25 → HC-SR04 TRIG (10 μs trigger)', 'GPIO 34 ← HC-SR04 ECHO through 1 kΩ series + 2 kΩ to GND (about 3.3 V)', 'GPIO 26 ← optional water sensor analog (ADC1)', 'GPIO 18 / 19 → servo PWM signal only; servos use a separate regulated 5 V rail', 'GPIO 27 → active buzzer driver transistor; GPIO 4 → E-stop input (hardware NC circuit)'] },
    { title: 'Common ground, separate power', body: 'ESP32, sensor supply and servo supply need a common ground reference. Do not route servo current through the ESP32 regulator or feed 5 V into a GPIO.', bullets: ['Use a regulated servo supply sized for stall current; 2 A is only a project planning baseline.', 'Add the required decoupling near the servo rail and keep sensor wires short.', 'Put the physical normally-closed, latching E-stop in the actuator power path.', 'Never test a moving barrier with fingers or loose cable near its guide rail.'] },
  ] },
  'sender-node': { number: '02', title: 'ESP8266 sender-only node', intro: 'NodeMCU samples a second distance sensor and posts ordered telemetry over HTTPS. It has no barrier, servo or buzzer responsibilities.', sections: [
    { title: 'D1 / D2 mapping', body: 'The HC-SR04 Echo output is 5 V while ESP8266 GPIO is 3.3 V tolerant only. The divider is mandatory.', bullets: ['D1 (GPIO 5) → HC-SR04 TRIG', 'D2 (GPIO 4) ← divided ECHO: sensor ECHO → 1 kΩ → D2; D2 → 2 kΩ → GND', 'HC-SR04 VCC → suitable sensor supply; GND shared with NodeMCU', 'USB/VIN powers the sender board only; do not attach servos to the sender node.'] },
    { title: 'Telemetry contract', body: 'Each authenticated sender posts a monotonic integer sequence and a measured level. The server rejects duplicate and out-of-order sequence values.', bullets: ['POST /api/v1/telemetry over HTTPS', 'Authorization: Bearer <per-device key> (store a hash server-side)', 'Body includes deviceId, seq, levelCm, sensorHealthy and optional rainfallMm', 'Keep the key in ignored local configuration; never commit a real key to GitHub.'] },
  ] },
  thresholds: { number: '03', title: 'Flood states & barrier logic', intro: 'Use a calibrated sensor-to-zero reference, filtered distance samples, hysteresis and a latched response. The demo simulator uses the simple thresholds below.', sections: [
    { title: 'Prototype thresholds', body: 'h = (d_zero − d_median) × calibration. The dashboard sample uses water-height centimeters; real thresholds must be validated for the exact tray and sensor geometry.', bullets: ['SAFE: h < 20 cm · barrier DOWN', 'WATCH: 20–34 cm · buzzer chirp', 'WARNING: 35–49 cm · raise the lightweight model barrier', 'CRITICAL: h ≥ 50 cm · barrier remains RAISED and latched', 'UNKNOWN: sensor invalid / stale · inhibit new movement and hold position', 'FAULT: E-stop, jam or actuator failure · cut actuator output and require local inspection/reset'] },
    { title: 'Filtering and latching', body: 'Sample seven valid echoes per cycle and use the median; reject timeouts and physically impossible jumps. Add entry/exit hysteresis at each boundary to prevent threshold chatter.', bullets: ['At boot, initialize the barrier state as UNKNOWN; do not auto-lower.', 'A jam or E-stop enters FAULT. Acknowledge only after physical inspection.', 'CRITICAL requires a deliberate local OWNER reset after level is below the safe threshold.', 'A cloud/API outage must not stop the ESP32 local safety state machine.'] },
  ] },
  safety: { number: '04', title: 'Tray model & safety', intro: 'The tray is an educational tabletop demonstration, not a miniature engineering design for a real barrier.', sections: [
    { title: 'Model dimensions & mechanical order', body: 'Plan a 60 × 45 cm tray with a 25 × 20 cm raised city island, two guided wall rails and an electronics enclosure above splash height.', bullets: ['Use shallow water only; keep the tray away from mains and outlets.', 'Build one wall first and complete five smooth up/down dry runs.', 'Check binding, seals and travel stops at reduced servo travel.', 'Only synchronize two sides after each wall moves freely on its own.'] },
    { title: 'Stop conditions', body: 'A physical E-stop is required on the model. Software reset, web page, Wi-Fi and cloud controls are not substitutes for cutting actuator power.', bullets: ['E-stop is latching and normally closed in the actuator enable path.', 'On sensor fault, stall or unexpected motion, stop and disconnect servo power.', 'Keep hands, sleeves and wires clear of guides and linkage.', 'Have an adult inspect battery, wiring and wet-area separation before a public demo.'] },
  ] },
  architecture: { number: '05', title: 'Backend & cloud architecture', intro: 'FloodGuard includes a Turso/libSQL backend and a protected super-admin control plane. A default checkout still opens in local simulation mode until an operator configures deployment credentials.', sections: [
    { title: 'Configured data path', body: 'ESP32/ESP8266 → HTTPS Express TypeScript API → Turso/libSQL via the native client → durable notification outbox → configured SMTP, SMS HTTP gateway or Web Push. A React/Vite TypeScript PWA presents status and history.', bullets: ['Versioned SQL migrations are applied at startup; seed data is created explicitly.', 'Device API keys are hashed; each device has a monotonic telemetry sequence.', 'The outbox deduplicates delivery, retries bounded failures and only queues SMS alerts to phone-verified subscribers.', 'Hackeradmin protects manual provider setup with owner role checks, CSRF, TOTP, IP allowlisting and audit events.'] },
    { title: 'Preview boundary', body: 'Without Turso credentials the API uses a local JSON simulation store. No real sensor, SMTP/SMS provider or push key is bundled. Real delivery and persistence require operator-supplied credentials and security configuration; the server never issues motor commands.', bullets: ['Sample telemetry is fictional and is not an alert service.', 'Email uses double opt-in; SMS uses a one-time code and verified phone consent.', 'Provider credentials are encrypted at rest and never returned to the browser.', 'Turso mode does not enable the browser simulator or a remote actuator route.'] },
  ] },
  'demo-script': { number: '06', title: 'Four-minute science-fair demo', intro: 'Show the whole concept without wet electronics or remote actuation.', sections: [
    { title: 'Run of show', body: 'Use the built-in dashboard simulator with the physical model disconnected or on a guarded low-voltage test setup.', bullets: ['0:00–0:45 · Show tray, sensor line-of-sight and the raised island.', '0:45–1:30 · Click +5 cm once or twice; explain SAFE → WATCH and the buzzer pattern.', '1:30–2:30 · Cross WARNING; show the model barrier status and history event.', '2:30–3:10 · Simulate a sensor fault; explain UNKNOWN and hold-position behavior.', '3:10–3:35 · Test simulated E-stop and describe the physical NC switch.', '3:35–4:00 · Explain limitations, costs and what would need validation next.'] },
    { title: 'Evidence to capture', body: 'Acceptance criteria should be shown with logs or video, not claims.', bullets: ['Five repeatable wall movements with no binding.', 'E-stop cut-off and manual recovery evidence.', 'Sensor-timeout → UNKNOWN behavior.', 'Duplicate sequence rejected with HTTP 409.', 'No cloud connection → local firmware still evaluates level.'] },
  ] },
};

function GuideDetailPage() {
  const { slug = '' } = useParams();
  const guide = guideDetails[slug];
  if (!guide) return <Navigate to="/guides" replace />;
  return <main className="inner-page page-width guide-detail-page"><Link to="/guides" className="back-link"><ArrowLeft size={14} /> All build notes</Link><div className="inner-page-heading"><span className="section-kicker">BUILD NOTE · {guide.number}</span><h1>{guide.title}</h1><p>{guide.intro}</p></div><div className="guide-detail-content">{guide.sections.map((section, index) => <section className="guide-detail-section" key={section.title}><div className="guide-detail-number">{String(index + 1).padStart(2, '0')}</div><div><h2>{section.title}</h2><p>{section.body}</p>{section.bullets && <ul>{section.bullets.map((bullet) => <li key={bullet}><Check size={14} />{bullet}</li>)}</ul>}</div></section>)}</div><div className="guide-precision-note"><ShieldAlert size={17} /><div><strong>Use as a learning guide, not a certified design.</strong><p>Always test with low-voltage power, shallow contained water, a physical E-stop and adult supervision.</p></div></div></main>;
}

function csrfCookie() {
  const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('fg_csrf='));
  return item ? decodeURIComponent(item.slice('fg_csrf='.length)) : '';
}

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

type ConsoleUser = { id: string; email: string; displayName: string; role: string; emailVerified: boolean; totpEnrolled: boolean; mfaVerified: boolean };
type SmtpSettings = { enabled: boolean; configured: boolean; host: string; port: number; secure: boolean; username: string; fromName: string; fromAddress: string; replyTo: string; hasPassword: boolean; lastTestAt: string | null; lastTestStatus: string | null };
type SmsSettings = { enabled: boolean; configured: boolean; endpoint: string; authHeader: string; authPrefix: string; senderId: string; toField: string; messageField: string; senderField: string; hasToken: boolean; lastTestAt: string | null; lastTestStatus: string | null };
type ConsoleMember = { id: string; email: string; displayName: string; role: string; emailVerified: boolean; disabled: boolean; totpEnrolled: boolean; createdAt: string };
type AuditEntry = { id: string; action: string; targetType: string; targetId: string | null; metadata: unknown; ipAddress: string | null; createdAt: string; actorEmail: string };

function AuthNoticePage({ kind }: { kind: 'login' | 'register' }) {
  const isLogin = kind === 'login';
  const navigate = useNavigate();
  const inviteToken = isLogin ? '' : new URLSearchParams(window.location.search).get('invite') || '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showTotp, setShowTotp] = useState(false);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      if (isLogin) {
        const result = await requestJson('/api/auth/login', 'POST', { email, password, ...(totp ? { totp } : {}) });
        if (result.mfaSetupRequired || result.user?.role === 'OWNER' || result.user?.role === 'ADMIN') navigate('/hackeradmin');
        else navigate('/app');
      } else {
        if (!inviteToken) throw new Error('Admin registration is invite-only. Ask a FloodGuard super-admin for a secure invite link.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        const result = await requestJson('/api/auth/accept-invite', 'POST', { token: inviteToken, password });
        setMessage(result.message || 'Invitation accepted. Continue in Hackeradmin to enroll MFA.');
        setTimeout(() => navigate('/hackeradmin'), 600);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Authentication request failed.';
      if (text.toLowerCase().includes('authenticator code')) setShowTotp(true);
      setMessage(text);
    } finally { setWorking(false); }
  };
  return <main className="admin-auth-page page-width"><div className="admin-auth-card"><div className="admin-auth-brand"><FloodGuardMark small /><div><strong>FLOODGUARD</strong><span>SECURE PROJECT ACCESS</span></div></div><span className="section-kicker">{isLogin ? 'ACCOUNT SIGN-IN' : 'INVITED ADMIN ACCOUNT'}</span><h1>{isLogin ? 'Sign in to your workspace.' : 'Accept your invitation.'}</h1><p>{isLogin ? 'Admin access uses a protected Turso database, an individual password and authenticator MFA.' : 'This one-time link expires after 48 hours. Admin accounts must enroll authenticator MFA before changing settings.'}</p>
    {!isLogin && !inviteToken && <div className="admin-inline-warning"><TriangleAlert size={15} /> Public account creation is closed. A super-admin must issue an invitation.</div>}
    {message && <p className="admin-feedback" role="status">{message}</p>}
    <form className="admin-form" onSubmit={(event) => void submit(event)}>
      {isLogin && <label>Email address<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" /></label>}
      <label>{isLogin ? 'Password' : 'Create a strong password'}<input type="password" required minLength={12} maxLength={128} autoComplete={isLogin ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 12 characters" /></label>
      {!isLogin && <label>Confirm password<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}
      {isLogin && showTotp && <label>Authenticator code<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totp} onChange={(event) => setTotp(event.target.value)} placeholder="6 digits" autoComplete="one-time-code" /></label>}
      <button className="admin-primary-button" type="submit" disabled={working || (!isLogin && !inviteToken)}>{working ? 'Working…' : isLogin ? 'Sign in securely' : 'Accept invitation'} <ArrowRight size={15} /></button>
    </form>
    <div className="admin-auth-footer">{isLogin ? <>Need an invitation? <Link to="/register">Accept invite</Link></> : <>Already invited? <Link to="/login">Sign in</Link></>} <span>·</span><Link to="/app">Return to demo</Link></div>
  </div></main>;
}

function OwnerConsolePage() {
  const [authStatus, setAuthStatus] = useState<{ databaseConfigured: boolean; authEnabled: boolean; bootstrapAvailable: boolean; ownerCount: number } | null>(null);
  const [user, setUser] = useState<ConsoleUser | null>(null);
  const [csrf, setCsrf] = useState('');
  const [screen, setScreen] = useState<'loading' | 'bootstrap' | 'login' | 'mfa' | 'console' | 'blocked'>('loading');
  const [tab, setTab] = useState<'overview' | 'providers' | 'admins' | 'audit'>('overview');
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [bootstrapName, setBootstrapName] = useState('');
  const [bootstrapEmail, setBootstrapEmail] = useState('');
  const [bootstrapPassword, setBootstrapPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginTotp, setLoginTotp] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [smtp, setSmtp] = useState<SmtpSettings>({ enabled: false, configured: false, host: '', port: 587, secure: false, username: '', fromName: 'FloodGuard', fromAddress: '', replyTo: '', hasPassword: false, lastTestAt: null, lastTestStatus: null });
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpTestRecipient, setSmtpTestRecipient] = useState('');
  const [sms, setSms] = useState<SmsSettings>({ enabled: false, configured: false, endpoint: '', authHeader: 'Authorization', authPrefix: 'Bearer ', senderId: '', toField: 'to', messageField: 'message', senderField: 'sender', hasToken: false, lastTestAt: null, lastTestStatus: null });
  const [smsToken, setSmsToken] = useState('');
  const [smsTestRecipient, setSmsTestRecipient] = useState('');
  const [members, setMembers] = useState<ConsoleMember[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');

  const loadConsoleData = async () => {
    const [providerResult, memberResult, auditResult] = await Promise.all([
      requestJson('/api/owner/providers'), requestJson('/api/owner/users'), requestJson('/api/owner/audit'),
    ]);
    setSmtp(providerResult.providers.smtp); setSms(providerResult.providers.sms);
    setMembers(memberResult.users); setAudit(auditResult.entries);
  };
  const refresh = async () => {
    setScreen('loading');
    try {
      const statusResult = await requestJson('/api/auth/status');
      setAuthStatus(statusResult);
      const sessionResponse = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      const sessionBody = await sessionResponse.json().catch(() => ({}));
      const currentCsrf = sessionBody.csrfToken || csrfCookie();
      setCsrf(currentCsrf);
      if (sessionResponse.ok && sessionBody.user) {
        setUser(sessionBody.user);
        if (sessionBody.user.role !== 'OWNER') { setScreen('blocked'); return; }
        if (!sessionBody.user.totpEnrolled || !sessionBody.user.mfaVerified) { setScreen('mfa'); return; }
        await loadConsoleData(); setScreen('console'); return;
      }
      setUser(null); setScreen(statusResult.bootstrapAvailable ? 'bootstrap' : statusResult.databaseConfigured ? 'login' : 'blocked');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load the security status.'); setScreen('blocked'); }
  };
  useEffect(() => { void refresh(); }, []);

  const secureRequest = async (path: string, method = 'GET', body?: unknown) => requestJson(path, method, body, csrf || csrfCookie());
  const establish = async (result: { user: ConsoleUser; mfaSetupRequired?: boolean; message?: string }) => {
    setUser(result.user); setCsrf(csrfCookie()); setMessage(result.message || '');
    if (result.user.role !== 'OWNER') { setScreen('blocked'); return; }
    if (result.mfaSetupRequired || !result.user.totpEnrolled || !result.user.mfaVerified) { setScreen('mfa'); return; }
    await loadConsoleData(); setScreen('console');
  };
  const bootstrap = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      const result = await requestJson('/api/auth/bootstrap', 'POST', { name: bootstrapName, email: bootstrapEmail, password: bootstrapPassword, token: bootstrapToken });
      setCsrf(result.csrfToken || csrfCookie()); await establish(result);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not bootstrap the owner account.'); }
    finally { setWorking(false); }
  };
  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      const result = await requestJson('/api/auth/login', 'POST', { email: loginEmail, password: loginPassword, ...(loginTotp ? { totp: loginTotp } : {}) });
      setCsrf(result.csrfToken || csrfCookie()); await establish(result);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setWorking(false); }
  };
  const startTotp = async () => {
    setWorking(true); setMessage('');
    try { const result = await secureRequest('/api/auth/totp/start', 'POST', {}); setTotpSecret(result.secret); setMessage('Copy the secret into an authenticator app, then confirm a current code.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not start authenticator setup.'); }
    finally { setWorking(false); }
  };
  const confirmTotp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      const result = await secureRequest('/api/auth/totp/confirm', 'POST', { code: totpCode });
      setMessage(result.message); setUser((current) => current ? { ...current, totpEnrolled: true, mfaVerified: true } : current);
      await loadConsoleData(); setScreen('console');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not verify the authenticator code.'); }
    finally { setWorking(false); }
  };
  const logout = async () => {
    setWorking(true);
    try { await secureRequest('/api/auth/logout', 'POST', {}); setUser(null); setScreen('login'); setMessage('Signed out securely.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-out failed.'); }
    finally { setWorking(false); }
  };
  const saveSmtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      const body = { ...smtp, password: smtpPassword };
      const result = await secureRequest('/api/owner/providers/smtp', 'PUT', body);
      setSmtp(result.providers.smtp); setSmtpPassword(''); setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save SMTP settings.'); }
    finally { setWorking(false); }
  };
  const saveSms = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage('');
    try {
      const result = await secureRequest('/api/owner/providers/sms', 'PUT', { ...sms, authToken: smsToken });
      setSms(result.providers.sms); setSmsToken(''); setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save SMS gateway settings.'); }
    finally { setWorking(false); }
  };
  const testSmtp = async () => {
    if (!window.confirm(smtpTestRecipient ? `Send a real test email to ${smtpTestRecipient}?` : 'Verify the SMTP connection without sending an email?')) return;
    setWorking(true); setMessage('');
    try { const result = await secureRequest('/api/owner/providers/smtp/test', 'POST', { recipient: smtpTestRecipient || undefined, confirmSend: true }); setMessage(result.message); await loadConsoleData(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SMTP test failed.'); }
    finally { setWorking(false); }
  };
  const testSms = async () => {
    if (!window.confirm(`This sends a real, potentially billable test SMS to ${smsTestRecipient}. Continue?`)) return;
    setWorking(true); setMessage('');
    try { const result = await secureRequest('/api/owner/providers/sms/test', 'POST', { recipient: smsTestRecipient, confirmSend: true }); setMessage(result.message); await loadConsoleData(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SMS test failed.'); }
    finally { setWorking(false); }
  };
  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setMessage(''); setInviteUrl('');
    try {
      const result = await secureRequest('/api/owner/invites', 'POST', { email: inviteEmail, name: inviteName });
      setInviteUrl(result.inviteUrl); setMessage(result.message); setInviteEmail(''); setInviteName(''); await loadConsoleData();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create the admin invite.'); }
    finally { setWorking(false); }
  };
  const toggleMember = async (member: ConsoleMember) => {
    if (!window.confirm(`${member.disabled ? 'Enable' : 'Disable'} ${member.email}?`)) return;
    setWorking(true); setMessage('');
    try { await secureRequest(`/api/owner/users/${encodeURIComponent(member.id)}`, 'PATCH', { disabled: !member.disabled }); await loadConsoleData(); setMessage('Account access updated and audited.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not update account access.'); }
    finally { setWorking(false); }
  };
  const resetMemberMfa = async (member: ConsoleMember) => {
    if (!window.confirm(`Reset MFA for ${member.email}? All of their existing sessions will be revoked.`)) return;
    setWorking(true); setMessage('');
    try { const result = await secureRequest(`/api/owner/users/${encodeURIComponent(member.id)}/mfa/reset`, 'POST', {}); await loadConsoleData(); setMessage(result.message); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not reset MFA.'); }
    finally { setWorking(false); }
  };
  const copyInvite = async () => { try { await navigator.clipboard.writeText(inviteUrl); setMessage('One-time invitation link copied.'); } catch { setMessage('Copy the one-time link manually and send it through a secure channel.'); } };

  return <main className="hacker-admin-page page-width">
    <div className="hacker-admin-shell">
      <aside className="hacker-admin-rail"><Link to="/" className="admin-brand"><FloodGuardMark small /><span>FLOODGUARD<small>CONTROL PLANE</small></span></Link><div className="admin-rail-line"></div><span className="admin-rail-caption">PRIVILEGED SYSTEM</span><div className="admin-rail-foot"><i></i> AUDIT ACTIVE<br /><small>TURSO · TOTP · CSRF</small></div></aside>
      <section className="hacker-admin-main">
        <div className="hacker-admin-topbar"><div><span className="admin-slash-label"><i></i> HACKERADMIN / SUPER-ADMIN</span><h1>System control room</h1></div><div className="admin-top-actions"><span className={`admin-secure-pill ${screen === 'console' ? 'is-secure' : ''}`}><ShieldCheck size={13} />{screen === 'console' ? 'MFA VERIFIED' : 'LOCKED BY DEFAULT'}</span>{user && <button className="admin-quiet-button" onClick={() => void logout()} disabled={working}>Sign out <LockKeyhole size={13} /></button>}</div></div>
        {message && <div className="admin-global-message" role="status">{message}</div>}
        {screen === 'loading' && <div className="admin-center-card"><span className="loading-spinner"></span><strong>Checking database and access policy…</strong></div>}
        {screen === 'blocked' && <div className="admin-center-card admin-denied"><LockKeyhole size={28} /><h2>Control plane is not available.</h2><p>{!authStatus?.databaseConfigured ? 'Turso is not configured. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, run the seed script, then restart the server.' : 'This account is not an OWNER, the database is not seeded, or this source IP is not allowlisted. Ask the super-admin to review access.'}</p><Link to="/login" className="admin-primary-button">Open sign-in <ArrowRight size={14} /></Link><button className="admin-quiet-button" onClick={() => void refresh()}>Retry status</button></div>}
        {screen === 'bootstrap' && <div className="admin-setup-grid"><div className="admin-auth-card"><span className="section-kicker">ONE-TIME BOOTSTRAP</span><h2>Create the first super-admin.</h2><p>This requires the one-time OWNER_BOOTSTRAP_TOKEN from the private deployment environment. It closes permanently after the first Owner record is created.</p><form className="admin-form" onSubmit={(event) => void bootstrap(event)}><label>Display name<input required minLength={2} maxLength={100} value={bootstrapName} onChange={(event) => setBootstrapName(event.target.value)} /></label><label>Owner email<input type="email" required maxLength={254} value={bootstrapEmail} onChange={(event) => setBootstrapEmail(event.target.value)} /></label><label>Strong password<input type="password" required minLength={12} maxLength={128} value={bootstrapPassword} onChange={(event) => setBootstrapPassword(event.target.value)} /></label><label>One-time bootstrap token<input type="password" required minLength={32} maxLength={256} value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} autoComplete="off" /></label><button className="admin-primary-button" disabled={working}>{working ? 'Creating secure account…' : 'Create super-admin'} <ArrowRight size={14} /></button></form></div><div className="admin-side-note"><TriangleAlert size={18} /><strong>Setup checklist</strong><span>1 · Create Turso database + token</span><span>2 · Configure SETTINGS_ENCRYPTION_KEY</span><span>3 · Set OWNER_BOOTSTRAP_TOKEN (32+ random chars)</span><span>4 · Seed demo tenant + device keys</span><span>5 · Restrict ADMIN_CIDR_ALLOWLIST</span></div></div>}
        {screen === 'login' && <div className="admin-setup-grid"><div className="admin-auth-card"><span className="section-kicker">OWNER AUTHENTICATION</span><h2>Sign in to Hackeradmin.</h2><p>Owner sessions expire after four hours. An authenticator code is required after enrollment.</p><form className="admin-form" onSubmit={(event) => void signIn(event)}><label>Email address<input type="email" autoComplete="username" required value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" required value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} /></label><label>Authenticator code <small>(leave blank only during first MFA setup)</small><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={loginTotp} onChange={(event) => setLoginTotp(event.target.value)} placeholder="000000" /></label><button className="admin-primary-button" disabled={working}>{working ? 'Verifying…' : 'Continue securely'} <ArrowRight size={14} /></button></form><Link className="admin-auth-link" to="/login">Use the shared sign-in page</Link></div><div className="admin-side-note"><LockKeyhole size={18} /><strong>No default credentials</strong><span>There is no shipped password or bypass route.</span><span>Owner APIs require MFA, CSRF and the configured IP allowlist.</span><span><Link to="/guides/architecture">Read security notes <ArrowUpRight size={13} /></Link></span></div></div>}
        {screen === 'mfa' && <div className="admin-mfa-card"><div className="admin-mfa-icon"><ShieldCheck size={22} /></div><span className="section-kicker">MANDATORY ADMIN MFA</span><h2>Protect this super-admin account.</h2><p>Use an authenticator app supporting standard six-digit TOTP. This secret is shown once; store it in your secure authenticator, never in source control.</p>{!totpSecret ? <button className="admin-primary-button" onClick={() => void startTotp()} disabled={working}>{working ? 'Preparing…' : 'Start authenticator setup'} <ArrowRight size={14} /></button> : <><div className="totp-secret-box"><small>AUTHENTICATOR SECRET</small><strong>{totpSecret}</strong><span>Or use this URI in a trusted authenticator: <code>otpauth://totp/FloodGuard…</code></span></div><form className="admin-form" onSubmit={(event) => void confirmTotp(event)}><label>Current six-digit code<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={totpCode} onChange={(event) => setTotpCode(event.target.value)} autoComplete="one-time-code" /></label><button className="admin-primary-button" disabled={working || totpCode.length !== 6}>{working ? 'Checking code…' : 'Verify and open console'} <Check size={14} /></button></form></>}</div>}
        {screen === 'console' && user && <>
          <div className="admin-session-ribbon"><span><i></i> SIGNED IN AS <strong>{user.displayName}</strong></span><span>{user.role} · {user.email} · TOTP VERIFIED</span></div>
          <nav className="admin-tabs" aria-label="Hackeradmin sections">{([['overview','Overview'],['providers','Provider gateways'],['admins','Super-admins'],['audit','Audit trail']] as const).map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'providers' && <span className="tab-slash">/</span>}</button>)}</nav>
          {tab === 'overview' && <div className="admin-overview-grid"><article className="admin-overview-card admin-card-feature"><span className="admin-card-kicker">SECURE SERVER CONFIGURATION</span><h2>Providers are encrypted at rest.</h2><p>SMTP and SMS gateway credentials are stored in Turso using AES-256-GCM. The encryption key stays in the server environment; saved secrets are never returned to the browser.</p><button className="admin-primary-button" onClick={() => setTab('providers')}>Configure gateways <ArrowRight size={14} /></button></article><article className="admin-stat-card"><small>ACTIVE SUPER-ADMINS</small><strong>{members.filter((member) => member.role === 'OWNER' && !member.disabled).length}</strong><span>Last owner cannot be disabled</span></article><article className="admin-stat-card"><small>SMTP STATUS</small><strong className={smtp.configured ? 'status-enabled' : ''}>{smtp.configured ? 'READY' : 'NOT SET'}</strong><span>{smtp.lastTestStatus || 'No test run yet'}</span></article><article className="admin-stat-card"><small>SMS GATEWAY</small><strong className={sms.configured ? 'status-enabled' : ''}>{sms.configured ? 'READY' : 'NOT SET'}</strong><span>{sms.lastTestStatus || 'No test run yet'}</span></article><article className="admin-stat-card"><small>SECURITY POSTURE</small><strong className="status-enabled">MFA + CIDR</strong><span>Admin actions are audited</span></article></div>}
          {tab === 'providers' && <div className="provider-grid">
            <section className="admin-provider-card"><div className="provider-card-heading"><span className="provider-index">01 / SMTP</span><span className={`provider-state ${smtp.configured ? 'online' : ''}`}><i></i>{smtp.configured ? 'ACTIVE' : 'DISABLED'}</span></div><h2>Email transport</h2><p>Configure a standard SMTP relay. Passwords are encrypted and only replaced when a new value is submitted.</p><form className="admin-form provider-form" onSubmit={(event) => void saveSmtp(event)}><div className="provider-field-pair"><label>SMTP host<input required maxLength={255} value={smtp.host} onChange={(event) => setSmtp({ ...smtp, host: event.target.value })} placeholder="smtp.example.com" /></label><label>Port<input required type="number" min={1} max={65535} value={smtp.port} onChange={(event) => setSmtp({ ...smtp, port: Number(event.target.value) })} /></label></div><div className="provider-field-pair"><label>Username<input autoComplete="username" value={smtp.username} onChange={(event) => setSmtp({ ...smtp, username: event.target.value })} /></label><label>Password<input type="password" autoComplete="new-password" value={smtpPassword} onChange={(event) => setSmtpPassword(event.target.value)} placeholder={smtp.hasPassword ? 'Saved — blank keeps current password' : 'SMTP password or app password'} /></label></div><label>From name<input required value={smtp.fromName} maxLength={100} onChange={(event) => setSmtp({ ...smtp, fromName: event.target.value })} /></label><label>From email<input required type="email" value={smtp.fromAddress} onChange={(event) => setSmtp({ ...smtp, fromAddress: event.target.value })} placeholder="alerts@example.org" /></label><label>Reply-to email<input type="email" value={smtp.replyTo} onChange={(event) => setSmtp({ ...smtp, replyTo: event.target.value })} /></label><label className="admin-check-row"><input type="checkbox" checked={smtp.secure} onChange={(event) => setSmtp({ ...smtp, secure: event.target.checked })} /> Use implicit TLS (usually port 465)</label><label className="admin-check-row"><input type="checkbox" checked={smtp.enabled} onChange={(event) => setSmtp({ ...smtp, enabled: event.target.checked })} /> Enable email delivery</label><button className="admin-primary-button" type="submit" disabled={working}>{working ? 'Saving…' : 'Save encrypted SMTP settings'} <Check size={14} /></button></form><div className="provider-test-row"><input type="email" value={smtpTestRecipient} onChange={(event) => setSmtpTestRecipient(event.target.value)} placeholder="Optional test recipient" /><button className="admin-quiet-button" onClick={() => void testSmtp()} disabled={working}>Verify / send test</button></div><small className="provider-test-status">{smtp.lastTestStatus || 'Never tested'}</small></section>
            <section className="admin-provider-card"><div className="provider-card-heading"><span className="provider-index">02 / SMS HTTP</span><span className={`provider-state ${sms.configured ? 'online' : ''}`}><i></i>{sms.configured ? 'ACTIVE' : 'DISABLED'}</span></div><h2>SMS gateway</h2><p>Connect an HTTPS JSON gateway. The test button sends a real message and may incur carrier/provider charges.</p><form className="admin-form provider-form" onSubmit={(event) => void saveSms(event)}><label>Gateway HTTPS endpoint<input required type="url" value={sms.endpoint} onChange={(event) => setSms({ ...sms, endpoint: event.target.value })} placeholder="https://api.provider.example/messages" /></label><div className="provider-field-pair"><label>Auth header<input value={sms.authHeader} maxLength={64} onChange={(event) => setSms({ ...sms, authHeader: event.target.value })} /></label><label>Auth prefix<input value={sms.authPrefix} maxLength={40} onChange={(event) => setSms({ ...sms, authPrefix: event.target.value })} placeholder="Bearer " /></label></div><label>API token<input type="password" autoComplete="new-password" value={smsToken} onChange={(event) => setSmsToken(event.target.value)} placeholder={sms.hasToken ? 'Saved — blank keeps current token' : 'Gateway API token'} /></label><label>Sender ID<input value={sms.senderId} maxLength={64} onChange={(event) => setSms({ ...sms, senderId: event.target.value })} placeholder="FloodGuard" /></label><div className="provider-field-pair"><label>Recipient JSON key<input value={sms.toField} onChange={(event) => setSms({ ...sms, toField: event.target.value })} /></label><label>Message JSON key<input value={sms.messageField} onChange={(event) => setSms({ ...sms, messageField: event.target.value })} /></label></div><label>Sender JSON key<input value={sms.senderField} onChange={(event) => setSms({ ...sms, senderField: event.target.value })} /></label><label className="admin-check-row"><input type="checkbox" checked={sms.enabled} onChange={(event) => setSms({ ...sms, enabled: event.target.checked })} /> Enable SMS delivery</label><button className="admin-primary-button" type="submit" disabled={working}>{working ? 'Saving…' : 'Save encrypted SMS settings'} <Check size={14} /></button></form><div className="provider-test-row"><input type="tel" value={smsTestRecipient} onChange={(event) => setSmsTestRecipient(event.target.value)} placeholder="+8801XXXXXXXXX" /><button className="admin-quiet-button" onClick={() => void testSms()} disabled={working || !smsTestRecipient}>Send paid test SMS</button></div><small className="provider-test-status">{sms.lastTestStatus || 'Never tested'} · E.164 phone required</small></section>
          </div>}
          {tab === 'admins' && <div className="admin-users-layout"><section className="admin-provider-card"><span className="provider-index">03 / PRIVILEGED USERS</span><h2>Invite another super-admin.</h2><p>New super-admin accounts are invite-only. The one-time link is displayed once; share it out of band. Every invited owner must enroll TOTP before administration.</p><form className="admin-form" onSubmit={(event) => void createInvite(event)}><label>Display name<input required minLength={2} maxLength={100} value={inviteName} onChange={(event) => setInviteName(event.target.value)} /></label><label>Email address<input type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /></label><button className="admin-primary-button" disabled={working}>{working ? 'Creating invite…' : 'Generate one-time invite'} <ArrowRight size={14} /></button></form>{inviteUrl && <div className="invite-output"><small>ONE-TIME LINK · EXPIRES IN 48 HOURS</small><code>{inviteUrl}</code><button className="admin-quiet-button" onClick={() => void copyInvite()}>Copy link</button></div>}</section><section className="admin-provider-card admin-member-list"><div className="provider-card-heading"><span className="provider-index">CURRENT ADMIN ACCOUNTS</span><span>{members.length} USERS</span></div>{members.map((member) => <article className="admin-member-row" key={member.id}><span className="member-avatar">{member.displayName.slice(0,1).toUpperCase()}</span><span className="member-main"><strong>{member.displayName}</strong><small>{member.email} · {member.role}</small></span><span className={`member-mfa ${member.totpEnrolled ? 'ok' : ''}`}>{member.totpEnrolled ? 'MFA ON' : 'MFA PENDING'}</span>{member.totpEnrolled && <button className="admin-quiet-button" disabled={working || member.id === user.id} onClick={() => void resetMemberMfa(member)}>Reset MFA</button>}<button className="admin-quiet-button" disabled={working || (member.role === 'OWNER' && !member.disabled && members.filter((item) => item.role === 'OWNER' && !item.disabled).length <= 1)} onClick={() => void toggleMember(member)}>{member.disabled ? 'Enable' : 'Disable'}</button></article>)}</section></div>}
          {tab === 'audit' && <section className="admin-provider-card admin-audit-card"><div className="provider-card-heading"><span className="provider-index">04 / IMMUTABLE EVENTS</span><span>{audit.length} RECENT ENTRIES</span></div><h2>Admin audit trail</h2><p>Provider edits, authentication, invitations and account changes are recorded with actor, target, time and source IP.</p><div className="admin-audit-list">{audit.map((entry) => <article key={entry.id}><span className="audit-line-mark">/</span><div><strong>{entry.action}</strong><small>{entry.actorEmail} · {entry.targetType}{entry.targetId ? `:${entry.targetId}` : ''}</small></div><time>{formatTime(entry.createdAt,{ dateStyle: 'medium', timeStyle: 'short' })}</time><code>{entry.ipAddress || '—'}</code></article>)}{audit.length === 0 && <p className="admin-empty">No audit events have been recorded yet.</p>}</div></section>}
        </>}
      </section>
    </div>
  </main>;
}

function MaintenancePage() {
  return <main className="maintenance-page page-width"><div className="maintenance-art"><div><Waves size={47} /><span></span><span></span></div></div><span className="section-kicker">TEMPORARY READ-ONLY MODE</span><h1>FloodGuard is in maintenance.</h1><p>This demo is currently a static, simulated preview. No live sensor data is ingested, and actuator controls are not available on this page.</p><Link to="/app" className="button button-lime">Open the safe simulation <ArrowRight size={15} /></Link></main>;
}

function PolicyPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const privacy = kind === 'privacy';
  return <main className="inner-page page-width policy-page"><span className="section-kicker">PROJECT POLICY</span><h1>{privacy ? 'Privacy note' : 'Terms & limitations'}</h1><p className="policy-lede">{privacy ? 'The public demo does not ask for an account, email address, location permission or push permission.' : 'FloodGuard is a student science-fair concept and educational prototype—not a product or public safety service.'}</p><section className="policy-block"><h2>{privacy ? 'Data in this preview' : 'No emergency use'}</h2><p>{privacy ? 'Dashboard readings and events are generated demo data stored by the local API. No analytics, marketing tracker, camera, microphone or geolocation feature is enabled. API telemetry is not cached offline.' : 'Do not use this prototype to protect people, buildings, roads or critical infrastructure. Do not rely on simulated states for warnings or evacuation decisions. Follow local emergency management and official flood guidance.'}</p></section><section className="policy-block"><h2>{privacy ? 'Optional integrations' : 'Hardware safety'}</h2><p>{privacy ? 'Turso, email, SMS, Web Push, device credentials and owner accounts are not configured in this preview. Deployments that enable them must use valid consent, access controls, clear retention rules and securely managed secrets.' : 'A physical model requires shallow contained water, low-voltage power, a correctly rated servo supply, a normally-closed latching E-stop, guard rails and supervised testing. Verify wiring for the exact board and sensor revisions.'}</p></section><Link to="/about" className="arrow-link">Read the complete project brief <ArrowRight size={15} /></Link></main>;
}

function NotFoundPage() {
  return <main className="maintenance-page page-width"><span className="not-found-code">404</span><h1>That route is not in the build plan.</h1><p>Head back to the project overview or open the simulation workspace.</p><div className="not-found-actions"><Link to="/" className="button button-quiet"><ArrowLeft size={15} /> Home</Link><Link to="/app" className="button button-lime">Dashboard <ArrowRight size={15} /></Link></div></main>;
}

export default App;
