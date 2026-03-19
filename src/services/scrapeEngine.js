const { connectBrowser, getApolloPage } = require('./browserManager');
const { searchPeople } = require('./apolloClient');
const { flattenPerson } = require('../utils/csv');

const RETRY_DELAY = parseInt(process.env.SCRAPER_RETRY_DELAY, 10) || 3000;
const RATE_LIMIT_DELAY = (parseInt(process.env.SCRAPER_RATE_LIMIT_WAIT, 10) || 30) * 1000;
const PAGE_DELAY_MIN = parseInt(process.env.SCRAPER_PAGE_DELAY_MIN, 10) || 1500;
const PAGE_DELAY_RANGE = (parseInt(process.env.SCRAPER_PAGE_DELAY_MAX, 10) || 3000) - PAGE_DELAY_MIN;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Fetch single page with one retry ────────────────────────

async function fetchPage(apolloPage, payload, log) {
  try {
    return await searchPeople(apolloPage, payload);
  } catch (err) {
    log(`⚠️  Request failed: ${err.message}. Retrying...`);
    await sleep(RETRY_DELAY);
    return await searchPeople(apolloPage, payload);
  }
}

// ─── Check response status ───────────────────────────────────

function checkStatus(resp, log) {
  if ([401, 403, 422].includes(resp.status)) {
    log(`❌ Apollo ${resp.status}: Session expired. Log into Apollo in Chrome and retry.`);
    log(`🔍 Body: ${JSON.stringify(resp.body).substring(0, 300)}`);
    return 'stop';
  }
  if (resp.status === 429) {
    log(`⏳ Rate limited. Waiting ${RATE_LIMIT_DELAY / 1000}s...`);
    return 'rate_limited';
  }
  if (resp.status === 0) {
    log(`❌ Fetch error: ${resp.body?.error || 'Unknown'}`);
    return 'stop';
  }
  if (resp.status !== 200) {
    log(`❌ Status ${resp.status}: ${JSON.stringify(resp.body).substring(0, 200)}`);
    return 'stop';
  }
  return 'ok';
}

// ─── Extract people + pagination ─────────────────────────────

function extractData(body) {
  const people = body.people || body.contacts || [];
  const pagination = body.pagination || {};
  return {
    people,
    totalEntries: pagination.total_entries || body.num_fetch_result || 0,
    totalPages: pagination.total_pages || 0,
  };
}

// ─── Main scrape loop ────────────────────────────────────────

