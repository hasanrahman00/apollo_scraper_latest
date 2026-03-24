const { connectBrowser, getApolloPage } = require('./browserManager');
const { searchPeople } = require('./apolloClient');
const { flattenPerson } = require('../utils/csv');
const { parseApolloUrl } = require('../utils/urlParser');

const RETRY_DELAY = parseInt(process.env.SCRAPER_RETRY_DELAY, 10) || 3000;
const RATE_LIMIT_DELAY = (parseInt(process.env.SCRAPER_RATE_LIMIT_WAIT, 10) || 30) * 1000;
const PAGE_DELAY_MIN = parseInt(process.env.SCRAPER_PAGE_DELAY_MIN, 10) || 1500;
const PAGE_DELAY_RANGE = (parseInt(process.env.SCRAPER_PAGE_DELAY_MAX, 10) || 3000) - PAGE_DELAY_MIN;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchPage(apolloPage, payload, log) {
  try { return await searchPeople(apolloPage, payload); }
  catch (err) { log(`⚠️  Request failed: ${err.message}. Retrying...`); await sleep(RETRY_DELAY); return await searchPeople(apolloPage, payload); }
}

function checkStatus(resp, log) {
  if ([401, 403].includes(resp.status)) {
    log(`❌ Apollo ${resp.status}: Session expired. Log into Apollo in Chrome.`);
    return 'stop';
  }
  if (resp.status === 422) {
    const msg = resp.body?.error || JSON.stringify(resp.body).substring(0, 150);
    log(`⚠️  Apollo 422: ${msg}. Treating as rate limit — will retry...`);
    return 'rate_limited';
  }
  if (resp.status === 429) { log(`⏳ Rate limited (429). Waiting...`); return 'rate_limited'; }
  if (resp.status === 0) { log(`❌ Fetch error: ${resp.body?.error || 'Unknown'}`); return 'stop'; }
  if (resp.status !== 200) { log(`❌ Status ${resp.status}: ${JSON.stringify(resp.body).substring(0, 200)}`); return 'stop'; }
  return 'ok';
}

function extractData(body) {
  const people = body.people || body.contacts || [];
  const pagination = body.pagination || {};
  return { people, totalEntries: pagination.total_entries || 0, totalPages: pagination.total_pages || 0 };
}

// ─── Scrape a single URL ─────────────────────────────────────

