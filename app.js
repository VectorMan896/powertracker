/* ============================================================
   PowerTracker — prepaid electricity consumption tracker
   Offline, dependency-free. All data in localStorage.
   Meter model: COUNTS DOWN (remaining kWh). Recharges add kWh.
   ============================================================ */

const STORE_KEY = 'powertracker.v1';
const DEFAULT_RATE = 8.4;              // MT/kWh fallback if no recharge logged
const CAT_COLORS = {
  'Always-on': '#38bdf8', 'Heating': '#f85149', 'Refrigeration': '#3fb950',
  'Cooking': '#ffb703', 'Pumps': '#a78bfa', 'Lighting': '#fbbf24',
  'Entertainment': '#f472b6', 'Laundry': '#22d3ee', 'Other': '#94a3b8'
};

/* ---------- ID & time helpers ---------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const t = (iso) => new Date(iso).getTime();
const DAY = 86400000;

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function relTime(iso) {
  const diff = Date.now() - t(iso);
  const d = diff / DAY;
  if (d < 0) return 'in the future';
  if (d < 0.021) return 'just now';
  if (d < 1) return Math.round(d * 24) + 'h ago';
  if (d < 1.5) return 'yesterday';
  return Math.round(d) + ' days ago';
}
function fmt(n, dec = 1) {
  if (n === Infinity) return '∞';
  if (n == null || isNaN(n)) return '–';
  return n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmt0(n) { return fmt(n, 0); }

/* ---------- State ---------- */
function defaultSettings() {
  return { alertKwh: 45, alertDays: 2, window: 7, assumed: 23.8, currency: 'MT', notify: false };
}
function seedAppliances() {
  const A = (name, watts, qty, hours, days, category) => ({ id: uid(), name, watts, qty, hours, days, category });
  return [
    A('Server PC', 150, 1, 24, 7, 'Always-on'),
    A('Gaming PC', 120, 1, 24, 7, 'Always-on'),
    A('Water heater (geyser)', 3000, 1, 2.3, 7, 'Heating'),
    A('Chest freezer', 150, 1, 9, 7, 'Refrigeration'),
    A('Fridge / freezer', 120, 2, 10, 7, 'Refrigeration'),
    A('Induction stove', 2000, 1, 0.8, 7, 'Cooking'),
    A('Electric kettle', 2000, 1, 0.15, 7, 'Cooking'),
    A('Microwave', 1000, 1, 0.3, 7, 'Cooking'),
    A('Water pressure pump', 750, 1, 1.2, 7, 'Pumps'),
    A('Elevation pressure pump', 750, 1, 1.5, 7, 'Pumps'),
    A('LED lamps', 9, 25, 5, 7, 'Lighting'),
    A('TV', 100, 1, 5, 7, 'Entertainment'),
    A('Washing machine', 500, 1, 1, 1.5, 'Laundry'),
    A('Pool pump', 1100, 1, 4, 0.3, 'Pumps')
  ];
}
function firstRunData() {
  // Onboarding seed from the user's real M-Pesa / Credelec receipt.
  const iso = '2026-08-28T12:00';
  return {
    version: 1,
    settings: defaultSettings(),
    appliances: seedAppliances(),
    recharges: [{ id: uid(), t: iso, mt: 2000, kwh: 238.2, iva: 180.49, fees: 0, ref: '202608280122232376' }],
    readings: [{ id: uid(), t: iso, kwh: 238.2 }]
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return firstRunData();
    const s = JSON.parse(raw);
    s.settings = Object.assign(defaultSettings(), s.settings || {});
    s.appliances = s.appliances || [];
    s.readings = s.readings || [];
    s.recharges = s.recharges || [];
    return s;
  } catch (e) {
    console.error('load failed', e);
    return firstRunData();
  }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — storage full?'); }
}

/* ============================================================
   CALCULATION ENGINE
   ============================================================ */

function readingsSorted() { return [...state.readings].sort((a, b) => t(a.t) - t(b.t)); }
function rechargesSorted() { return [...state.recharges].sort((a, b) => t(a.t) - t(b.t)); }

