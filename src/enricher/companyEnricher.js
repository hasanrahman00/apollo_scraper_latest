/**
 * Company Enricher — uses Apollo's /api/v1/organizations/bulk_enrich
 * Batches domains from the Website column, enriches company details.
 * Matches back to rows by clean domain.
 */

const { connectBrowser, getApolloPage } = require('../services/browserManager');
const { cleanWebsite } = require('./urlCleaner');

const BATCH_SIZE = parseInt(process.env.ENRICHER_COMPANY_BATCH_SIZE, 10) || 10;
const BATCH_DELAY = 2000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Extract clean domain from URL ───────────────────────────

function extractDomain(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    return new URL(u).hostname.replace(/^www\./, '').replace(/\.$/, '').toLowerCase();
  } catch { return ''; }
}

// ─── Call bulk_enrich via CDP ─────────────────────────────────

async function bulkEnrich(page, domains) {
  return await page.evaluate(async (doms) => {
    try {
      const metaCsrf = document.querySelector('meta[name="csrf-token"]');
      let csrf = metaCsrf ? metaCsrf.getAttribute('content') : '';
      if (!csrf) {
        const match = document.cookie.match(/X-CSRF-TOKEN=([^;]+)/);
        csrf = match ? decodeURIComponent(match[1]) : '';
      }
      const res = await fetch('/api/v1/organizations/bulk_enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
        credentials: 'same-origin',
        body: JSON.stringify({ domains: doms }),
      });
      const body = await res.json();
      return { status: res.status, body };
    } catch (err) {
      return { status: 0, body: { error: err.message } };
    }
  }, domains);
}

// ─── Build domain → row index map ────────────────────────────

function buildDomainMap(results) {
  // Map: domain → [row indices] (multiple people can share same company)
  const map = new Map();
  const needEnrich = [];

  for (let i = 0; i < results.length; i++) {
    const website = (results[i].organization_website || '').trim();
    if (!website) continue;

    const domain = extractDomain(website);
    if (!domain) continue;

    // Only enrich rows missing company location
    const hasLocation = (results[i].company_city || '').trim();
    if (hasLocation) continue;

    if (!map.has(domain)) {
      map.set(domain, []);
      needEnrich.push(domain);
    }
    map.get(domain).push(i);
  }

  return { map, needEnrich };
}

// ─── Apply enrichment data back to rows ──────────────────────

function applyEnrichment(org, domainMap, results, log) {
  const domain = (org.primary_domain || '').toLowerCase();
  if (!domain) return 0;

  const indices = domainMap.get(domain);
  if (!indices || indices.length === 0) {
    // Try matching by website_url
    const altDomain = extractDomain(org.website_url || '');
    const altIndices = domainMap.get(altDomain);
    if (!altIndices || altIndices.length === 0) return 0;
    return applyToRows(org, altIndices, results, log);
  }

  return applyToRows(org, indices, results, log);
}

function applyToRows(org, indices, results, log) {
  let count = 0;
  for (const idx of indices) {
    const row = results[idx];

    row.company_city = org.city || '';
    row.company_state = org.state || '';
    row.company_country = org.country || '';
    row.company_address = org.street_address || '';
    row.company_postal = org.postal_code || '';
    row.company_revenue = org.organization_revenue_printed || '';
    row.company_sic = (org.sic_codes || []).join('; ');
    row.company_description = org.short_description || '';

    // Also fill missing fields from people endpoint
    if (!row.organization_employees && org.estimated_num_employees) {
      row.organization_employees = org.estimated_num_employees;
    }
    if (!row.organization_industries && org.industries?.length) {
      row.organization_industries = org.industries.join('; ');
    }
    if (!row.organization_keywords && org.keywords?.length) {
      row.organization_keywords = org.keywords.join('; ');
    }
    if (!row.organization_phone && org.phone) {
      row.organization_phone = org.phone;
    }
    if (!row.organization_founded && org.founded_year) {
      row.organization_founded = org.founded_year;
    }

    count++;
  }

  if (count > 0) {
    log(`  ✅ ${org.name || org.primary_domain}: ${count} row(s) enriched`);
  }
  return count;
}

// ─── Chunk helper ────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Main company enricher ───────────────────────────────────

async function runCompanyEnricher(job, log, onProgress) {
  let browser = null;

  try {
    if (!job.results?.length) {
      log('❌ No data to enrich. Run the scraper first.');
      job.companyEnricher.status = 'failed';
      onProgress(job);
      return;
    }

    const { map, needEnrich } = buildDomainMap(job.results);

    if (needEnrich.length === 0) {
      log('✅ All rows already have company location. Nothing to enrich.');
      job.companyEnricher.status = 'done';
      job.companyEnricher.progress = 100;
      onProgress(job);
      return;
    }

    job.companyEnricher.total = needEnrich.length;
    job.companyEnricher.done = 0;
    job.companyEnricher.enriched = 0;
    log(`📊 ${needEnrich.length} unique domains to enrich (batch size: ${BATCH_SIZE})`);
    onProgress(job);

    // Connect browser
    browser = await connectBrowser(log);
    const apolloPage = await getApolloPage(browser, log);

    // Batch process
    const batches = chunk(needEnrich, BATCH_SIZE);

    for (let bi = 0; bi < batches.length; bi++) {
      if (job.companyEnricher.status !== 'running') break;

      const batch = batches[bi];
      log(`\n📦 Batch ${bi + 1}/${batches.length} (${batch.length} domains)`);

      let resp;
      try {
        resp = await bulkEnrich(apolloPage, batch);
      } catch (err) {
        log(`⚠️  Request failed: ${err.message}. Skipping batch.`);
        job.companyEnricher.done += batch.length;
        onProgress(job);
        continue;
      }

      if (resp.status === 429) {
        log('⏳ Rate limited. Waiting 30s...');
        await sleep(30000);
        bi--; // retry same batch
        continue;
      }

      if (resp.status !== 200) {
        log(`⚠️  HTTP ${resp.status}: ${JSON.stringify(resp.body?.error || resp.body).substring(0, 200)}`);
        job.companyEnricher.done += batch.length;
        onProgress(job);
        continue;
      }

      const orgs = resp.body.organizations || [];
      log(`📝 ${orgs.length} organizations returned`);

      let batchEnriched = 0;
      for (const org of orgs) {
        batchEnriched += applyEnrichment(org, map, job.results, log);
      }

      job.companyEnricher.done += batch.length;
      job.companyEnricher.enriched += batchEnriched;
      job.companyEnricher.progress = Math.floor((job.companyEnricher.done / needEnrich.length) * 100);

      log(`📊 Batch: ${batchEnriched} rows enriched (${job.companyEnricher.done}/${needEnrich.length} domains processed)`);
      onProgress(job);

      if (bi < batches.length - 1) await sleep(BATCH_DELAY);
    }

    // Final
    if (job.companyEnricher.status === 'stopping') {
      job.companyEnricher.status = 'stopped';
      log(`\n⏸ Company enricher stopped. ${job.companyEnricher.enriched} rows enriched.`);
    } else if (job.companyEnricher.status === 'running') {
      job.companyEnricher.status = 'done';
      job.companyEnricher.progress = 100;
      log(`\n🏁 Company enrichment done! ${job.companyEnricher.enriched} rows enriched across ${needEnrich.length} domains.`);
    }

  } catch (err) {
    job.companyEnricher.status = 'failed';
    log(`💀 Company enricher fatal: ${err.message}`);
  } finally {
    if (browser) { try { browser.close(); } catch {} }
  }

  onProgress(job);
}

module.exports = { runCompanyEnricher, extractDomain };