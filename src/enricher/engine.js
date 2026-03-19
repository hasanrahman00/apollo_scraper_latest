/**
 * Website Enricher — WATCHER MODE
 * Runs alongside the scraper. Polls results for new rows needing websites.
 * Batches up to ENRICHER_BATCH_SIZE then queries Gemini.
 * Auto-stops when scraper is done + all rows processed.
 */

const { connectBrowser, getApolloPage } = require('../services/browserManager');
const { openGeminiTab, closeGeminiTab, sendQuery, parseJsonFromResponse } = require('./geminiClient');
const { cleanWebsite } = require('./urlCleaner');

const BATCH_SIZE = parseInt(process.env.ENRICHER_BATCH_SIZE, 10) || 200;
const BATCH_DELAY = parseInt(process.env.ENRICHER_BATCH_DELAY, 10) || 3000;
const POLL_INTERVAL = (parseInt(process.env.ENRICHER_POLL_INTERVAL, 10) || 10) * 1000;
const GEMINI_COOLDOWN = (parseInt(process.env.ENRICHER_GEMINI_COOLDOWN, 10) || 30) * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Collect rows needing website enrichment ─────────────────

function collectPending(results, processedSet) {
  const needLinkedin = [];
  const needCompany = [];

  for (let i = 0; i < results.length; i++) {
    if (processedSet.has(i)) continue;
    const row = results[i];
    if ((row.organization_website || '').trim()) { processedSet.add(i); continue; } // already has website

    const linkedin = (row.organization_linkedin || '').trim();
    const company = (row.organization_name || '').trim();

    if (linkedin) needLinkedin.push({ idx: i, value: linkedin });
    else if (company) needCompany.push({ idx: i, value: company });
    else processedSet.add(i); // no linkedin, no name — skip permanently
  }

  return { needLinkedin, needCompany };
}

// ─── Query builders ──────────────────────────────────────────

function buildLinkedInQuery(items) {
  const list = items.map((it, i) => `${i + 1}. ${it.value}`).join('\n');
  return `Find all the companies' websites by searching linkedin.
Reply with ONLY a valid JSON array. No markdown fences, no explanation.
Format: [{"linkedin":"<exact_linkedin_url>","website":"<website_or_empty>"}]
If you cannot find a website, use empty string "".

${list}`;
}

function buildCompanyQuery(items) {
  const list = items.map((it, i) => `${i + 1}. ${it.value}`).join('\n');
  return `Find all the companies' websites by searching Company name.
Reply with ONLY a valid JSON array. No markdown fences, no explanation.
Format: [{"company":"<exact_company_name>","website":"<website_or_empty>"}]
If you cannot find a website, use empty string "".

${list}`;
}

// ─── Apply results back to rows ──────────────────────────────

function applyLinkedInResults(parsed, batch, results, processedSet, log) {
  let count = 0;
  for (const item of batch) {
    processedSet.add(item.idx);
    const match = parsed.find(r => {
      const rl = (r.linkedin || '').toLowerCase().trim();
      const il = item.value.toLowerCase().trim();
      return rl === il || il.includes(rl) || rl.includes(il);
    });
    if (match?.website) {
      const clean = cleanWebsite(match.website);
      if (clean) { results[item.idx].organization_website = clean; count++; log(`  ✅ [${item.idx}] ${item.value} → ${clean}`); }
    }
  }
  return count;
}

function applyCompanyResults(parsed, batch, results, processedSet, log) {
  let count = 0;
  for (const item of batch) {
    processedSet.add(item.idx);
    const match = parsed.find(r => {
      const rc = (r.company || '').toLowerCase().trim();
      const ic = item.value.toLowerCase().trim();
      return rc === ic || rc.includes(ic) || ic.includes(rc);
    });
    if (match?.website) {
      const clean = cleanWebsite(match.website);
      if (clean) { results[item.idx].organization_website = clean; count++; log(`  ✅ [${item.idx}] "${item.value}" → ${clean}`); }
    }
  }
  return count;
}

// ─── Process a batch through Gemini ──────────────────────────

async function processBatch(geminiPage, items, type, results, processedSet, log) {
  const query = type === 'linkedin' ? buildLinkedInQuery(items) : buildCompanyQuery(items);

  let responseText;
  try {
    responseText = await sendQuery(geminiPage, query, log);
  } catch (err) {
    log(`⚠️  Gemini query failed: ${err.message}. Marking batch as processed.`);
    items.forEach(it => processedSet.add(it.idx));
    return 0;
  }

  const parsed = parseJsonFromResponse(responseText);
  log(`📝 Parsed ${parsed.length} results`);

  return type === 'linkedin'
    ? applyLinkedInResults(parsed, items, results, processedSet, log)
    : applyCompanyResults(parsed, items, results, processedSet, log);
}