// Consumption between each consecutive pair of readings, accounting for
// any recharges that happened in between. consumed = a + rechargesBetween - b.
function intervals() {
  const rs = readingsSorted();
  const rc = rechargesSorted();
  const out = [];
  for (let i = 1; i < rs.length; i++) {
    const a = rs[i - 1], b = rs[i];
    const added = rc.filter(r => t(r.t) > t(a.t) && t(r.t) <= t(b.t))
                    .reduce((s, r) => s + r.kwh, 0);
    const consumed = a.kwh + added - b.kwh;
    const days = (t(b.t) - t(a.t)) / DAY;
    out.push({ start: a.t, end: b.t, consumed, added, days, rate: days > 0 ? consumed / days : null });
  }
  return out;
}

// Weighted average daily consumption (kWh/day) over the chosen window.
function avgDailyRate() {
  const win = state.settings.window; // days, 0 = all
  const cutoff = win > 0 ? Date.now() - win * DAY : -Infinity;
  const valid = intervals().filter(iv => iv.rate != null && iv.consumed >= 0 && t(iv.end) >= cutoff);
  if (!valid.length) {
    // fall back to all valid intervals, else assumed
    const any = intervals().filter(iv => iv.rate != null && iv.consumed >= 0);
    if (!any.length) return { rate: state.settings.assumed, basis: 'assumed', samples: 0 };
    const c = any.reduce((s, iv) => s + iv.consumed, 0);
    const d = any.reduce((s, iv) => s + iv.days, 0);
    return { rate: c / d, basis: 'all history', samples: any.length };
  }
  const c = valid.reduce((s, iv) => s + iv.consumed, 0);
  const d = valid.reduce((s, iv) => s + iv.days, 0);
  const label = win > 0 ? `last ${win} days` : 'all history';
  return { rate: c / d, basis: label, samples: valid.length };
}

// Latest MT/kWh rate from the most recent recharge (fallback constant).
function latestRate() {
  const rc = rechargesSorted();
  for (let i = rc.length - 1; i >= 0; i--) {
    if (rc[i].kwh > 0) return rc[i].mt / rc[i].kwh;
  }
  return DEFAULT_RATE;
}

// Current situation: anchor at last reading, add later recharges, decay by avg rate.
function situation() {
  const rs = readingsSorted();
  const { rate, basis, samples } = avgDailyRate();
  if (!rs.length) {
    return { hasData: false, rate, basis, samples };
  }
  const anchor = rs[rs.length - 1];
  const addedSince = rechargesSorted()
    .filter(r => t(r.t) > t(anchor.t))
    .reduce((s, r) => s + r.kwh, 0);
  const daysSince = Math.max(0, (Date.now() - t(anchor.t)) / DAY);
  const consumedSince = rate * daysSince;
  const estimated = Math.max(0, anchor.kwh + addedSince - consumedSince);
  const daysRemaining = rate > 0 ? estimated / rate : Infinity;
  const emptyAt = rate > 0 ? new Date(Date.now() + daysRemaining * DAY) : null;
  return {
    hasData: true, rate, basis, samples,
    anchor, daysSince, addedSince,
    estimated, daysRemaining, emptyAt,
    ratePerKwh: latestRate()
  };
}

function alertLevel(s) {
  if (!s.hasData) return 'none';
  const belowKwh = s.estimated <= state.settings.alertKwh;
  const belowDays = s.daysRemaining <= state.settings.alertDays;
  if (belowDays || s.estimated <= state.settings.alertKwh * 0.5) return 'bad';
  if (belowKwh) return 'warn';
  return 'good';
}

/* ---------- Appliance model ---------- */
function applianceKwh(a) { return a.watts * a.qty * a.hours * (a.days / 7) / 1000; }
function modeledTotal() { return state.appliances.reduce((s, a) => s + applianceKwh(a), 0); }

