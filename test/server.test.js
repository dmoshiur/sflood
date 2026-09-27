'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createServer, validateReport, validateSubscription } = require('../server');

const validReport = {
  location: 'Example footbridge',
  category: 'standing-water',
  condition: 'watching',
  details: 'Water is covering part of the path beside the bridge.',
  name: 'Local observer',
};

test('validates observations and email addresses', () => {
  assert.deepEqual(validateReport(validReport), validReport);
  assert.equal(validateSubscription({ email: '  River.User@example.org  ' }), 'river.user@example.org');
  assert.throws(() => validateReport({ ...validReport, category: '<script>' }), /observation type/);
  assert.throws(() => validateReport({ ...validReport, details: 'short' }), /at least 10 characters/);
  assert.throws(() => validateSubscription({ email: 'not-an-email' }), /valid email/);
});

test('serves the site and persists demo API submissions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sflood-test-'));
  const dataFile = path.join(directory, 'nested', 'store.json');
  const server = createServer({ dataFile });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${base}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).status, 'ok');

  const dashboardResponse = await fetch(`${base}/api/dashboard`);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.mode, 'demo');
  assert.equal(dashboard.summary.stationsOnline, 6);
  assert.equal(dashboard.stations.length, 6);

  const htmlResponse = await fetch(base);
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await htmlResponse.text(), /A clearer view of the water/);

  const invalidResponse = await fetch(`${base}/api/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validReport, details: '' }),
  });
  assert.equal(invalidResponse.status, 400);

  const reportResponse = await fetch(`${base}/api/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validReport),
  });
  assert.equal(reportResponse.status, 201);
  const savedReport = (await reportResponse.json()).report;
  assert.equal(savedReport.status, 'Received');
  assert.equal(savedReport.location, validReport.location);

  const listResponse = await fetch(`${base}/api/reports`);
  const reportList = await listResponse.json();
  assert.equal(reportList.reports.length, 1);
  assert.equal(reportList.reports[0].id, savedReport.id);

  const updatedDashboard = await (await fetch(`${base}/api/dashboard`)).json();
  assert.equal(updatedDashboard.summary.reportsToday, 1);

  const emailResponse = await fetch(`${base}/api/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Team@example.org' }),
  });
  assert.equal(emailResponse.status, 201);
  assert.equal((await emailResponse.json()).saved, true);

  const duplicateResponse = await fetch(`${base}/api/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'team@example.org' }),
  });
  assert.equal((await duplicateResponse.json()).alreadySaved, true);
  assert.ok(fs.existsSync(dataFile));
});
