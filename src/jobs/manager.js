const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { runScrape } = require('../services/scrapeEngine');
const { runEnricher } = require('../enricher/engine');
const { closeGeminiTab } = require('../enricher/geminiClient');
const { runCompanyEnricher } = require('../enricher/companyEnricher');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultEnricher() {
  return { status: 'idle', total: 0, done: 0, enriched: 0, progress: 0, logs: [], _geminiPage: null };
}
function defaultCompanyEnricher() {
  return { status: 'idle', total: 0, done: 0, enriched: 0, progress: 0, logs: [] };
}
function resultsPath(id) { return path.join(DATA_DIR, `${id}_results.json`); }

class JobManager extends EventEmitter {
  constructor() { super(); this.jobs = this._load(); }

  _load() {
    try {
      if (fs.existsSync(JOBS_FILE)) {
        const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
        for (const j of data) {
          if (j.status === 'running' || j.status === 'stopping') j.status = 'stopped';
          if (!j.logs) j.logs = [];
          if (!j.enricher) j.enricher = defaultEnricher();
          if (!j.companyEnricher) j.companyEnricher = defaultCompanyEnricher();
          if (j.enricher.status === 'running' || j.enricher.status === 'stopping') j.enricher.status = 'stopped';
          if (j.companyEnricher.status === 'running' || j.companyEnricher.status === 'stopping') j.companyEnricher.status = 'stopped';
          j.enricher.logs = j.enricher.logs || [];
          j.enricher._geminiPage = null;
          j.companyEnricher.logs = j.companyEnricher.logs || [];
          j.results = this._loadResults(j.id);
          j.totalScraped = j.results.length;
        }
        return data;
      }
    } catch {}
    return [];
  }

  _save() {
    const slim = this.jobs.map(j => ({
      ...j, results: undefined, resultCount: j.results?.length || 0,
      enricher: { ...j.enricher, _geminiPage: undefined },
      companyEnricher: { ...j.companyEnricher },
    }));
    fs.writeFileSync(JOBS_FILE, JSON.stringify(slim, null, 2), 'utf-8');
  }

  _saveResults(id) {
    const job = this.get(id);
    if (!job || !job.results?.length) return;
    try { fs.writeFileSync(resultsPath(id), JSON.stringify(job.results), 'utf-8'); } catch {}
  }

  _loadResults(id) {
    try { const p = resultsPath(id); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
    return [];
  }

  _deleteResults(id) {
    try { const p = resultsPath(id); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  list() { return this.jobs.map(j => this._safe(j)); }
  get(id) { return this.jobs.find(j => j.id === id); }
  getLogs(id) { return this.get(id)?.logs || []; }
  getEnricherLogs(id) { return this.get(id)?.enricher?.logs || []; }
  getCompanyEnricherLogs(id) { return this.get(id)?.companyEnricher?.logs || []; }

  // ═══════════════════════════════════════════════════════════
  //  SCRAPER — single URL + multi-URL batch
  // ═══════════════════════════════════════════════════════════

  create({ name, url, maxPages, perPage, payload, urls }) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const isMulti = Array.isArray(urls) && urls.length > 0;
    const job = {
      id, name: name || (isMulti ? `Batch (${urls.length} URLs)` : 'Apollo Scrape'),
      url: isMulti ? '' : (url || ''),
      urls: isMulti ? urls : null,
      payload: payload || {},
      maxPages: maxPages || 100, perPage: perPage || 25,
      status: 'idle', progress: 0, currentPage: 1,
      currentUrlNumber: 0, currentUrlTotal: isMulti ? urls.length : 1,
      totalFound: 0, totalScraped: 0,
      results: [], logs: [],
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      enricher: defaultEnricher(),
      companyEnricher: defaultCompanyEnricher(),
    };
    this.jobs.push(job); this._save(); this.emit('update', job);
    return this._safe(job);
  }

  delete(id) {
    const idx = this.jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this.stop(id); this.stopEnricher(id); this.stopCompanyEnricher(id);
    this._deleteResults(id);
    this.jobs.splice(idx, 1); this._save(); this.emit('delete', id);
    return true;
  }

  start(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'running') return this._safe(job);
    if (job.status === 'idle') {
      job.progress = 0; job.currentPage = 1;
      job.totalFound = 0; job.totalScraped = 0;
      job.results = []; job.logs = []; job.finishedAt = null;
    } else {
      job.logs.push(`\n══ RESUMED (${job.results.length} leads kept) ══`);
    }
    job.status = 'running'; job.startedAt = new Date().toISOString();
    this._save(); this.emit('update', job); this._runScrape(job);
    return this._safe(job);
  }

  rerun(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'running') job.status = 'stopping';
    setTimeout(() => {
      job.status = 'running'; job.startedAt = new Date().toISOString(); job.finishedAt = null;
      job.logs.push(`\n🔄 Rerun (${job.results.length} leads kept)`);
      this._save(); this.emit('update', job); this._runScrape(job);
    }, job.status === 'stopping' ? 2000 : 0);
    return this._safe(job);
  }

