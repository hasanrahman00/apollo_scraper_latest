const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { runScrape } = require('../services/scrapeEngine');
const { runEnricher } = require('../enricher/engine');
const { closeGeminiTab } = require('../enricher/geminiClient');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultEnricher() {
  return {
    status: 'idle', total: 0, done: 0, enriched: 0,
    progress: 0, logs: [], _geminiPage: null,
  };
}

// ─── Results file path per job ───────────────────────────────

function resultsPath(id) {
  return path.join(DATA_DIR, `${id}_results.json`);
}

class JobManager extends EventEmitter {

  constructor() {
    super();
    this.jobs = this._load();
  }

  // ─── Persistence ──────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(JOBS_FILE)) {
        const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
        for (const j of data) {
          if (j.status === 'running' || j.status === 'stopping') j.status = 'stopped';
          if (!j.logs) j.logs = [];
          if (!j.enricher) j.enricher = defaultEnricher();
          if (j.enricher.status === 'running' || j.enricher.status === 'stopping') {
            j.enricher.status = 'stopped';
          }
          j.enricher.logs = j.enricher.logs || [];
          j.enricher._geminiPage = null;

          // Load results from disk
          j.results = this._loadResults(j.id);
          j.totalScraped = j.results.length;
        }
        return data;
      }
    } catch {}
    return [];
  }

  _save() {
    // Save jobs metadata (no results — they go in separate files)
    const slim = this.jobs.map(j => ({
      ...j,
      results: undefined,
      resultCount: j.results?.length || 0,
      enricher: { ...j.enricher, _geminiPage: undefined },
    }));
    fs.writeFileSync(JOBS_FILE, JSON.stringify(slim, null, 2), 'utf-8');
  }

  _saveResults(id) {
    const job = this.get(id);
    if (!job || !job.results?.length) return;
    try {
      fs.writeFileSync(resultsPath(id), JSON.stringify(job.results), 'utf-8');
    } catch {}
  }

  _loadResults(id) {
    try {
      const p = resultsPath(id);
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch {}
    return [];
  }

  _deleteResults(id) {
    try {
      const p = resultsPath(id);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }

  // ─── Accessors ────────────────────────────────────────────

  list() { return this.jobs.map(j => this._safe(j)); }
  get(id) { return this.jobs.find(j => j.id === id); }
  getLogs(id) { return this.get(id)?.logs || []; }
  getEnricherLogs(id) { return this.get(id)?.enricher?.logs || []; }

  // ═══════════════════════════════════════════════════════════
  //  SCRAPER LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  create({ name, url, maxPages, perPage, payload }) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      id, name: name || 'Apollo Scrape', url: url || '',
      payload: payload || {},
      maxPages: maxPages || 100, perPage: perPage || 25,
      status: 'idle', progress: 0, currentPage: 1,
      totalFound: 0, totalScraped: 0,
      results: [], logs: [],
      createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null,
      enricher: defaultEnricher(),
    };
    this.jobs.push(job);
    this._save();
    this.emit('update', job);
    return this._safe(job);
  }

  delete(id) {
    const idx = this.jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this.stop(id);
    this.stopEnricher(id);
    this._deleteResults(id);
    this.jobs.splice(idx, 1);
    this._save();
    this.emit('delete', id);
    return true;
  }

  // ─── Start / Resume ───────────────────────────────────────
  //  First start (idle) → fresh. Everything else → resume.

  start(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'running') return this._safe(job);

    if (job.status === 'idle') {
      // First time — fresh start
      job.progress = 0; job.currentPage = 1;
      job.totalFound = 0; job.totalScraped = 0;
      job.results = []; job.logs = [];
      job.finishedAt = null;
    } else {
      // Resume — keep results, keep currentPage, keep enricher
      job.logs.push(`\n══ RESUMED from page ${job.currentPage} (${job.results.length} leads kept) ══`);
    }

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this._save();
    this.emit('update', job);
    this._runScrape(job);
    return this._safe(job);
  }

  // ─── Rerun = Resume (keep data, continue from last page) ──

  rerun(id) {
    const job = this.get(id);
    if (!job) return null;

    if (job.status === 'running') job.status = 'stopping';

    setTimeout(() => {
      // Keep results + currentPage — just resume
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.finishedAt = null;
      job.logs.push(`\n🔄 Rerun — resuming from page ${job.currentPage} (${job.results.length} leads kept)`);
      this._save();
      this.emit('update', job);
      this._runScrape(job);
    }, job.status === 'stopping' ? 2000 : 0);

    return this._safe(job);
  }

  // ─── Stop ─────────────────────────────────────────────────

  stop(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'running') {
      job.status = 'stopping';
      this._save();
      this._saveResults(id); // persist results to disk on stop
      this.emit('update', job);
    }
    return this._safe(job);
  }

  // ─── Internal: fire scrape ────────────────────────────────

  _runScrape(job) {
    const log = (msg) => {
      job.logs.push(msg);
      this.emit('log', { id: job.id, line: msg });
    };
    const onProgress = () => {
      this._save();
      this._saveResults(job.id); // persist results after every page
      this.emit('update', job);
    };

    runScrape(job, log, onProgress).then(() => {
      job.finishedAt = new Date().toISOString();
      this._save();
      this._saveResults(job.id);
      this.emit('update', job);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  ENRICHER LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  startEnricher(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.enricher.status === 'running') return this._safe(job);

    const isResume = job.enricher.status === 'stopped' && job.enricher.done > 0;
    if (!isResume) job.enricher = defaultEnricher();

    job.enricher.status = 'running';
    job.enricher.logs.push(isResume ? '\n══ ENRICHER RESUMED ══' : '🚀 Enricher started');
    this._save();
    this.emit('update', job);
    this._runEnricher(job);
    return this._safe(job);
  }

  stopEnricher(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.enricher.status === 'running') {
      job.enricher.status = 'stopping';
      if (job.enricher._geminiPage) {
        closeGeminiTab(job.enricher._geminiPage, () => {}).catch(() => {});
        job.enricher._geminiPage = null;
      }
      this._save();
      this._saveResults(id); // persist enriched results
      this.emit('update', job);
    }
    return this._safe(job);
  }

  rerunEnricher(id) {
    const job = this.get(id);
    if (!job) return null;

    if (job.enricher.status === 'running') {
      job.enricher.status = 'stopping';
      if (job.enricher._geminiPage) {
        closeGeminiTab(job.enricher._geminiPage, () => {}).catch(() => {});
        job.enricher._geminiPage = null;
      }
    }

    setTimeout(() => {
      job.enricher = defaultEnricher();
      job.enricher.status = 'running';
      job.enricher.logs.push('🔄 Enricher rerun — reprocessing all empty rows');
      this._save();
      this.emit('update', job);
      this._runEnricher(job);
    }, 2000);

    return this._safe(job);
  }

  _runEnricher(job) {
    const log = (msg) => {
      job.enricher.logs.push(msg);
      this.emit('enricher:log', { id: job.id, line: msg });
    };
    const onProgress = () => {
      this._save();
      this._saveResults(job.id); // persist enriched websites
      this.emit('update', job);
    };

    runEnricher(job, log, onProgress).then(() => {
      this._save();
      this._saveResults(job.id);
      this.emit('update', job);
    });
  }

  // ─── Safe projection ──────────────────────────────────────

  _safe(j) {
    return {
      id: j.id, name: j.name,
      url: (j.url || '').substring(0, 120),
      status: j.status, progress: j.progress,
      currentPage: j.currentPage,
      totalFound: j.totalFound,
      totalScraped: j.totalScraped || j.results?.length || 0,
      hasData: (j.results?.length || 0) > 0,
      logCount: j.logs?.length || 0,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      enricher: {
        status: j.enricher?.status || 'idle',
        total: j.enricher?.total || 0,
        done: j.enricher?.done || 0,
        enriched: j.enricher?.enriched || 0,
        progress: j.enricher?.progress || 0,
        logCount: j.enricher?.logs?.length || 0,
      },
    };
  }
}

module.exports = new JobManager();