/* ============================================================
   RENDER
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function render() {
  renderHero();
  renderStats();
  renderCharts();
  renderHistory();
  renderAppliances();
  renderAlert();
}

function renderHero() {
  const s = situation();
  const el = $('#hero');
  if (!s.hasData) {
    el.innerHTML = `<div class="hero-label">Get started</div>
      <div class="hero-sub" style="margin-top:8px">Log your first meter reading in the <strong>Log</strong> tab to begin tracking.</div>`;
    return;
  }
  const lvl = alertLevel(s);
  const ringTxt = lvl === 'bad' ? 'Recharge now' : lvl === 'warn' ? 'Recharge soon' : 'Healthy';
  const daysTxt = s.daysRemaining === Infinity ? '—' : fmt(s.daysRemaining, 1);
  const empty = s.emptyAt
    ? `Estimated empty <strong>${s.emptyAt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>`
    : 'Add more readings to project the empty date';
  el.innerHTML = `
    <div class="hero-label">Estimated days remaining</div>
    <div class="hero-days">${daysTxt} <small>days</small></div>
    <div class="hero-sub">≈ <strong>${fmt(s.estimated, 1)} kWh</strong> left now · ${fmt(s.rate, 1)} kWh/day (${s.basis})</div>
    <div class="hero-empty">${empty}</div>
    <span class="ring ${lvl}">${ringTxt}</span>`;
}

function renderStats() {
  const s = situation();
  const grid = $('#statGrid');
  if (!s.hasData) { grid.innerHTML = ''; return; }
  const cur = state.settings.currency;
  const valueLeft = s.estimated * s.ratePerKwh;
  const costDay = s.rate * s.ratePerKwh;
  const iv = intervals();
  const lastIv = iv.length ? iv[iv.length - 1] : null;
  const recent = lastIv && lastIv.rate != null ? `${fmt(lastIv.rate, 1)}` : '–';
  const totalSpent = state.recharges.reduce((a, r) => a + r.mt, 0);
  const cards = [
    ['Avg use', `${fmt(s.rate, 1)} <small>kWh/day</small>`],
    ['Last interval', `${recent} <small>kWh/day</small>`],
    ['Value left', `${fmt0(valueLeft)} <small>${cur}</small>`],
    ['Cost / day', `${fmt0(costDay)} <small>${cur}</small>`],
    ['Rate', `${fmt(s.ratePerKwh, 2)} <small>${cur}/kWh</small>`],
    ['Total spent', `${fmt0(totalSpent)} <small>${cur}</small>`]
  ];
  grid.innerHTML = cards.map(([l, v]) =>
    `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join('');
}

function renderAlert() {
  const s = situation();
  const banner = $('#alertBanner');
  const lvl = alertLevel(s);
  if (lvl === 'good' || lvl === 'none') { banner.className = 'alert-banner hidden'; return; }
  banner.className = `alert-banner ${lvl}`;
  const days = s.daysRemaining === Infinity ? '' : ` (~${fmt(s.daysRemaining, 1)} days)`;
  banner.textContent = lvl === 'bad'
    ? `⚠ Low balance — about ${fmt(s.estimated, 0)} kWh left${days}. Recharge now.`
    : `🔔 Balance getting low — about ${fmt(s.estimated, 0)} kWh left${days}. Plan a recharge.`;
  maybeNotify(s, lvl);
}

/* ---------- Charts ---------- */
function renderCharts() {
  renderBalanceChart();
  renderDailyChart();
}