async function scrapeOneUrl(apolloPage, job, urlEntry, seen, log, onProgress) {
  const { urlNumber, url, payload } = urlEntry;
  const maxPages = job.maxPages || 100;

  log(`\n${'═'.repeat(60)}`);
  log(`📌 URL #${urlNumber}: ${url.substring(0, 100)}`);
  log(`${'═'.repeat(60)}`);

  job.currentUrlNumber = urlNumber;
  job.currentUrlTotal = (job.urls || []).length || 1;
  onProgress(job);

  let pageNum = 1;
  let rateLimitRetries = 0;
  const MAX_RATE_RETRIES = 3;

  while (job.status === 'running') {
    if (pageNum > maxPages) { log(`🛑 Max pages (${maxPages}) for URL #${urlNumber}`); break; }

    const pagePayload = { ...payload, page: pageNum, cacheKey: Date.now() };
    log(`📄 URL #${urlNumber} — Page ${pageNum}...`);

    let resp;
    try { resp = await fetchPage(apolloPage, pagePayload, log); }
    catch (err) { log(`❌ Retry failed: ${err.message}. Stopping URL #${urlNumber}.`); break; }

    if (pageNum === 1) {
      const keys = Object.keys(resp.body || {});
      log(`📡 HTTP ${resp.status} — keys: [${keys.join(', ')}]`);
      if (resp.body?.pagination) log(`📊 Pagination: ${JSON.stringify(resp.body.pagination)}`);
    }

    const statusResult = checkStatus(resp, log);
    if (statusResult === 'stop') break;
    if (statusResult === 'rate_limited') {
      rateLimitRetries++;
      if (rateLimitRetries > MAX_RATE_RETRIES) {
        log(`❌ Rate limited ${MAX_RATE_RETRIES} times in a row. Moving to next URL.`);
        break;
      }
      log(`⏳ Waiting ${RATE_LIMIT_DELAY / 1000}s (${rateLimitRetries}/${MAX_RATE_RETRIES})...`);
      await sleep(RATE_LIMIT_DELAY);
      continue;
    }
    rateLimitRetries = 0;

    const { people, totalEntries, totalPages } = extractData(resp.body);

    if (pageNum === 1) {
      log(`🎯 URL #${urlNumber}: ${totalEntries.toLocaleString()} matching`);
    }

    if (people.length === 0) { log(`⚠️  0 people. Done with URL #${urlNumber}.`); break; }

    let added = 0, skipped = 0;
    for (const p of people) {
      const flat = flattenPerson(p, urlNumber, pageNum);
      const li = (flat.linkedin_url || '').trim().toLowerCase();
      if (li && seen.has(li)) { skipped++; continue; }
      if (li) seen.add(li);
      job.results.push(flat);
      added++;
    }

    job.currentPage = pageNum;
    job.totalScraped = job.results.length;

    const computed = totalPages || Math.ceil(totalEntries / (payload.per_page || 25));
    const skipMsg = skipped > 0 ? ` (${skipped} dupes)` : '';
    log(`✅ URL #${urlNumber} Page ${pageNum}: +${added}${skipMsg} (${job.totalScraped} total)`);
    onProgress(job);

    if (pageNum >= computed) { log(`🏁 URL #${urlNumber}: Last page (${computed}).`); break; }

    pageNum++;
    await sleep(PAGE_DELAY_MIN + Math.random() * PAGE_DELAY_RANGE);
  }
}

// ─── Main: single URL or multi-URL ──────────────────────────

async function runScrape(job, log, onProgress) {
  let browser = null;

  try {
    browser = await connectBrowser(log);
    const apolloPage = await getApolloPage(browser, log);

    const pageUrl = apolloPage.url();
    if (pageUrl.includes('/login') || pageUrl.includes('/sign-up')) {
      log('❌ Not logged into Apollo!'); job.status = 'failed'; onProgress(job); return;
    }

    log('🚀 Starting scrape via Chrome CDP...');

    // Dedup set
    const seen = new Set();
    for (const r of job.results) {
      const li = (r.linkedin_url || '').trim().toLowerCase();
      if (li) seen.add(li);
    }
    if (seen.size > 0) log(`🔄 Dedup: ${seen.size} existing leads`);

    // Multi-URL mode
    if (job.urls?.length > 0) {
      log(`📋 Batch mode: ${job.urls.length} URLs to process\n`);

      for (let i = 0; i < job.urls.length; i++) {
        if (job.status !== 'running') break;

        const entry = job.urls[i];
        if (!entry.payload) entry.payload = parseApolloUrl(entry.url);
        if (job.perPage) entry.payload.per_page = job.perPage;

        await scrapeOneUrl(apolloPage, job, entry, seen, log, onProgress);
      }
    }
    // Single URL mode (backward compatible)
    else {
      await scrapeOneUrl(apolloPage, job, {
        urlNumber: 1, url: job.url || '', payload: job.payload,
      }, seen, log, onProgress);
    }

    // Final status
    if (job.status === 'stopping' || job.status === 'stopped') {
      job.status = 'stopped';
      log(`\n⏸ Stopped. ${job.results.length} leads collected.`);
    } else if (job.status === 'running') {
      job.status = 'done'; job.progress = 100;
      log(`\n🏁 Done! ${job.results.length} total leads across ${job.urls?.length || 1} URL(s).`);
    }

  } catch (err) {
    job.status = 'failed';
    log(`💀 ${err.message}`);
  } finally {
    if (browser) { try { browser.close(); } catch {} }
  }

  onProgress(job);
}

module.exports = { runScrape };