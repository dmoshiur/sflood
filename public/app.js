'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    credentials: 'same-origin',
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The service returned an unreadable response.');
  }
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
}

function statusClass(status) {
  if (status === 'Elevated') return 'state-elevated';
  if (status === 'Watch') return 'state-watch';
  return 'state-normal';
}

function trendLabel(trend) {
  if (trend === 'Rising') return { arrow: '↑', className: 'trend-up' };
  if (trend === 'Falling') return { arrow: '↓', className: 'trend-down' };
  return { arrow: '→', className: 'trend-steady' };
}

function relativeAge(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 'moments ago';
  return `${Math.round(value)} min ago`;
}

function renderStations(stations) {
  const target = $('#station-rows');
  if (!target) return;
  if (!Array.isArray(stations) || stations.length === 0) {
    target.innerHTML = '<tr><td colspan="4" class="loading-row">No sample stations are configured.</td></tr>';
    return;
  }

  target.innerHTML = stations.map((station) => {
    const trend = trendLabel(station.trend);
    const level = Number(station.levelM);
    const levelText = Number.isFinite(level) ? level.toFixed(2) : '—';
    return `<tr>
      <td><span class="station-primary">${escapeHtml(station.name)}</span><span class="station-secondary">${escapeHtml(station.river)}</span></td>
      <td>${levelText}</td>
      <td class="${trend.className}">${trend.arrow} ${escapeHtml(station.trend)}</td>
      <td><span class="state-pill ${statusClass(station.status)}">${escapeHtml(station.status)}</span></td>
    </tr>`;
  }).join('');
}

function renderAlerts(alerts) {
  const target = $('#alert-list');
  const count = $('#alert-count');
  if (!target) return;
  const items = Array.isArray(alerts) ? alerts : [];
  if (count) count.textContent = String(items.length);
  if (items.length === 0) {
    target.innerHTML = '<p class="loading-row">No sample watch signals right now.</p>';
    return;
  }
  target.innerHTML = items.map((alert) => {
    const level = alert.level === 'Elevated' ? 'elevated' : 'watch';
    return `<article class="alert-item">
      <span class="alert-marker ${level}" aria-hidden="true"></span>
      <div class="alert-copy">
        <h4>${escapeHtml(alert.title)}</h4>
        <p>${escapeHtml(alert.message)}</p>
        <div class="alert-meta"><span>${escapeHtml(alert.level)} · sample</span><span>${escapeHtml(relativeAge(alert.updatedMinutesAgo))}</span></div>
      </div>
    </article>`;
  }).join('');
}

async function loadDashboard() {
  const updated = $('#last-updated');
  try {
    const dashboard = await requestJson('/api/dashboard');
    const summary = dashboard.summary || {};
    $('#metric-stations').textContent = String(summary.stationsOnline ?? '—');
    $('#metric-elevated').textContent = String(summary.elevatedStations ?? '—');
    $('#metric-reports').textContent = String(summary.reportsToday ?? '—');
    renderStations(dashboard.stations);
    renderAlerts(dashboard.alerts);
    if (updated) {
      const fetchedAt = dashboard.updatedAt ? new Date(dashboard.updatedAt) : null;
      const displayTime = fetchedAt && !Number.isNaN(fetchedAt.valueOf())
        ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(fetchedAt)
        : 'just now';
      updated.textContent = `Sample response · fetched ${displayTime}`;
    }
  } catch (error) {
    $('#metric-stations').textContent = '—';
    $('#metric-elevated').textContent = '—';
    $('#metric-reports').textContent = '—';
    $('#station-rows').innerHTML = '<tr><td colspan="4" class="loading-row">The demo service is not available. Start the app server and refresh.</td></tr>';
    $('#alert-list').innerHTML = '<p class="loading-row">Could not load the sample watchlist.</p>';
    if (updated) updated.textContent = 'Local service unavailable';
    console.error('Could not load the sflood demo dashboard:', error);
  }
}

function setFormStatus(target, message, kind = '') {
  target.textContent = message;
  target.classList.remove('is-error', 'is-success');
  if (kind) target.classList.add(`is-${kind}`);
}

function setupReportForm() {
  const form = $('#report-form');
  const status = $('#report-status');
  const detailField = form?.elements.namedItem('details');
  const count = $('#detail-count');
  if (!form || !status) return;

  detailField?.addEventListener('input', () => {
    if (count) count.textContent = String(detailField.value.length);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormStatus(status, '');
    if (!form.checkValidity()) {
      const invalidField = form.querySelector(':invalid');
      setFormStatus(status, 'Please complete the required fields and check the details.', 'error');
      invalidField?.focus();
      form.reportValidity();
      return;
    }

    const submitButton = form.querySelector('[type="submit"]');
    const originalLabel = submitButton.innerHTML;
    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const result = await requestJson('/api/reports', { method: 'POST', body: JSON.stringify(data) });
      form.reset();
      if (count) count.textContent = '0';
      setFormStatus(status, `${result.message} This demo is not monitored or reviewed.`, 'success');
      await loadDashboard();
    } catch (error) {
      setFormStatus(status, error.message || 'Could not save the observation. Please try again.', 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = originalLabel;
    }
  });
}

function setupSubscribeForm() {
  const form = $('#subscribe-form');
  const status = $('#subscribe-status');
  const email = $('#subscribe-email');
  if (!form || !status || !email) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormStatus(status, '');
    if (!email.checkValidity() || !email.value.trim()) {
      setFormStatus(status, 'Enter a valid email address.', 'error');
      email.focus();
      email.reportValidity();
      return;
    }
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await requestJson('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ email: email.value.trim() }),
      });
      setFormStatus(status, result.alreadySaved ? 'That address is already saved in this demo.' : 'Saved locally—no email has been sent.', 'success');
      form.reset();
    } catch (error) {
      setFormStatus(status, error.message || 'Could not save your interest. Please try again.', 'error');
    } finally {
      button.disabled = false;
    }
  });
}

function setupMobileNavigation() {
  const toggle = $('.menu-toggle');
  const nav = $('#primary-nav');
  if (!toggle || !nav) return;

  const closeMenu = () => {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation');
    nav.classList.remove('is-open');
  };

  toggle.addEventListener('click', () => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!isOpen));
    toggle.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
    nav.classList.toggle('is-open', !isOpen);
  });
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
  document.addEventListener('click', (event) => {
    if (!nav.contains(event.target) && !toggle.contains(event.target)) closeMenu();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 850) closeMenu();
  });
}

const year = $('#current-year');
if (year) year.textContent = String(new Date().getFullYear());
setupMobileNavigation();
setupReportForm();
setupSubscribeForm();
loadDashboard();