function svgEl(w, h) {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">
    <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>`;
}

function renderBalanceChart() {
  const el = $('#balanceChart');
  const rs = readingsSorted();
  $('#balanceChartHint').textContent = rs.length ? `${rs.length} readings` : '';
  if (rs.length < 2) {
    el.innerHTML = `<div class="empty">Log at least two readings to see the remaining-energy curve.</div>`;
    return;
  }
  const W = 340, H = 160, pl = 36, pr = 12, pt = 12, pb = 24;
  const xs = rs.map(r => t(r.t));
  const ys = rs.map(r => r.kwh);
  const xMin = xs[0], xMax = xs[xs.length - 1];
  const yMax = Math.max(...ys) * 1.1 || 1;
  const X = (v) => pl + (xMax === xMin ? 0.5 : (v - xMin) / (xMax - xMin)) * (W - pl - pr);
  const Y = (v) => pt + (1 - v / yMax) * (H - pt - pb);

  let grid = '', ylab = '';
  for (let i = 0; i <= 3; i++) {
    const yv = yMax * i / 3, y = Y(yv);
    grid += `<line class="grid-line" x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}"/>`;
    ylab += `<text class="axis-label" x="${pl - 5}" y="${y + 3}" text-anchor="end">${fmt0(yv)}</text>`;
  }
  const pts = rs.map(r => `${X(t(r.t))},${Y(r.kwh)}`);
  const line = `<polyline class="plot-line" points="${pts.join(' ')}"/>`;
  const area = `<polygon class="plot-area" points="${X(xMin)},${Y(0)} ${pts.join(' ')} ${X(xMax)},${Y(0)}"/>`;
  const dots = rs.map(r => `<circle class="plot-dot" cx="${X(t(r.t))}" cy="${Y(r.kwh)}" r="2.6"/>`).join('');

  let rmarks = '';
  rechargesSorted().forEach(r => {
    const x = t(r.t);
    if (x >= xMin && x <= xMax) rmarks += `<line class="recharge-mark" x1="${X(x)}" y1="${pt}" x2="${X(x)}" y2="${H - pb}"/>`;
  });

  const xl = `<text class="axis-label" x="${pl}" y="${H - 6}" text-anchor="start">${fmtDate(rs[0].t)}</text>
    <text class="axis-label" x="${W - pr}" y="${H - 6}" text-anchor="end">${fmtDate(rs[rs.length - 1].t)}</text>`;

  el.innerHTML = svgEl(W, H) + grid + ylab + rmarks + area + line + dots + xl + '</svg>';
}

function renderDailyChart() {
  const el = $('#dailyChart');
  const iv = intervals().filter(x => x.rate != null && x.consumed >= 0);
  $('#dailyChartHint').textContent = iv.length ? `${iv.length} periods` : '';
  if (!iv.length) {
    el.innerHTML = `<div class="empty">Consumption between readings will appear here.</div>`;
    return;
  }
  const data = iv.slice(-14);
  const W = 340, H = 160, pl = 30, pr = 10, pt = 12, pb = 26;
  const yMax = Math.max(...data.map(d => d.rate)) * 1.15 || 1;
  const Y = (v) => pt + (1 - v / yMax) * (H - pt - pb);
  const bw = (W - pl - pr) / data.length;
  let grid = '', ylab = '';
  for (let i = 0; i <= 2; i++) {
    const yv = yMax * i / 2, y = Y(yv);
    grid += `<line class="grid-line" x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}"/>`;
    ylab += `<text class="axis-label" x="${pl - 5}" y="${y + 3}" text-anchor="end">${fmt0(yv)}</text>`;
  }
  let bars = '', xl = '';
  data.forEach((d, i) => {
    const x = pl + i * bw + bw * 0.16;
    const w = bw * 0.68;
    const y = Y(d.rate);
    bars += `<rect class="bar" x="${x}" y="${y}" width="${w}" height="${H - pb - y}" rx="2"><title>${fmtDate(d.end)}: ${fmt(d.rate, 1)} kWh/day</title></rect>`;
    if (i === 0 || i === data.length - 1 || (data.length <= 8)) {
      xl += `<text class="axis-label" x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${fmtDate(d.end)}</text>`;
    }
  });
  const avg = data.reduce((s, d) => s + d.rate, 0) / data.length;
  const avgY = Y(avg);
  const avgLine = `<line class="bar-avg" x1="${pl}" y1="${avgY}" x2="${W - pr}" y2="${avgY}"/>
    <text class="axis-label" x="${W - pr}" y="${avgY - 4}" text-anchor="end">avg ${fmt(avg, 1)}</text>`;
  el.innerHTML = svgEl(W, H) + grid + ylab + bars + avgLine + xl + '</svg>';
}

