/**
 * Website Enricher Engine
 * Pass 1: Enrich via Company LinkedIn URL
 * Pass 2: Enrich remaining via Company Name
 * Tracks rows by original index to prevent mismatch.
 */

const { connectBrowser } = require('../services/browserManager');
const { openGeminiTab, closeGeminiTab, sendQuery, parseJsonFromResponse } = require('./geminiClient');
const { cleanWebsite } = require('./urlCleaner');

const BATCH_SIZE = parseInt(process.env.ENRICHER_BATCH_SIZE, 10) || 200;
const BATCH_DELAY = parseInt(process.env.ENRICHER_BATCH_DELAY, 10) || 3000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Build query for LinkedIn batch ──────────────────────────

function buildLinkedInQuery(items) {
  const list = items.map((it, i) => `${i + 1}. ${it.value}`).join('\n');
  return `Find all the companies' websites by searching linkedin.
Reply with ONLY a valid JSON array. No markdown fences, no explanation.
Format: [{"linkedin":"<exact_linkedin_url>","website":"<website_or_empty>"}]
If you cannot find a website, use empty string "".

${list}`;
}

// ─── Build query for Company Name batch ──────────────────────

function buildCompanyQuery(items) {
  const list = items.map((it, i) => `${i + 1}. ${it.value}`).join('\n');
  return `Find all the companies' websites by searching Company name.
Reply with ONLY a valid JSON array. No markdown fences, no explanation.
Format: [{"company":"<exact_company_name>","website":"<website_or_empty>"}]
If you cannot find a website, use empty string "".

${list}`;
}

// ─── Collect rows that need enrichment ───────────────────────

function findEmptyWebsiteRows(results) {
  const needLinkedin = [];  // rows with Company LinkedIn but no Website
  const needCompany = [];   // rows with Company Name but no LinkedIn and no Website

  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    const hasWebsite = (row.organization_website || '').trim() !== '';
    if (hasWebsite) continue;

    const linkedin = (row.organization_linkedin || '').trim();
    const company = (row.organization_name || '').trim();

    if (linkedin) {
      needLinkedin.push({ idx: i, value: linkedin });
    } else if (company) {
      needCompany.push({ idx: i, value: company });
    }
  }

  return { needLinkedin, needCompany };
}

// ─── Process a batch and apply results ───────────────────────

function applyLinkedInResults(parsed, batch, results, log) {
  let count = 0;

  for (const item of batch) {
    // Find matching result from Gemini
    const match = parsed.find(r => {
      const rl = (r.linkedin || r.linkedin_url || '').toLowerCase().trim();
      const il = item.value.toLowerCase().trim();
      // Match by containing the company slug
      return rl === il || il.includes(rl) || rl.includes(il);
    });

    if (match && match.website) {
      const clean = cleanWebsite(match.website);
      if (clean) {
        results[item.idx].organization_website = clean;
        count++;
        log(`  ✅ [${item.idx}] ${item.value} → ${clean}`);
      }
    }
  }

  return count;
}

function applyCompanyResults(parsed, batch, results, log) {
  let count = 0;

  for (const item of batch) {
    const match = parsed.find(r => {
      const rc = (r.company || r.company_name || '').toLowerCase().trim();
      const ic = item.value.toLowerCase().trim();
      return rc === ic || rc.includes(ic) || ic.includes(rc);
    });

    if (match && match.website) {
      const clean = cleanWebsite(match.website);
      if (clean) {
        results[item.idx].organization_website = clean;
        count++;
        log(`  ✅ [${item.idx}] "${item.value}" → ${clean}`);
      }
    }
  }

  return count;
}

// ─── Chunk array into batches ────────────────────────────────

