import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity, Bell, Cpu, LayoutDashboard, LogIn, LogOut, MapPin, Radar, ShieldAlert, ShieldCheck, Sliders, User as UserIcon,
} from 'lucide-react';
import { api, setCsrfToken, type AuthUser } from './api';
import { Card, Loading, Notice } from './components/ui';
import LandingPage from './pages/Landing';
import StatusPage from './pages/Status';
import AuthPages from './pages/Auth';
import DashboardPage from './pages/Dashboard';
import DevicesPage from './pages/Devices';
import AlertsPage from './pages/Alerts';
import ProfilePage from './pages/Profile';
import SimulationPage from './pages/Simulation';
import AdminPage from './pages/Admin';
import SiteBuilderPage from './pages/SiteBuilder';
import HackerAdminPage from './pages/HackerAdmin';
import NotFoundPage from './pages/NotFound';

/* ----------------------------- auth context ----------------------------- */

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string, totp?: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null, loading: true, refresh: async () => {}, login: async () => ({} as AuthUser), logout: async () => {},
});

export function useAuth() { return useContext(AuthContext); }

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.me();
      setCsrfToken(result.csrfToken);
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string, totp?: string) => {
    const result = await api.login(email, password, totp);
    setCsrfToken(result.csrfToken);
    setUser(result.user);
    return result.user;
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* session already gone */ }
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, refresh, login, logout }), [user, loading, refresh, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* -------------------------------- layout -------------------------------- */

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const isOps = location.pathname.startsWith('/hackeradmin');
  const staff = Boolean(user && ['OPERATOR', 'ADMIN', 'OWNER'].includes(user.role));

  useEffect(() => {
    if ('serviceWorker' in navigator && import.meta.env.PROD) {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

  return (
    <div className={`app-shell${isOps ? ' ops' : ''}`}>
      <header className="topbar">
        <Link className="brand" to="/">
          <ShieldCheck size={22} aria-hidden />
          <span>
            FloodGrid
            <small>Smart Flood Control</small>
          </span>
        </Link>
        <nav aria-label="Primary">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/status">Live status</NavLink>
          <NavLink to="/devices">Devices</NavLink>
          {user && <NavLink to="/app">Dashboard</NavLink>}
          {staff && <NavLink to="/admin">Admin</NavLink>}
          {user?.role === 'OWNER' && <NavLink to="/hackeradmin">Operations</NavLink>}
        </nav>
        <span className="spacer" />
        {user ? (
          <>
            <NotificationBell />
            <Link className="icon-button" to="/app/profile" title={user.email}>
              <UserIcon size={15} aria-hidden /> {user.displayName}
            </Link>
            <button type="button" className="icon-button" onClick={() => void logout()}>
              <LogOut size={15} aria-hidden /> Sign out
            </button>
          </>
        ) : (
          <Link className="icon-button" to="/login">
            <LogIn size={15} aria-hidden /> Sign in
          </Link>
        )}
      </header>

      <div className="app-body">
        <aside className="sidebar" aria-label="Sections">
          <div className="section">Monitoring</div>
          <NavLink to="/status"><Radar size={16} aria-hidden /> Public status</NavLink>
          <NavLink to="/app"><LayoutDashboard size={16} aria-hidden /> Live dashboard</NavLink>
          <NavLink to="/app/alerts"><Bell size={16} aria-hidden /> Alert timeline</NavLink>
          <NavLink to="/devices"><Cpu size={16} aria-hidden /> Devices &amp; firmware</NavLink>
          {user && <NavLink to="/app/profile"><UserIcon size={16} aria-hidden /> Profile</NavLink>}
          {staff && (
            <>
              <div className="section">Operations</div>
              <NavLink to="/app/devices"><Cpu size={16} aria-hidden /> Device registry</NavLink>
              <NavLink to="/app/simulation"><Activity size={16} aria-hidden /> Simulation</NavLink>
              <NavLink to="/admin"><Sliders size={16} aria-hidden /> Admin console</NavLink>
              {user?.role === 'OWNER' && <NavLink to="/hackeradmin"><ShieldAlert size={16} aria-hidden /> Operations console</NavLink>}
            </>
          )}
        </aside>
        <main className="content wide">{children}</main>
      </div>

      <nav className="bottomnav" aria-label="Mobile navigation">
        <NavLink to="/" end><MapPin size={18} aria-hidden /> Home</NavLink>
        <NavLink to="/status"><Radar size={18} aria-hidden /> Live</NavLink>
        <NavLink to="/devices"><Cpu size={18} aria-hidden /> Devices</NavLink>
        <NavLink to="/app/alerts"><Bell size={18} aria-hidden /> Alerts</NavLink>
        {user ? <NavLink to="/app/profile"><UserIcon size={18} aria-hidden /> More</NavLink> : <NavLink to="/login"><LogIn size={18} aria-hidden /> More</NavLink>}
      </nav>

      <footer className="footer">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>
            FloodGrid — Smart Flood Control &amp; Automation. Educational prototype: <strong>not</strong> a real flood defence or emergency warning service.
          </span>
          <span className="subtle">
            <Link to="/status">Live status</Link> · <Link to="/devices">Devices</Link> · <Link to="/login">Sign in</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------- notification bell --------------------------- */

interface BellItem { id: string; title: string; body: string; url: string; severity: string; createdAt: string; read: boolean }

function NotificationBell() {
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BellItem[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const result = await api.notifications();
      setUnread(result.unread);
      setItems(result.notifications);
    } catch { /* notifications are non-critical */ }
  }, [user]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 45_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!user) return null;

  return (
    <span style={{ position: 'relative' }}>
      <button type="button" className="icon-button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`Notifications, ${unread} unread`}>
        <Bell size={15} aria-hidden /> {unread > 0 && <span>{unread}</span>}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: '2.4rem', width: 320, zIndex: 60, maxHeight: 380, overflowY: 'auto' }}>
          <div className="card-head">
            <h3>Notifications</h3>
            <button type="button" className="btn secondary small" onClick={() => void api.markAllNotificationsRead().then(load)}>Mark all read</button>
          </div>
          {items.length === 0 && <p className="muted">No notifications yet.</p>}
          {items.map((item) => (
            <div key={item.id} style={{ borderTop: '1px solid var(--border)', padding: '0.55rem 0' }}>
              <strong style={{ fontSize: '0.9rem' }}>{item.title}</strong>
              <p className="muted" style={{ margin: '0.15rem 0', fontSize: '0.82rem' }}>{item.body}</p>
              <span className="subtle" style={{ fontSize: '0.74rem' }}>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/* ------------------------------- routing -------------------------------- */

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Array<AuthUser['role']> }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) {
    return (
      <Card title="Access restricted">
        <Notice tone="warning">Your account role does not include this console. Ask a super admin for the correct role.</Notice>
      </Card>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/status" element={<StatusPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/login" element={<AuthPages mode="login" />} />
            <Route path="/register" element={<AuthPages mode="register" />} />
            <Route path="/reset-password" element={<AuthPages mode="reset" />} />
            <Route path="/accept-invite" element={<AuthPages mode="invite" />} />
            <Route path="/app" element={<RequireAuth><DashboardPage /></RequireAuth>} />
            <Route path="/app/alerts" element={<RequireAuth><AlertsPage /></RequireAuth>} />
            <Route path="/app/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
            <Route path="/app/devices" element={<RequireAuth roles={['OPERATOR', 'ADMIN', 'OWNER']}><DevicesPage manage /></RequireAuth>} />
            <Route path="/app/simulation" element={<RequireAuth roles={['ADMIN', 'OWNER']}><SimulationPage /></RequireAuth>} />
            <Route path="/admin" element={<RequireAuth roles={['ADMIN', 'OWNER']}><AdminPage /></RequireAuth>} />
            <Route path="/admin/pages" element={<RequireAuth roles={['ADMIN', 'OWNER']}><SiteBuilderPage /></RequireAuth>} />
            <Route path="/hackeradmin" element={<RequireAuth roles={['OWNER']}><HackerAdminPage /></RequireAuth>} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AuthProvider>
  );
}