/* ---------- History ---------- */
function renderHistory() {
  const el = $('#historyList');
  const items = [
    ...state.readings.map(r => ({ ...r, kind: 'reading' })),
    ...state.recharges.map(r => ({ ...r, kind: 'recharge' }))
  ].sort((a, b) => t(b.t) - t(a.t));
  $('#historyCount').textContent = `${state.readings.length} readings · ${state.recharges.length} recharges`;
  if (!items.length) { el.innerHTML = `<div class="empty" style="color:var(--text-faint);padding:16px 0">No entries yet.</div>`; return; }
  const cur = state.settings.currency;
  el.innerHTML = items.map(it => {
    if (it.kind === 'reading') {
      return `<div class="hist-item">
        <div class="hist-icon read">▾</div>
        <div class="hist-main">
          <div class="hist-title">${fmt(it.kwh, 1)} kWh on meter</div>
          <div class="hist-sub">${fmtDateTime(it.t)} · ${relTime(it.t)}</div>
        </div>
        <button class="hist-del" data-del-reading="${it.id}" aria-label="Delete">✕</button>
      </div>`;
    }
    const rate = it.kwh > 0 ? it.mt / it.kwh : 0;
    return `<div class="hist-item">
      <div class="hist-icon recharge">＋</div>
      <div class="hist-main">
        <div class="hist-title">Recharge · +${fmt(it.kwh, 1)} kWh</div>
        <div class="hist-sub">${fmtDateTime(it.t)} · ${fmt(rate, 2)} ${cur}/kWh${it.ref ? ' · ' + it.ref : ''}</div>
      </div>
      <div class="hist-right"><div class="hist-amt pos">${fmt0(it.mt)} ${cur}</div></div>
      <button class="hist-del" data-del-recharge="${it.id}" aria-label="Delete">✕</button>
    </div>`;
  }).join('');
}

/* ---------- Appliances ---------- */
function renderAppliances() {
  const list = state.appliances.map(a => ({ ...a, kwh: applianceKwh(a) })).sort((x, y) => y.kwh - x.kwh);
  const total = list.reduce((s, a) => s + a.kwh, 0);
  $('#modeledTotal').innerHTML = `${fmt(total, 1)} <small style="font-size:14px;color:var(--text-dim)">kWh/day</small>`;

  const s = situation();
  const measured = s.hasData ? s.rate : null;
  $('#measuredTotal').innerHTML = measured != null
    ? `${fmt(measured, 1)} <small style="font-size:14px;color:var(--text-dim)">kWh/day</small>`
    : '<small style="font-size:14px;color:var(--text-faint)">no data yet</small>';

  // stacked bar by category
  const bar = $('#modelBar');
  bar.innerHTML = list.map(a =>
    `<i style="width:${total ? (a.kwh / total * 100) : 0}%;background:${CAT_COLORS[a.category] || '#888'}"></i>`).join('');

  const hintEl = $('#modelHint');
  if (measured != null && total > 0) {
    const diff = measured - total;
    const pct = Math.abs(diff / total * 100);
    hintEl.textContent = Math.abs(diff) < 0.5
      ? 'Your appliance model closely matches your measured usage. 👌'
      : diff > 0
        ? `Measured use is ${fmt(diff, 1)} kWh/day (${fmt0(pct)}%) higher than modeled — some loads run more than estimated.`
        : `Measured use is ${fmt(-diff, 1)} kWh/day (${fmt0(pct)}%) lower than modeled — you're doing better than the estimate.`;
  } else {
    hintEl.textContent = 'Tune each appliance to match your real usage; the bar shows the mix by category.';
  }

  $('#applianceList').innerHTML = list.map(a => `
    <div class="ap-item" data-edit="${a.id}">
      <div class="ap-swatch" style="background:${CAT_COLORS[a.category] || '#888'}"></div>
      <div class="ap-main">
        <div class="ap-name">${escapeHtml(a.name)}</div>
        <div class="ap-meta">${a.qty > 1 ? a.qty + '× ' : ''}${fmt0(a.watts)} W · ${fmt(a.hours, 1)} h/day${a.days < 7 ? ' · ' + fmt(a.days, 1) + ' d/wk' : ''}</div>
      </div>
      <div class="ap-right">
        <div class="ap-kwh">${fmt(a.kwh, 2)}</div>
        <div class="ap-pct">${total ? fmt0(a.kwh / total * 100) : 0}%</div>
      </div>
    </div>`).join('');
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
function maybeNotify(s, lvl) {
  if (!state.settings.notify || lvl === 'good' || lvl === 'none') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const key = 'powertracker.lastNotify';
  const today = new Date().toDateString();
  if (localStorage.getItem(key) === today) return;
  localStorage.setItem(key, today);
  try {
    new Notification('PowerTracker', {
      body: `About ${fmt(s.estimated, 0)} kWh (~${fmt(s.daysRemaining, 1)} days) left. Time to recharge.`,
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E"
    });
  } catch (e) { /* ignore */ }
}

/* ============================================================
   UI WIRING
   ============================================================ */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function navTo(view) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== view));
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setNow(id) { $(id).value = toLocalInput(new Date()); }

