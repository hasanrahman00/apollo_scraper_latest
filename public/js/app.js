let jobs = [];
let timers = {};

const $ = id => document.getElementById(id);
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

// ─── Tabs ────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.pane').forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    $('pane-' + t.dataset.p).classList.add('on');
  });
});

function switchTab(name) {
  document.querySelector(`[data-p="${name}"]`).click();
}

// ─── SSE ─────────────────────────────────────────────────────
const sse = new EventSource('/api/events');

sse.addEventListener('init', e => { jobs = JSON.parse(e.data); render(); });

sse.addEventListener('job:update', e => {
  const j = JSON.parse(e.data);
  const i = jobs.findIndex(x => x.id === j.id);
  if (i >= 0) jobs[i] = j; else jobs.unshift(j);
  render();
});

sse.addEventListener('job:delete', e => {
  jobs = jobs.filter(j => j.id !== JSON.parse(e.data).id);
  killTimer(JSON.parse(e.data).id);
  render();
});

sse.addEventListener('job:log', e => {
  const d = JSON.parse(e.data);
  appendToModal('log-body', d);
});

sse.addEventListener('enricher:log', e => {
  const d = JSON.parse(e.data);
  appendToModal('elog-body', d);
});

function appendToModal(elId, d) {
  const el = $(elId);
  const modal = el?.closest('.modal-bg');
  if (!el || !modal?.classList.contains('on')) return;
  if (el.dataset.jid !== d.id) return;
  el.textContent += (d.line || '') + '\n';
  el.scrollTop = el.scrollHeight;
}