async function runScrape(job, log, onProgress) {
  let browser = null;

  try {
    // ── Step 1: Connect to Chrome ────────────────────
    browser = await connectBrowser(log);
    const apolloPage = await getApolloPage(browser, log);

    // Verify logged in
    const pageUrl = apolloPage.url();
    if (pageUrl.includes('/login') || pageUrl.includes('/sign-up')) {
      log('❌ Not logged into Apollo! Please log in via Chrome first.');
      job.status = 'failed';
      onProgress(job);
      return;
    }

    log('🚀 Starting scrape via Chrome CDP...');

    // ── Build dedup set from existing results (Person LinkedIn) ──
    const seen = new Set();
    for (const r of job.results) {
      const li = (r.linkedin_url || '').trim().toLowerCase();
      if (li) seen.add(li);
    }
    if (seen.size > 0) log(`🔄 Dedup tracker loaded: ${seen.size} existing leads`);

    // ── Step 2: Pagination loop ──────────────────────
    const startPage = job.currentPage || 1;
    let pageNum = startPage;

    while (job.status === 'running') {
      // Max pages guard
      if (pageNum - startPage >= job.maxPages) {
        log(`🛑 Max pages reached (${job.maxPages})`);
        break;
      }

      const payload = { ...job.payload, page: pageNum, cacheKey: Date.now() };
      log(`📄 Fetching page ${pageNum}...`);

      let resp;
      try {
        resp = await fetchPage(apolloPage, payload, log);
      } catch (err) {
        log(`❌ Retry also failed: ${err.message}. Stopping.`);
        break;
      }

      // Debug logging on first page
      if (pageNum === startPage) {
        const keys = Object.keys(resp.body || {});
        log(`📡 HTTP ${resp.status} — keys: [${keys.join(', ')}]`);
        if (resp.body?.pagination) {
          log(`📊 Pagination: ${JSON.stringify(resp.body.pagination)}`);
        }
      }

      const statusResult = checkStatus(resp, log);
      if (statusResult === 'stop') break;
      if (statusResult === 'rate_limited') {
        await sleep(RATE_LIMIT_DELAY);
        continue;
      }

      const { people, totalEntries, totalPages } = extractData(resp.body);

      // Set total on first page
      if (pageNum === startPage) {
        job.totalFound = totalEntries;
        log(`🎯 Total matching: ${totalEntries.toLocaleString()}`);

        // Debug: dump RAW first person from Apollo
        if (people.length > 0) {
          const p0 = people[0];
          log(`🔍 RAW person[0] ALL KEYS: ${Object.keys(p0).join(', ')}`);
          log(`🔍 RAW person[0].organization exists: ${'organization' in p0}`);
          log(`🔍 RAW person[0].organization value: ${JSON.stringify(p0.organization)?.substring(0, 400)}`);
          log(`🔍 RAW person[0] full dump: ${JSON.stringify(p0).substring(0, 800)}`);

          // Also test flattenPerson right here
          const testFlat = flattenPerson(p0);
          log(`🔍 FLAT employees: "${testFlat.organization_employees}"`);
          log(`🔍 FLAT industries: "${testFlat.organization_industries}"`);
          log(`🔍 FLAT keywords: "${testFlat.organization_keywords}"`);
        }
      }

      if (people.length === 0) {
        log(`⚠️  0 people. total=${totalEntries}, pages=${totalPages}`);
        log(`🔍 Snippet: ${JSON.stringify(resp.body).substring(0, 300)}`);
        break;
      }

      // Flatten + accumulate (dedup by Person LinkedIn)
      let added = 0;
      let skipped = 0;
      for (const p of people) {
        const flat = flattenPerson(p);
        const li = (flat.linkedin_url || '').trim().toLowerCase();
        if (li && seen.has(li)) {
          skipped++;
          continue;
        }
        if (li) seen.add(li);
        job.results.push(flat);
        added++;
      }

      job.currentPage = pageNum;
      job.totalScraped = job.results.length;

      const computed = totalPages || Math.ceil(totalEntries / (job.payload.per_page || 25));
      job.progress = computed > 0 ? Math.min(95, Math.floor((pageNum / computed) * 100)) : 0;

      const skipMsg = skipped > 0 ? ` (${skipped} dupes skipped)` : '';
      log(`✅ Page ${pageNum}: +${added} leads${skipMsg} (${job.totalScraped}/${job.totalFound})`);
      onProgress(job);

      // Last page?
      if (pageNum >= computed) {
        log(`🏁 Last page (${computed}).`);
        break;
      }

      pageNum++;
      await sleep(PAGE_DELAY_MIN + Math.random() * PAGE_DELAY_RANGE);
    }

    // ── Final status ─────────────────────────────────
    if (job.status === 'stopping' || job.status === 'stopped') {
      job.status = 'stopped';
      log(`⏸ Stopped. ${job.results.length} leads collected.`);
    } else if (job.status === 'running') {
      job.status = 'done';
      job.progress = 100;
      log(`🏁 Done! ${job.results.length} total leads.`);
    }

  } catch (err) {
    job.status = 'failed';
    log(`💀 ${err.message}`);
  } finally {
    // Disconnect CDP (does NOT close Chrome)
    if (browser) {
      try { browser.close(); } catch {}
    }
  }

  onProgress(job);
}

module.exports = { runScrape };