function initForms() {
  setNow('#readingTime');
  setNow('#rechargeTime');

  // Reading form
  $('#readingForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const kwh = parseFloat($('#readingKwh').value);
    const time = $('#readingTime').value;
    if (isNaN(kwh) || !time) return;
    state.readings.push({ id: uid(), t: time, kwh });
    save(); render();
    $('#readingKwh').value = ''; setNow('#readingTime');
    toast('Reading saved');
    navTo('dashboard');
  });

  // Recharge live rate preview
  const updatePreview = () => {
    const mt = parseFloat($('#rechargeMt').value);
    const kwh = parseFloat($('#rechargeKwh').value);
    const el = $('#ratePreview');
    if (mt > 0 && kwh > 0) {
      el.textContent = `Rate: ${fmt(mt / kwh, 2)} ${state.settings.currency}/kWh · your meter will jump up by ${fmt(kwh, 1)} kWh`;
    } else el.textContent = '';
  };
  $('#rechargeMt').addEventListener('input', updatePreview);
  $('#rechargeKwh').addEventListener('input', updatePreview);

  // Recharge form
  $('#rechargeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const mt = parseFloat($('#rechargeMt').value);
    const kwh = parseFloat($('#rechargeKwh').value);
    const time = $('#rechargeTime').value;
    if (isNaN(mt) || isNaN(kwh) || !time) return;
    state.recharges.push({
      id: uid(), t: time, mt, kwh,
      iva: parseFloat($('#rechargeIva').value) || 0,
      fees: parseFloat($('#rechargeFees').value) || 0,
      ref: $('#rechargeRef').value.trim()
    });
    save(); render();
    e.target.reset(); setNow('#rechargeTime'); $('#ratePreview').textContent = '';
    toast('Recharge saved');
    navTo('dashboard');
  });

  // History delete (event delegation)
  $('#historyList').addEventListener('click', (e) => {
    const rd = e.target.closest('[data-del-reading]');
    const rc = e.target.closest('[data-del-recharge]');
    if (rd) { if (confirm('Delete this reading?')) { state.readings = state.readings.filter(x => x.id !== rd.dataset.delReading); save(); render(); } }
    if (rc) { if (confirm('Delete this recharge?')) { state.recharges = state.recharges.filter(x => x.id !== rc.dataset.delRecharge); save(); render(); } }
  });

  // Settings
  loadSettingsForm();
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.settings.alertKwh = parseFloat($('#setAlertKwh').value) || 0;
    state.settings.alertDays = parseFloat($('#setAlertDays').value) || 0;
    state.settings.window = parseInt($('#setWindow').value, 10);
    state.settings.assumed = parseFloat($('#setAssumed').value) || 23.8;
    state.settings.currency = $('#setCurrency').value.trim() || 'MT';
    const wantNotify = $('#setNotify').checked;
    if (wantNotify && 'Notification' in window && Notification.permission !== 'granted') {
      Notification.requestPermission().then(p => {
        state.settings.notify = (p === 'granted');
        $('#setNotify').checked = state.settings.notify;
        save(); render();
      });
    } else {
      state.settings.notify = wantNotify;
    }
    save(); render();
    toast('Settings saved');
  });

  // Backup
  $('#exportBtn').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', importData);
  $('#resetBtn').addEventListener('click', () => {
    if (confirm('Delete ALL readings, recharges and settings on this device? This cannot be undone.')) {
      localStorage.removeItem(STORE_KEY);
      state = { version: 1, settings: defaultSettings(), appliances: seedAppliances(), readings: [], recharges: [] };
      save(); loadSettingsForm(); render(); navTo('dashboard');
      toast('All data reset');
    }
  });

  // Appliance modal
  $('#addApplianceBtn').addEventListener('click', () => openAppliance(null));
  $('#applianceList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-edit]');
    if (item) openAppliance(item.dataset.edit);
  });
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  ['#apWatts', '#apQty', '#apHours', '#apDays'].forEach(id =>
    $(id).addEventListener('input', updateApPreview));
  $('#applianceForm').addEventListener('submit', saveAppliance);
  $('#apDelete').addEventListener('click', deleteAppliance);
}