  stop(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'running') {
      job.status = 'stopping'; this._save(); this._saveResults(id); this.emit('update', job);
    }
    return this._safe(job);
  }

  _runScrape(job) {
    const log = (msg) => { job.logs.push(msg); this.emit('log', { id: job.id, line: msg }); };
    const onProgress = () => { this._save(); this._saveResults(job.id); this.emit('update', job); };
    runScrape(job, log, onProgress).then(() => {
      job.finishedAt = new Date().toISOString(); this._save(); this._saveResults(job.id); this.emit('update', job);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  WEBSITE ENRICHER
  // ═══════════════════════════════════════════════════════════

  startEnricher(id) {
    const job = this.get(id); if (!job) return null;
    if (job.enricher.status === 'running') return this._safe(job);
    const isResume = job.enricher.status === 'stopped' && job.enricher.done > 0;
    if (!isResume) job.enricher = defaultEnricher();
    job.enricher.status = 'running';
    job.enricher.logs.push(isResume ? '\n══ WEBSITE ENRICHER RESUMED ══' : '🔍 Website enricher started');
    this._save(); this.emit('update', job); this._runEnricher(job);
    return this._safe(job);
  }

  stopEnricher(id) {
    const job = this.get(id); if (!job) return null;
    if (job.enricher.status === 'running') {
      job.enricher.status = 'stopping';
      if (job.enricher._geminiPage) { closeGeminiTab(job.enricher._geminiPage, () => {}).catch(() => {}); job.enricher._geminiPage = null; }
      this._save(); this._saveResults(id); this.emit('update', job);
    }
    return this._safe(job);
  }

  rerunEnricher(id) {
    const job = this.get(id); if (!job) return null;
    if (job.enricher.status === 'running') {
      job.enricher.status = 'stopping';
      if (job.enricher._geminiPage) { closeGeminiTab(job.enricher._geminiPage, () => {}).catch(() => {}); job.enricher._geminiPage = null; }
    }
    setTimeout(() => {
      for (const r of (job.results || [])) delete r._website_enriched;
      job.enricher = defaultEnricher(); job.enricher.status = 'running';
      job.enricher.logs.push('🔄 Website enricher rerun');
      this._save(); this.emit('update', job); this._runEnricher(job);
    }, 2000);
    return this._safe(job);
  }

  _runEnricher(job) {
    const log = (msg) => { job.enricher.logs.push(msg); this.emit('enricher:log', { id: job.id, line: msg }); };
    const onProgress = () => { this._save(); this._saveResults(job.id); this.emit('update', job); };
    runEnricher(job, log, onProgress).then(() => { this._save(); this._saveResults(job.id); this.emit('update', job); });
  }

  // ═══════════════════════════════════════════════════════════
  //  COMPANY ENRICHER
  // ═══════════════════════════════════════════════════════════

  startCompanyEnricher(id) {
    const job = this.get(id); if (!job) return null;
    if (job.companyEnricher.status === 'running') return this._safe(job);
    const isResume = job.companyEnricher.status === 'stopped' && job.companyEnricher.done > 0;
    if (!isResume) job.companyEnricher = defaultCompanyEnricher();
    job.companyEnricher.status = 'running';
    job.companyEnricher.logs.push(isResume ? '\n══ COMPANY ENRICHER RESUMED ══' : '🏢 Company enricher started');
    this._save(); this.emit('update', job); this._runCompanyEnricher(job);
    return this._safe(job);
  }

  stopCompanyEnricher(id) {
    const job = this.get(id); if (!job) return null;
    if (job.companyEnricher.status === 'running') {
      job.companyEnricher.status = 'stopping';
      this._save(); this._saveResults(id); this.emit('update', job);
    }
    return this._safe(job);
  }

  rerunCompanyEnricher(id) {
    const job = this.get(id); if (!job) return null;
    if (job.companyEnricher.status === 'running') job.companyEnricher.status = 'stopping';
    setTimeout(() => {
      for (const r of (job.results || [])) {
        r.company_city = ''; r.company_state = ''; r.company_country = '';
        r.company_address = ''; r.company_postal = ''; r.company_revenue = '';
        r.company_sic = ''; delete r._company_enriched;
      }
      job.companyEnricher = defaultCompanyEnricher(); job.companyEnricher.status = 'running';
      job.companyEnricher.logs.push('🔄 Company enricher rerun');
      this._save(); this.emit('update', job); this._runCompanyEnricher(job);
    }, 2000);
    return this._safe(job);
  }

  _runCompanyEnricher(job) {
    const log = (msg) => { job.companyEnricher.logs.push(msg); this.emit('company:log', { id: job.id, line: msg }); };
    const onProgress = () => { this._save(); this._saveResults(job.id); this.emit('update', job); };
    runCompanyEnricher(job, log, onProgress).then(() => { this._save(); this._saveResults(job.id); this.emit('update', job); });
  }

  _safe(j) {
    return {
      id: j.id, name: j.name,
      url: (j.url || '').substring(0, 120),
      isMulti: !!(j.urls?.length),
      urlCount: j.urls?.length || 1,
      currentUrlNumber: j.currentUrlNumber || 0,
      currentUrlTotal: j.currentUrlTotal || 1,
      status: j.status, progress: j.progress,
      currentPage: j.currentPage, totalFound: j.totalFound,
      totalScraped: j.totalScraped || j.results?.length || 0,
      hasData: (j.results?.length || 0) > 0,
      logCount: j.logs?.length || 0,
      createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
      enricher: {
        status: j.enricher?.status || 'idle', total: j.enricher?.total || 0,
        done: j.enricher?.done || 0, enriched: j.enricher?.enriched || 0,
        progress: j.enricher?.progress || 0, logCount: j.enricher?.logs?.length || 0,
      },
      companyEnricher: {
        status: j.companyEnricher?.status || 'idle', total: j.companyEnricher?.total || 0,
        done: j.companyEnricher?.done || 0, enriched: j.companyEnricher?.enriched || 0,
        progress: j.companyEnricher?.progress || 0, logCount: j.companyEnricher?.logs?.length || 0,
      },
    };
  }
}

module.exports = new JobManager();