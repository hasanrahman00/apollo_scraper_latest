const fs = require('fs');
const path = require('path');
const jobs = require('../jobs/manager');
const { parseApolloUrl } = require('../utils/urlParser');
const { buildCsv } = require('../utils/csv');
const { addClient, send, broadcast } = require('../utils/sse');
const config = require('../../config');

jobs.on('update',       (job) => broadcast('job:update', jobs._safe(job)));
jobs.on('delete',       (id)  => broadcast('job:delete', { id }));
jobs.on('log',          (d)   => broadcast('job:log', d));
jobs.on('enricher:log', (d)   => broadcast('enricher:log', d));
jobs.on('company:log',  (d)   => broadcast('company:log', d));

function register(app) {

  app.get('/api/events', (req, res) => { const c = addClient(res); send(c, 'init', jobs.list()); });

  app.post('/api/parse-url', (req, res) => {
    try { res.json({ ok: true, payload: parseApolloUrl(req.body.url) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.get('/api/jobs', (req, res) => res.json(jobs.list()));

  // Single URL job
  app.post('/api/jobs', (req, res) => {
    const { name, url, maxPages, perPage } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const payload = parseApolloUrl(url);
    if (perPage) payload.per_page = parseInt(perPage, 10) || 25;
    res.json(jobs.create({ name, url, payload, maxPages: parseInt(maxPages, 10) || 100, perPage: parseInt(perPage, 10) || 25 }));
  });

  // Batch multi-URL job
  app.post('/api/jobs/batch', (req, res) => {
    const { name, urls, maxPages, perPage } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'urls array required' });

    const cleaned = [];
    for (const entry of urls) {
      const u = (entry.url || '').trim();
      if (!u) continue;
      cleaned.push({
        urlNumber: entry.urlNumber || entry.url_number || cleaned.length + 1,
        url: u,
        payload: null, // parsed in scrapeEngine before each URL
      });
    }
    if (cleaned.length === 0) return res.status(400).json({ error: 'No valid URLs' });

    res.json(jobs.create({
      name: name || `Batch (${cleaned.length} URLs)`,
      urls: cleaned,
      maxPages: parseInt(maxPages, 10) || 100,
      perPage: parseInt(perPage, 10) || 25,
    }));
  });

  app.delete('/api/jobs/:id', (req, res) => { res.json({ success: jobs.delete(req.params.id) }); });

  app.post('/api/jobs/:id/start', (req, res) => { const j = jobs.start(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.post('/api/jobs/:id/stop',  (req, res) => { const j = jobs.stop(req.params.id);  j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.post('/api/jobs/:id/rerun', (req, res) => { const j = jobs.rerun(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });

  app.get('/api/jobs/:id/csv', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (!job.results?.length) return res.status(400).json({ error: 'No data' });
    const csv = buildCsv(job.results);
    const fn = (job.name || 'apollo').replace(/[^a-zA-Z0-9_-]/g, '_') + `_${job.results.length}leads.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.send(Buffer.from(csv, 'utf-8'));
  });

  app.get('/api/jobs/:id/logs', (req, res) => { res.json({ logs: jobs.getLogs(req.params.id) }); });

  app.post('/api/jobs/:id/enricher/start', (req, res) => { const j = jobs.startEnricher(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.post('/api/jobs/:id/enricher/stop',  (req, res) => { const j = jobs.stopEnricher(req.params.id);  j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.post('/api/jobs/:id/enricher/rerun', (req, res) => { const j = jobs.rerunEnricher(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.get('/api/jobs/:id/enricher/logs',   (req, res) => { res.json({ logs: jobs.getEnricherLogs(req.params.id) }); });

  app.post('/api/jobs/:id/company/start', (req, res) => { const j = jobs.startCompanyEnricher(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.post('/api/jobs/:id/company/stop',  (req, res) => { const j = jobs.stopCompanyEnricher(req.params.id);  j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.post('/api/jobs/:id/company/rerun', (req, res) => { const j = jobs.rerunCompanyEnricher(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
  app.get('/api/jobs/:id/company/logs',   (req, res) => { res.json({ logs: jobs.getCompanyEnricherLogs(req.params.id) }); });

  app.get('/api/settings', (req, res) => {
    let saved = {};
    try { if (fs.existsSync(config.SETTINGS_FILE)) saved = JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8')); } catch {}
    res.json({ CHROME_PATH: saved.CHROME_PATH || config.DEFAULTS.CHROME_PATH, USER_DATA_DIR: saved.USER_DATA_DIR || config.DEFAULTS.USER_DATA_DIR, PORT: saved.PORT || config.DEFAULTS.PORT });
  });

  app.post('/api/settings', (req, res) => {
    const { CHROME_PATH, USER_DATA_DIR, PORT } = req.body || {};
    if (!CHROME_PATH || !USER_DATA_DIR) return res.status(400).json({ error: 'Required fields missing' });
    const dir = path.dirname(config.SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify({ CHROME_PATH: CHROME_PATH.trim(), USER_DATA_DIR: USER_DATA_DIR.trim(), PORT: parseInt(PORT, 10) || 9222 }, null, 2));
    res.json({ success: true, message: 'Saved!' });
  });
}

module.exports = { register };