function chunk(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

// ─── Main enrichment runner ──────────────────────────────────

async function runEnricher(job, log, onProgress) {
  let browser = null;
  let geminiPage = null;

  try {
    // ── Validate ─────────────────────────────────────
    if (!job.results?.length) {
      log('❌ No scrape data to enrich. Run the scraper first.');
      job.enricher.status = 'failed';
      onProgress(job);
      return;
    }

    // ── Scan for empty websites ──────────────────────
    const { needLinkedin, needCompany } = findEmptyWebsiteRows(job.results);
    const total = needLinkedin.length + needCompany.length;

    if (total === 0) {
      log('✅ All rows already have websites. Nothing to enrich.');
      job.enricher.status = 'done';
      job.enricher.progress = 100;
      onProgress(job);
      return;
    }

    job.enricher.total = total;
    job.enricher.done = 0;
    log(`📊 ${total} rows need websites (${needLinkedin.length} via LinkedIn, ${needCompany.length} via Company Name)`);
    log(`⚙️  Batch size: ${BATCH_SIZE}, Max wait: ${Math.round(parseInt(process.env.ENRICHER_MAX_WAIT, 10) || 600) / 60}min, Delay: ${BATCH_DELAY}ms`);
    onProgress(job);

    // ── Connect browser + open Gemini ────────────────
    browser = await connectBrowser(log);
    geminiPage = await openGeminiTab(browser, log);

    // Store page ref for cleanup
    job.enricher._geminiPage = geminiPage;

    // ═══ PASS 1: Company LinkedIn ════════════════════
    if (needLinkedin.length > 0 && job.enricher.status === 'running') {
      log(`\n══ Pass 1: Enriching via Company LinkedIn (${needLinkedin.length} rows) ══`);
      const batches = chunk(needLinkedin, BATCH_SIZE);

      for (let bi = 0; bi < batches.length; bi++) {
        if (job.enricher.status !== 'running') break;

        const batch = batches[bi];
        log(`\n📦 Batch ${bi + 1}/${batches.length} (${batch.length} companies)`);

        const query = buildLinkedInQuery(batch);
        let responseText;

        try {
          responseText = await sendQuery(geminiPage, query, log);
        } catch (err) {
          log(`⚠️  Query failed: ${err.message}. Skipping batch.`);
          job.enricher.done += batch.length;
          onProgress(job);
          continue;
        }

        const parsed = parseJsonFromResponse(responseText);
        log(`📝 Parsed ${parsed.length} results from Gemini`);

        const enriched = applyLinkedInResults(parsed, batch, job.results, log);
        job.enricher.done += batch.length;
        job.enricher.enriched = (job.enricher.enriched || 0) + enriched;
        log(`📊 Batch: ${enriched}/${batch.length} enriched (${job.enricher.done}/${total} processed)`);
        onProgress(job);

        if (bi < batches.length - 1) await sleep(BATCH_DELAY);
      }
    }

    // ═══ PASS 2: Company Name ════════════════════════
    // Re-scan: some may have been filled in pass 1
    const { needCompany: stillNeedCompany } = findEmptyWebsiteRows(job.results);
    const pass2List = stillNeedCompany.filter(item => {
      // Only process rows that don't have LinkedIn (pure company name search)
      return !(job.results[item.idx].organization_linkedin || '').trim();
    });

    if (pass2List.length > 0 && job.enricher.status === 'running') {
      log(`\n══ Pass 2: Enriching via Company Name (${pass2List.length} rows) ══`);
      const batches = chunk(pass2List, BATCH_SIZE);

      for (let bi = 0; bi < batches.length; bi++) {
        if (job.enricher.status !== 'running') break;

        const batch = batches[bi];
        log(`\n📦 Batch ${bi + 1}/${batches.length} (${batch.length} companies)`);

        const query = buildCompanyQuery(batch);
        let responseText;

        try {
          responseText = await sendQuery(geminiPage, query, log);
        } catch (err) {
          log(`⚠️  Query failed: ${err.message}. Skipping batch.`);
          job.enricher.done += batch.length;
          onProgress(job);
          continue;
        }

        const parsed = parseJsonFromResponse(responseText);
        log(`📝 Parsed ${parsed.length} results from Gemini`);

        const enriched = applyCompanyResults(parsed, batch, job.results, log);
        job.enricher.done += batch.length;
        job.enricher.enriched = (job.enricher.enriched || 0) + enriched;
        log(`📊 Batch: ${enriched}/${batch.length} enriched (${job.enricher.done}/${total} processed)`);
        onProgress(job);

        if (bi < batches.length - 1) await sleep(BATCH_DELAY);
      }
    }

    // ── Done ─────────────────────────────────────────
    if (job.enricher.status === 'stopping') {
      job.enricher.status = 'stopped';
      log(`\n⏸ Enricher stopped. ${job.enricher.enriched || 0}/${total} enriched.`);
    } else if (job.enricher.status === 'running') {
      job.enricher.status = 'done';
      job.enricher.progress = 100;

      // Count final
      const remaining = job.results.filter(r => !(r.organization_website || '').trim()).length;
      log(`\n🏁 Enrichment done! ${job.enricher.enriched || 0} websites found. ${remaining} still empty.`);
    }

  } catch (err) {
    job.enricher.status = 'failed';
    log(`💀 Enricher fatal: ${err.message}`);
  } finally {
    // Close Gemini tab (not the browser)
    if (geminiPage) {
      await closeGeminiTab(geminiPage, log);
      job.enricher._geminiPage = null;
    }
    // Disconnect CDP (doesn't close Chrome)
    if (browser) {
      try { browser.close(); } catch {}
    }
  }

  onProgress(job);
}

module.exports = { runEnricher };