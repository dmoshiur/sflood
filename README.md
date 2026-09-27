# sflood

**A clearer view of the water ahead.** sflood is a single-app flood-intelligence prototype: a responsive public-facing site, a sample monitoring dashboard, and a small custom backend served together by one Node.js process.

> **Demo only.** The map, gauge levels, trends, rainfall, and watch signals are fictional sample data. This is not a live warning service, is not monitored, and must not be used for emergency or operational decisions.

## Run locally

Requires Node.js 18 or newer. There are no third-party runtime dependencies.

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). To choose a different port or bind address:

```bash
PORT=8080 HOST=0.0.0.0 npm start
```

`npm run dev` restarts the built-in server when files change. Run the checks with `npm test`.

The Node server serves the website from `public/` and exposes the JSON API from the same origin. Submitted observations and email-interest records are stored in `data/store.json` (created automatically and ignored by Git). Set `DATA_FILE=/path/to/store.json` to use another local file.

## What is included

- Custom sflood SVG wordmark and matching favicon.
- Responsive, accessible landing page with a fictional river-network visualization, sample dashboard, product overview, and community forms.
- One built-in Node HTTP backend for both the frontend and API; no separate frontend service or third-party package is required.
- Server-side input checks, an 8 KB JSON request limit, basic in-memory observation rate limiting, atomic local JSON writes, and standard browser security headers.
- Automated API and input-validation tests.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Check that the app is responding. |
| `GET` | `/api/dashboard` | Return the clearly labelled sample network, summary, and watchlist. |
| `GET` | `/api/reports` | Return the latest saved community observations. |
| `POST` | `/api/reports` | Validate and save a non-emergency observation. JSON fields: `location`, `category`, `condition`, `details`, and optional `name`. |
| `POST` | `/api/subscribe` | Validate and save an email address locally. No email is sent. |

Example observation:

```json
{
  "location": "Example footbridge",
  "category": "standing-water",
  "condition": "watching",
  "details": "Water is covering part of the path beside the bridge.",
  "name": "Local observer"
}
```

Allowed categories: `standing-water`, `road-flooding`, `river-level`, `drainage`, `other`. Allowed conditions: `watching`, `concerning`, `urgent`.

## Before production use

This repository started with only a minimal README; no product brief, map dataset, or source design file was present. The demo therefore uses fictional, clearly labelled monitoring data and a visual identity based on the `sflood` name. Before using it with real communities or infrastructure, connect verified sensor/forecast providers, set local thresholds and map data, and add authentication, role-based access, durable database backups, privacy/retention controls, abuse protection, operational monitoring, and reviewed emergency-service guidance. The observation endpoint is currently an unauthenticated demo intake form and does not trigger notifications or dispatch.
