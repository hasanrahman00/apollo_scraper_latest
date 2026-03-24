const crypto = require('crypto');

// ─── Helpers ─────────────────────────────────────────────────

function camelToSnake(str) {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// ─── Fields array (exact copy from Apollo's frontend) ────────

const FIELDS = [
  'id', 'name', 'contact_job_change_event', 'call_opted_out',
  'first_name', 'last_name', 'title',
  'account', 'organization_id', 'intent_strength', 'organization_name',
  'account.id', 'account.organization_id', 'account.domain',
  'account.logo_url', 'account.name',
  'account.facebook_url', 'account.linkedin_url', 'account.twitter_url',
  'account.crm_record_url', 'account.website_url',
  'contact_emails', 'email', 'email_status',
  'free_domain', 'email_needs_tickling', 'email_status_unavailable_reason',
  'email_true_status', 'email_domain_catchall',
  'failed_email_verify_request', 'flagged_datum',
  'phone_numbers', 'sanitized_phone',
  'direct_dial_status', 'direct_dial_enrichment_failed_at',
  'label_ids', 'linkedin_url', 'emailer_campaign_ids',
  'twitter_url', 'facebook_url', 'crm_record_url',
  'city', 'state', 'country',
  'account.estimated_num_employees',
  'account.industries',
  'account.keywords',
  'source_display_name',
];

// ─── Default payload (always sent) ───────────────────────────

function buildDefaults() {
  return {
    page: 1,
    per_page: 25,
    context: 'people-index-page',
    display_mode: 'explorer_mode',
    finder_version: 2,
    show_suggestions: false,
    num_fetch_result: 1,
    include_account_engagement_stats: false,
    include_contact_engagement_stats: false,
    open_factor_names: [],
    typed_custom_fields: [],
    sort_ascending: false,
    sort_by_field: 'person_last_name.raw',
    fields: [...FIELDS],
    cacheKey: Date.now(),
    search_session_id: crypto.randomUUID(),
    ui_finder_random_seed: Math.random().toString(36).slice(2, 13),
  };
}

// ─── Known array params ──────────────────────────────────────

const ARRAY_KEYS = new Set([
  'prospectedByCurrentTeam', 'contactEmailStatusV2', 'personTitles',
  'personLocations', 'qOrganizationKeywordTags', 'personSeniorities',
  'organizationLocations', 'organizationNumEmployeesRanges',
  'personDepartments', 'qPersonName', 'revenueRange',
  'organizationIndustryTagIds', 'personNotTitles', 'personNotLocations',
  'organizationNotLocations', 'labelIds', 'includedOrganizationIds',
  'excludedOrganizationIds', 'includedOrganizationKeywordFields',
  'emailerCampaignIds', 'notEmailerCampaignIds', 'existFields',
  'notExistFields', 'organizationDepartmentOrSubdepartmentCounts',
  'contactEmailHasTicketMaster', 'intentTopicIds', 'technologyUids',
  'buyerIntentAccountScores', 'organizationRecentFundingRoundTypes',
  'typedCustomFields',
]);

// ─── Extract query string from hash URL ──────────────────────

function extractQueryString(url) {
  if (url.includes('#')) {
    const after = url.split('#')[1];
    const qi = after.indexOf('?');
    return qi !== -1 ? after.substring(qi + 1) : '';
  }
  const qi = url.indexOf('?');
  return qi !== -1 ? url.substring(qi + 1) : '';
}

// ─── Coerce values ───────────────────────────────────────────

function coerceValue(val, key) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (/^\d+$/.test(val) && ['page', 'perPage'].includes(key)) return parseInt(val, 10);
  return val;
}

// ─── Parse URL into filter object ────────────────────────────

function parseUrlFilters(url) {
  const qs = extractQueryString(url);
  const params = new URLSearchParams(qs);
  const filters = {};

  for (const [rawKey, val] of params.entries()) {
    const isArr = rawKey.endsWith('[]');
    const clean = isArr ? rawKey.slice(0, -2) : rawKey;
    const snake = camelToSnake(clean);
    const parsed = coerceValue(val, clean);

    if (isArr || ARRAY_KEYS.has(clean)) {
      if (!filters[snake]) filters[snake] = [];
      filters[snake].push(parsed);
    } else {
      filters[snake] = parsed;
    }
  }
  return filters;
}

// ─── Main: defaults + URL filters ────────────────────────────

function parseApolloUrl(url) {
  const defaults = buildDefaults();
  const filters = parseUrlFilters(url);
  const payload = { ...defaults, ...filters };

  if (typeof payload.page === 'string') payload.page = parseInt(payload.page, 10) || 1;

  // Force stable sort — person_name.raw doesn't change between requests
  // recommendations_score recalculates live, causing ~20% page-shift dupes
  payload.sort_by_field = 'person_name.raw';
  payload.sort_ascending = true;

  return payload;
}

module.exports = { parseApolloUrl, buildDefaults, FIELDS };