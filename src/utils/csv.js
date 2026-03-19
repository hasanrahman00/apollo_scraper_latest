// ─── Column schema: internal key → CSV header ───────────────

const COLUMNS = [
  { key: 'first_name',             header: 'First Name' },
  { key: 'last_name',              header: 'Last Name' },
  { key: 'title',                  header: 'Title' },
  { key: 'headline',               header: 'Headline' },
  { key: 'seniority',              header: 'Seniority' },
  { key: 'city',                   header: 'City' },
  { key: 'state',                  header: 'State' },
  { key: 'country',                header: 'Country' },
  { key: 'linkedin_url',           header: 'Person Linkedin' },
  { key: 'organization_name',      header: 'Company Name' },
  { key: 'organization_website',   header: 'Website' },
  { key: 'organization_linkedin',  header: 'Company LinkedIn' },
  { key: 'organization_phone',     header: 'Phone' },
  { key: 'organization_founded',   header: 'Founded Year' },
  { key: 'organization_facebook',  header: 'Facebook' },
  { key: 'organization_twitter',   header: 'Twitter' },
  { key: 'organization_employees', header: 'Employees' },
  { key: 'organization_industries', header: 'Industries' },
  { key: 'organization_keywords',  header: 'Keywords' },
];

// ─── Capitalize first letter of each word ────────────────────

function titleCase(str) {
  if (!str) return '';
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Flatten Apollo person record ────────────────────────────

function flattenPerson(p) {
  const org = p.organization || {};
  return {
    first_name:             p.first_name || '',
    last_name:              p.last_name || '',
    title:                  p.title || '',
    headline:               p.headline || '',
    seniority:              p.seniority || '',
    city:                   titleCase(p.city || ''),
    state:                  titleCase(p.state || ''),
    country:                titleCase(p.country || ''),
    linkedin_url:           p.linkedin_url || '',
    organization_name:      org.name || p.organization_name || '',
    organization_website:   org.website_url || '',
    organization_linkedin:  org.linkedin_url || '',
    organization_phone:     org.phone || '',
    organization_founded:   org.founded_year || '',
    organization_facebook:  org.facebook_url || '',
    organization_twitter:   org.twitter_url || '',
    organization_employees: org.estimated_num_employees || '',
    organization_industries: (org.industries || []).join('; '),
    organization_keywords:  (org.keywords || []).join('; '),
  };
}

// ─── CSV helpers ─────────────────────────────────────────────

// Always quote every cell — prevents broken columns from commas
// inside keywords, industries, headlines, titles etc.
function escapeCell(val) {
  const s = String(val == null ? '' : val);
  // Escape internal double quotes
  const escaped = s.replace(/"/g, '""');
  // Always wrap in quotes
  return '"' + escaped + '"';
}

// UTF-8 BOM so Excel opens with correct encoding
const BOM = '\ufeff';

function buildCsv(rows) {
  if (!rows.length) return '';
  const headerRow = COLUMNS.map(c => escapeCell(c.header)).join(',');
  const dataRows = rows.map(row =>
    COLUMNS.map(c => escapeCell(row[c.key])).join(',')
  );
  // BOM + \r\n line endings for Windows Excel
  return BOM + [headerRow, ...dataRows].join('\r\n');
}

module.exports = { flattenPerson, buildCsv, COLUMNS };