function loadSettingsForm() {
  const s = state.settings;
  $('#setAlertKwh').value = s.alertKwh;
  $('#setAlertDays').value = s.alertDays;
  $('#setWindow').value = s.window;
  $('#setAssumed').value = s.assumed;
  $('#setCurrency').value = s.currency;
  $('#setNotify').checked = s.notify;
}

/* ---------- Appliance modal ---------- */
function openAppliance(id) {
  const a = id ? state.appliances.find(x => x.id === id) : null;
  $('#modalTitle').textContent = a ? 'Edit appliance' : 'Add appliance';
  $('#applianceId').value = a ? a.id : '';
  $('#apName').value = a ? a.name : '';
  $('#apWatts').value = a ? a.watts : '';
  $('#apQty').value = a ? a.qty : 1;
  $('#apHours').value = a ? a.hours : '';
  $('#apDays').value = a ? a.days : 7;
  $('#apCategory').value = a ? a.category : 'Other';
  $('#apDelete').style.display = a ? '' : 'none';
  updateApPreview();
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
function updateApPreview() {
  const w = parseFloat($('#apWatts').value), q = parseFloat($('#apQty').value),
        h = parseFloat($('#apHours').value), d = parseFloat($('#apDays').value);
  const el = $('#apPreview');
  if (w > 0 && q > 0 && h >= 0 && d >= 0) {
    const kwh = w * q * h * (d / 7) / 1000;
    el.textContent = `≈ ${fmt(kwh, 2)} kWh/day · ${fmt0(kwh * latestRate())} ${state.settings.currency}/day`;
  } else el.textContent = '';
}
function saveAppliance(e) {
  e.preventDefault();
  const id = $('#applianceId').value;
  const data = {
    name: $('#apName').value.trim(),
    watts: parseFloat($('#apWatts').value) || 0,
    qty: parseInt($('#apQty').value, 10) || 1,
    hours: parseFloat($('#apHours').value) || 0,
    days: parseFloat($('#apDays').value) || 7,
    category: $('#apCategory').value
  };
  if (!data.name) return;
  if (id) {
    const a = state.appliances.find(x => x.id === id);
    Object.assign(a, data);
  } else {
    state.appliances.push({ id: uid(), ...data });
  }
  save(); render(); closeModal(); toast('Appliance saved');
}
function deleteAppliance() {
  const id = $('#applianceId').value;
  if (id && confirm('Delete this appliance?')) {
    state.appliances = state.appliances.filter(x => x.id !== id);
    save(); render(); closeModal(); toast('Deleted');
  }
}

/* ---------- Backup ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `powertracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded');
}
function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object') throw new Error('bad');
      state = {
        version: 1,
        settings: Object.assign(defaultSettings(), data.settings || {}),
        appliances: data.appliances || [],
        readings: data.readings || [],
        recharges: data.recharges || []
      };
      save(); loadSettingsForm(); render(); navTo('dashboard');
      toast('Data imported');
    } catch (err) { toast('Import failed — invalid file'); }
    e.target.value = '';
  };
  reader.readAsText(file);
}

/* ---------- Nav & boot ---------- */
$$('.tab').forEach(b => b.addEventListener('click', () => navTo(b.dataset.nav)));
$('#quickReadBtn').addEventListener('click', () => { navTo('log'); setTimeout(() => $('#readingKwh').focus(), 200); });

initForms();
render();

// Register service worker for offline use (ignored on file://)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
