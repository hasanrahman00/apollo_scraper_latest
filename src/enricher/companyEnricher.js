/**
 * Company Enricher — WATCHER MODE
 * Runs alongside scraper + website enricher.
 * Polls results for new domains needing company details.
 * Auto-stops when scraper done + website enricher done + all domains processed.
 */

const { connectBrowser, getApolloPage } = require('../services/browserManager');
const { cleanWebsite } = require('./urlCleaner');

const BATCH_SIZE = parseInt(process.env.ENRICHER_COMPANY_BATCH_SIZE, 10) || 10;
const BATCH_DELAY = 2000;
const POLL_INTERVAL = (parseInt(process.env.ENRICHER_POLL_INTERVAL, 10) || 10) * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Extract clean domain ────────────────────────────────────

function extractDomain(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).hostname.replace(/^www\./, '').replace(/\.$/, '').toLowerCase(); }
  catch { return ''; }
}

// ─── Call bulk_enrich via CDP ─────────────────────────────────

async function bulkEnrich(page, domains) {
  return await page.evaluate(async (doms) => {
    try {
      const metaCsrf = document.querySelector('meta[name="csrf-token"]');
      let csrf = metaCsrf ? metaCsrf.getAttribute('content') : '';
      if (!csrf) { const m = document.cookie.match(/X-CSRF-TOKEN=([^;]+)/); csrf = m ? decodeURIComponent(m[1]) : ''; }
      const res = await fetch('/api/v1/organizations/bulk_enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
        credentials: 'same-origin',
        body: JSON.stringify({ domains: doms }),
      });
      return { status: res.status, body: await res.json() };
    } catch (err) { return { status: 0, body: { error: err.message } }; }
  }, domains);
}

// ─── Collect new domains needing enrichment ──────────────────

function collectPendingDomains(results, enrichedDomains) {
  const domainRowMap = new Map(); // domain → [row indices]
  const newDomains = [];

  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    if (row._company_enriched) continue;

    const website = (row.organization_website || '').trim();
    if (!website) continue;

    const domain = extractDomain(website);
    if (!domain) continue;
    if (enrichedDomains.has(domain)) {
      // Domain already enriched — apply cached data to this row too
      continue;
    }

    if (!domainRowMap.has(domain)) {
      domainRowMap.set(domain, []);
      newDomains.push(domain);
    }
    domainRowMap.get(domain).push(i);
  }

  return { domainRowMap, newDomains };
}

// ─── Apply org data to matching rows ─────────────────────────

function applyOrg(org, domainRowMap, results, enrichedDomains, domainCache, log) {
  if (!org || typeof org !== 'object') return 0;

  const domain = (org.primary_domain || '').toLowerCase();
  const altDomain = extractDomain(org.website_url || '');
  const matchDomain = domainRowMap.has(domain) ? domain : domainRowMap.has(altDomain) ? altDomain : null;

  if (!matchDomain) return 0;

  const indices = domainRowMap.get(matchDomain) || [];
  let count = 0;

  // Cache the org data for this domain
  domainCache.set(matchDomain, org);
  enrichedDomains.add(matchDomain);

  for (const idx of indices) {
    const row = results[idx];
    if (!row) continue;

    row.company_city = org.city || '';
    row.company_state = org.state || '';
    row.company_country = org.country || '';
    row.company_address = org.street_address || '';
    row.company_postal = org.postal_code || '';
    row.company_revenue = org.organization_revenue_printed || '';
    row.company_sic = (org.sic_codes || []).join('; ');
    row.company_description = org.short_description || '';
    row._company_enriched = true;

    if (!row.organization_employees && org.estimated_num_employees) row.organization_employees = org.estimated_num_employees;
    if (!row.organization_industries && org.industries?.length) row.organization_industries = org.industries.join('; ');
    if (!row.organization_keywords && org.keywords?.length) row.organization_keywords = org.keywords.join('; ');
    if (!row.organization_phone && org.phone) row.organization_phone = org.phone;
    if (!row.organization_founded && org.founded_year) row.organization_founded = org.founded_year;

    count++;
  }

  if (count > 0) log(`  ✅ ${org.name || matchDomain}: ${count} row(s)`);
  return count;
}

// ─── Apply cached org to rows that got website later ─────────

function applyCachedToNewRows(results, enrichedDomains, domainCache) {
  let count = 0;
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    if (row._company_enriched) continue;

    const website = (row.organization_website || '').trim();
    if (!website) continue;

    const domain = extractDomain(website);
    if (!domain || !enrichedDomains.has(domain)) continue;

    const org = domainCache.get(domain);
    if (!org) continue;

    row.company_city = org.city || '';
    row.company_state = org.state || '';
    row.company_country = org.country || '';
    row.company_address = org.street_address || '';
    row.company_postal = org.postal_code || '';
    row.company_revenue = org.organization_revenue_printed || '';
    row.company_sic = (org.sic_codes || []).join('; ');
    row.company_description = org.short_description || '';
    row._company_enriched = true;

    if (!row.organization_employees && org.estimated_num_employees) row.organization_employees = org.estimated_num_employees;
    if (!row.organization_industries && org.industries?.length) row.organization_industries = org.industries.join('; ');
    if (!row.organization_keywords && org.keywords?.length) row.organization_keywords = org.keywords.join('; ');
    if (!row.organization_phone && org.phone) row.organization_phone = org.phone;
    if (!row.organization_founded && org.founded_year) row.organization_founded = org.founded_year;

    count++;
  }
  return count;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Main watcher loop ───────────────────────────────────────