// ─── Elapsed ─────────────────────────────────────────────────
function fmtElapsed(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
function getElapsed(j) {
  if (!j.startedAt) return '—';
  return fmtElapsed((j.finishedAt ? new Date(j.finishedAt) : new Date()) - new Date(j.startedAt));
}
function startTimer(id) {
  if (timers[id]) return;
  timers[id] = setInterval(() => {
    const el = $('et-' + id), j = jobs.find(x => x.id === id);
    if (el && j) el.textContent = getElapsed(j);
  }, 1000);
}
function killTimer(id) { if (timers[id]) { clearInterval(timers[id]); delete timers[id]; } }
function syncTimers() {
  jobs.forEach(j => { j.status === 'running' && j.startedAt ? startTimer(j.id) : killTimer(j.id); });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function updateBadge() {
  const n = jobs.filter(j => j.status === 'running').length;
  const b = $('jbadge');
  b.textContent = n || jobs.length;
  b.className = 'nav-badge' + (n ? ' live' : '');
}

// ─── Parse ───────────────────────────────────────────────────
async function parseUrl() {
  const url = $('f-url').value.trim();
  if (!url) return;
  const r = await fetch('/api/parse-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  const d = await r.json();
  const pre = $('preview');
  pre.textContent = d.ok ? JSON.stringify(d.payload, null, 2) : 'Error: ' + d.error;
  pre.classList.add('vis');
}

// ─── Create job ──────────────────────────────────────────────
async function createJob() {
  const url = $('f-url').value.trim();
  if (!url) return alert('Paste an Apollo search URL');
  const r = await fetch('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: $('f-name').value.trim() || 'Apollo Scrape', url, maxPages: $('f-max').value, perPage: $('f-per').value }),
  });
  const j = await r.json();
  if (j.error) return alert(j.error);
  await fetch(`/api/jobs/${j.id}/start`, { method: 'POST' });
  switchTab('jobs');
}

// ─── Scraper actions ─────────────────────────────────────────
async function act(id, action) {
  if (action === 'delete' && !confirm('Delete this job and all data?')) return;
  if (action === 'rerun' && !confirm('Restart from scratch?')) return;
  const method = action === 'delete' ? 'DELETE' : 'POST';
  const url = action === 'delete' ? `/api/jobs/${id}` : `/api/jobs/${id}/${action}`;
  await fetch(url, { method });
}

function dl(id) { window.open(`/api/jobs/${id}/csv`); }

// ─── Enricher actions ────────────────────────────────────────
async function eAct(id, action) {
  if (action === 'rerun' && !confirm('Rerun enricher? Will reprocess all empty rows.')) return;
  await fetch(`/api/jobs/${id}/enricher/${action}`, { method: 'POST' });
}

// ─── Render ──────────────────────────────────────────────────
function render() {
  const list = $('jlist');

  if (!jobs.length) {
    list.innerHTML = '<div class="empty"><div class="ic">📋</div><p>No jobs yet — create one from the New Scrape tab.</p></div>';
    updateBadge();
    return;
  }

  list.innerHTML = jobs.map(j => {
    const R = j.status === 'running', S = j.status === 'stopping';
    const D = j.status === 'done', F = j.status === 'failed';
    const P = j.status === 'stopped', I = j.status === 'idle';
    const has = j.hasData;
    const barCls = D ? ' done' : F ? ' fail' : '';

    // ── Scraper buttons ──────────────────
    let sb = '';
    if (I)      sb += btn('b-green', `act('${j.id}','start')`, '▶ Start');
    if (P || F) sb += btn('b-green', `act('${j.id}','start')`, '▶ Resume');
    if (R)      sb += btn('b-amber', `act('${j.id}','stop')`, '⏸ Pause');
    if (S)      sb += `<button class="b b-xs b-ghost" disabled>⏳ Pausing…</button>`;
    if (D)      sb += btn('b-cyan', `act('${j.id}','rerun')`, '↻ Rerun');
    if (P || F) sb += btn('b-ghost', `act('${j.id}','rerun')`, '↻ Rerun');
    sb += '<span class="sep"></span>';
    if (has) sb += btn('b-green', `dl('${j.id}')`, '↓ CSV' + (R ? ` (${j.totalScraped})` : ''));
    sb += btn('b-ghost', `openLogs('${j.id}')`, 'Logs' + (j.logCount ? ` (${j.logCount})` : ''));
    if (!R && !S) sb += '<span class="sep"></span>' + btn('b-red', `act('${j.id}','delete')`, 'Delete');

    // ── Enricher section ─────────────────
    const e = j.enricher || {};
    const eR = e.status === 'running', eS = e.status === 'stopping';
    const eD = e.status === 'done', eF = e.status === 'failed';
    const eP = e.status === 'stopped', eI = e.status === 'idle';

    let eb = '';
    if (eI)                    eb += btn('b-brand-sm', `eAct('${j.id}','start')`, '🔍 Enrich Websites');
    if (eR)                    eb += btn('b-amber', `eAct('${j.id}','stop')`, '⏸ Stop Enricher');
    if (eS)                    eb += `<button class="b b-xs b-ghost" disabled>⏳ Stopping…</button>`;
    if (eP || eF)              eb += btn('b-green', `eAct('${j.id}','start')`, '▶ Resume Enricher');
    if (eD)                    eb += btn('b-cyan', `eAct('${j.id}','rerun')`, '↻ Rerun Enricher');
    if (eP || eF)              eb += btn('b-ghost', `eAct('${j.id}','rerun')`, '↻ Rerun Enricher');
    eb += btn('b-ghost', `openELogs('${j.id}')`, 'Enricher Logs' + (e.logCount ? ` (${e.logCount})` : ''));

    // ── Enricher stats ───────────────────
    let eStats = '';
    if (e.status !== 'idle') {
      const pct = e.total > 0 ? Math.floor((e.done / e.total) * 100) : 0;
      eStats = `<div class="e-stats">
        <span class="e-stat">Need <b>${e.total}</b></span>
        <span class="e-stat">Processed <b>${e.done}</b></span>
        <span class="e-stat enriched-count">Enriched <b>${e.enriched}</b></span>
        <span class="e-badge e-badge-${e.status}">${e.status}</span>
      </div>
      <div class="e-bar"><div class="e-bar-fill" style="width:${pct}%"></div></div>`;
    }

    return `<div class="jc">
      <div class="jc-top">
        <div>
          <div class="jc-name">${esc(j.name)}</div>
          <div class="jc-url">${esc(j.url)}</div>
        </div>
        <div class="jc-right">
          <span class="jc-time" id="et-${j.id}">${getElapsed(j)}</span>
          <span class="badge badge-${j.status}">${R ? '<span class="dot dot-live"></span>' : ''}${j.status}</span>
        </div>
      </div>
      <div class="jc-stats">
        <span class="jc-s">Page <b>${j.currentPage || 0}</b></span>
        <span class="jc-s">Scraped <b>${(j.totalScraped || 0).toLocaleString()}</b></span>
        <span class="jc-s">Found <b>${(j.totalFound || 0).toLocaleString()}</b></span>
        ${j.createdAt ? `<span class="jc-s">${fmtDate(j.createdAt)}</span>` : ''}
      </div>
      <div class="jc-bar"><div class="jc-bar-fill${barCls}" style="width:${j.progress || 0}%"></div></div>
      <div class="jc-actions">${sb}</div>
      <div class="e-section">
        ${eStats}
        <div class="e-actions">${eb}</div>
      </div>
    </div>`;
  }).join('');

  updateBadge();
  syncTimers();
}

function btn(cls, onclick, label) {
  return `<button class="b b-xs ${cls}" onclick="${onclick}">${label}</button>`;
}

// ─── Scraper Logs modal ──────────────────────────────────────
async function openLogs(id) {
  const r = await fetch(`/api/jobs/${id}/logs`);
  const d = await r.json();
  const el = $('log-body');
  el.dataset.jid = id;
  el.textContent = (d.logs || []).join('\n');
  $('log-title').textContent = (jobs.find(x => x.id === id)?.name || id) + ' — Scraper Logs';
  $('modal').classList.add('on');
  el.scrollTop = el.scrollHeight;
}
function closeLogs() { $('modal').classList.remove('on'); }
$('modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeLogs(); });

// ─── Enricher Logs modal ─────────────────────────────────────
async function openELogs(id) {
  const r = await fetch(`/api/jobs/${id}/enricher/logs`);
  const d = await r.json();
  const el = $('elog-body');
  el.dataset.jid = id;
  el.textContent = (d.logs || []).join('\n');
  $('elog-title').textContent = (jobs.find(x => x.id === id)?.name || id) + ' — Enricher Logs';
  $('emodal').classList.add('on');
  el.scrollTop = el.scrollHeight;
}
function closeELogs() { $('emodal').classList.remove('on'); }
$('emodal').addEventListener('click', e => { if (e.target === e.currentTarget) closeELogs(); });

// ─── Collapse / Settings / Auto-parse ────────────────────────
function toggleC(btn) { btn.nextElementSibling.classList.toggle('open'); }

(async () => {
  try {
    const r = await fetch('/api/settings'); const s = await r.json();
    $('s-chrome').value = s.CHROME_PATH || '';
    $('s-data').value = s.USER_DATA_DIR || '';
    $('s-port').value = s.PORT || 9222;
  } catch {}
})();

async function saveSets() {
  const r = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CHROME_PATH: $('s-chrome').value, USER_DATA_DIR: $('s-data').value, PORT: $('s-port').value }),
  });
  const d = await r.json();
  const m = $('s-msg');
  m.textContent = d.message || '✓';
  setTimeout(() => m.textContent = '', 3000);
}

$('f-url').addEventListener('paste', () => setTimeout(parseUrl, 100));