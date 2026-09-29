import { Link } from 'react-router-dom';
import { Card } from '../components/ui';

export default function NotFoundPage() {
  return (
    <Card title="Page not found">
      <p className="muted">That route does not exist. Try the live status page or the dashboard.</p>
      <div className="row">
        <Link className="btn" to="/">Home</Link>
        <Link className="btn secondary" to="/status">Live status</Link>
        <Link className="btn secondary" to="/app">Dashboard</Link>
      </div>
    </Card>
  );
}