async function runCompanyEnricher(job, log, onProgress) {
  let browser = null;
  const enrichedDomains = new Set();
  const domainCache = new Map(); // domain → org data (for rows that get website later)

  // Pre-mark already enriched
  for (const r of (job.results || [])) {
    if (r._company_enriched) {
      const d = extractDomain(r.organization_website || '');
      if (d) enrichedDomains.add(d);
    }
  }

  try {
    browser = await connectBrowser(log);
    const apolloPage = await getApolloPage(browser, log);

    log('👁️  Watcher active — monitoring for new domains...');

    while (job.companyEnricher.status === 'running') {
      // First: apply cached orgs to rows that got website from Website Enricher
      const cached = applyCachedToNewRows(job.results, enrichedDomains, domainCache);
      if (cached > 0) {
        job.companyEnricher.enriched = (job.companyEnricher.enriched || 0) + cached;
        log(`📋 Applied cached data to ${cached} newly-enriched rows`);
        onProgress(job);
      }

      // Collect new domains
      const { domainRowMap, newDomains } = collectPendingDomains(job.results, enrichedDomains);

      // Update stats
      job.companyEnricher.total = enrichedDomains.size + newDomains.length;
      job.companyEnricher.done = enrichedDomains.size;

      const scraperDone = ['done', 'stopped', 'failed', 'idle'].includes(job.status);
      const enricherDone = ['done', 'stopped', 'failed', 'idle'].includes(job.enricher?.status);
      const allUpstreamDone = scraperDone && enricherDone;
      const shouldProcess = newDomains.length >= BATCH_SIZE || (allUpstreamDone && newDomains.length > 0);

      if (shouldProcess) {
        const batches = chunk(newDomains, BATCH_SIZE);

        for (let bi = 0; bi < batches.length; bi++) {
          if (job.companyEnricher.status !== 'running') break;

          const batch = batches[bi];
          log(`\n📦 Batch ${bi + 1}/${batches.length} (${batch.length} domains)`);

          let resp;
          try {
            resp = await bulkEnrich(apolloPage, batch);
          } catch (err) {
            log(`⚠️  Request failed: ${err.message}. Skipping.`);
            batch.forEach(d => enrichedDomains.add(d)); // mark as attempted
            continue;
          }

          if (resp.status === 429) {
            log('⏳ Rate limited. Waiting 30s...');
            await sleep(30000);
            bi--; continue;
          }

          if (resp.status !== 200) {
            log(`⚠️  HTTP ${resp.status}: ${JSON.stringify(resp.body?.error || resp.body).substring(0, 200)}`);
            batch.forEach(d => enrichedDomains.add(d));
            continue;
          }

          const orgs = resp.body.organizations || [];
          log(`📝 ${orgs.length} organizations returned`);

          let batchEnriched = 0;
          for (const org of orgs) {
            try { batchEnriched += applyOrg(org, domainRowMap, job.results, enrichedDomains, domainCache, log); }
            catch (err) { log(`⚠️  Skip ${org?.name || 'unknown'}: ${err.message}`); }
          }

          // Mark domains without results as attempted
          batch.forEach(d => enrichedDomains.add(d));

          job.companyEnricher.done = enrichedDomains.size;
          job.companyEnricher.enriched = (job.companyEnricher.enriched || 0) + batchEnriched;
          log(`📊 +${batchEnriched} rows (${job.companyEnricher.enriched} total)`);
          onProgress(job);

          if (bi < batches.length - 1) await sleep(BATCH_DELAY);
        }

        // Check if all upstream done and no more pending
        if (allUpstreamDone) {
          const { newDomains: remaining } = collectPendingDomains(job.results, enrichedDomains);
          if (remaining.length === 0) {
            // Final pass: apply cache to any stragglers
            applyCachedToNewRows(job.results, enrichedDomains, domainCache);
            log('🏁 All upstream done + all domains processed. Company enricher complete.');
            job.companyEnricher.status = 'done';
            job.companyEnricher.progress = 100;
            break;
          }
        }
      } else if (allUpstreamDone && newDomains.length === 0) {
        // Final cache apply
        applyCachedToNewRows(job.results, enrichedDomains, domainCache);
        log('🏁 All done. No domains to enrich.');
        job.companyEnricher.status = 'done';
        job.companyEnricher.progress = 100;
        break;
      } else {
        if (newDomains.length > 0) {
          log(`⏳ ${newDomains.length} domains pending (need ${BATCH_SIZE} or upstream done). Watching...`);
        }
        await sleep(POLL_INTERVAL);
      }

      job.companyEnricher.progress = job.companyEnricher.total > 0
        ? Math.min(95, Math.floor((enrichedDomains.size / job.companyEnricher.total) * 100)) : 0;
      onProgress(job);
    }

    if (job.companyEnricher.status === 'stopping') {
      job.companyEnricher.status = 'stopped';
      log(`⏸ Company enricher stopped. ${job.companyEnricher.enriched || 0} rows enriched.`);
    }

  } catch (err) {
    job.companyEnricher.status = 'failed';
    log(`💀 Fatal: ${err.message}`);
  } finally {
    if (browser) { try { browser.close(); } catch {} }
  }

  onProgress(job);
}

module.exports = { runCompanyEnricher, extractDomain };