// ─── Main watcher loop ───────────────────────────────────────

async function runEnricher(job, log, onProgress) {
  let browser = null;
  let geminiPage = null;
  const processedSet = new Set();

  // Pre-mark rows that already have websites
  for (let i = 0; i < (job.results || []).length; i++) {
    if ((job.results[i].organization_website || '').trim()) processedSet.add(i);
    if (job.results[i]._website_enriched) processedSet.add(i);
  }

  try {
    browser = await connectBrowser(log);
    geminiPage = await openGeminiTab(browser, log);
    job.enricher._geminiPage = geminiPage;

    log('👁️  Watcher active — monitoring for new rows...');

    while (job.enricher.status === 'running') {
      const { needLinkedin, needCompany } = collectPending(job.results, processedSet);
      const totalPending = needLinkedin.length + needCompany.length;

      // Update stats
      job.enricher.total = processedSet.size + totalPending;
      job.enricher.done = processedSet.size;

      const scraperDone = ['done', 'stopped', 'failed', 'idle'].includes(job.status);
      const shouldProcess = totalPending >= BATCH_SIZE || (scraperDone && totalPending > 0);

      if (shouldProcess) {
        // ── Process LinkedIn batch ───────────
        if (needLinkedin.length > 0 && job.enricher.status === 'running') {
          log(`\n📦 LinkedIn batch: ${needLinkedin.length} companies`);
          const enriched = await processBatch(geminiPage, needLinkedin, 'linkedin', job.results, processedSet, log);
          job.enricher.enriched = (job.enricher.enriched || 0) + enriched;
          log(`📊 +${enriched} websites found (${job.enricher.enriched} total)`);
          // Mark processed rows
          needLinkedin.forEach(it => { job.results[it.idx]._website_enriched = true; });
          onProgress(job);
          await sleep(GEMINI_COOLDOWN);
        }

        // ── Process Company Name batch ───────
        if (needCompany.length > 0 && job.enricher.status === 'running') {
          log(`\n📦 Company Name batch: ${needCompany.length} companies`);
          const enriched = await processBatch(geminiPage, needCompany, 'company', job.results, processedSet, log);
          job.enricher.enriched = (job.enricher.enriched || 0) + enriched;
          log(`📊 +${enriched} websites found (${job.enricher.enriched} total)`);
          needCompany.forEach(it => { job.results[it.idx]._website_enriched = true; });
          onProgress(job);
          await sleep(GEMINI_COOLDOWN);
        }

        // If scraper is done and we just processed the last batch → we're done
        if (scraperDone) {
          const { needLinkedin: nl, needCompany: nc } = collectPending(job.results, processedSet);
          if (nl.length === 0 && nc.length === 0) {
            log('🏁 Scraper done + all rows processed. Website enricher complete.');
            job.enricher.status = 'done';
            job.enricher.progress = 100;
            break;
          }
        }
      } else if (scraperDone && totalPending === 0) {
        // Scraper done, nothing to process
        log('🏁 Scraper done + no rows need enrichment. Done.');
        job.enricher.status = 'done';
        job.enricher.progress = 100;
        break;
      } else {
        // Waiting for more rows from scraper
        if (totalPending > 0) {
          log(`⏳ ${totalPending} rows pending (need ${BATCH_SIZE} for batch). Watching...`);
        }
        await sleep(POLL_INTERVAL);
      }

      // Update progress
      const total = processedSet.size + totalPending;
      job.enricher.progress = total > 0 ? Math.min(95, Math.floor((processedSet.size / total) * 100)) : 0;
      onProgress(job);
    }

    if (job.enricher.status === 'stopping') {
      job.enricher.status = 'stopped';
      log(`⏸ Website enricher stopped. ${job.enricher.enriched || 0} websites found.`);
    }

  } catch (err) {
    job.enricher.status = 'failed';
    log(`💀 Fatal: ${err.message}`);
  } finally {
    if (geminiPage) { await closeGeminiTab(geminiPage, log); job.enricher._geminiPage = null; }
    if (browser) { try { browser.close(); } catch {} }
  }

  onProgress(job);
}

module.exports = { runEnricher };