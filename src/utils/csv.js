// ─── Column schema: internal key → CSV header (user-defined order) ───

const COLUMNS = [
  { key: 'organization_name',      header: 'Company Name' },
  { key: 'organization_website',   header: 'Website' },
  { key: 'first_name',             header: 'First Name' },
  { key: 'last_name',              header: 'Last Name' },
  { key: 'title',                  header: 'Title' },
  { key: 'seniority',              header: 'Seniority' },
  { key: 'headline',               header: 'Headline' },
  { key: 'linkedin_url',           header: 'Person Linkedin' },
  { key: 'city',                   header: 'City' },
  { key: 'state',                  header: 'State' },
  { key: 'country',                header: 'Country' },
  { key: 'organization_linkedin',  header: 'Company LinkedIn' },
  { key: 'organization_facebook',  header: 'Facebook' },
  { key: 'organization_twitter',   header: 'Twitter' },
  { key: 'organization_employees', header: 'Employees' },
  { key: 'organization_industries', header: 'Industries' },
  { key: 'company_address',        header: 'Company Address' },
  { key: 'company_city',           header: 'Company City' },
  { key: 'company_state',          header: 'Company State' },
  { key: 'company_postal',         header: 'Company Postal' },
  { key: 'company_country',        header: 'Company Country' },
  { key: 'company_revenue',        header: 'Revenue' },
  { key: 'company_sic',            header: 'SIC Codes' },
  { key: 'organization_phone',     header: 'Phone' },
  { key: 'organization_founded',   header: 'Founded Year' },
  { key: 'person_id',              header: 'Person ID' },
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
    organization_name:      org.name || p.organization_name || '',
    organization_website:   org.website_url || '',
    first_name:             p.first_name || '',
    last_name:              p.last_name || '',
    title:                  p.title || '',
    seniority:              p.seniority || '',
    headline:               p.headline || '',
    linkedin_url:           p.linkedin_url || '',
    city:                   titleCase(p.city || ''),
    state:                  titleCase(p.state || ''),
    country:                titleCase(p.country || ''),
    organization_linkedin:  org.linkedin_url || '',
    organization_facebook:  org.facebook_url || '',
    organization_twitter:   org.twitter_url || '',
    organization_employees: org.estimated_num_employees || '',
    organization_industries: (org.industries || []).join('; '),
    company_address:        '',
    company_city:           '',
    company_state:          '',
    company_postal:         '',
    company_country:        '',
    company_revenue:        '',
    company_sic:            '',
    organization_phone:     org.phone || '',
    organization_founded:   org.founded_year || '',
    person_id:              p.id || '',
  };
}

// ─── CSV helpers ─────────────────────────────────────────────

function escapeCell(val) {
  const s = String(val == null ? '' : val);
  return '"' + s.replace(/"/g, '""') + '"';
}

const BOM = '\ufeff';

function buildCsv(rows) {
  if (!rows.length) return '';
  const headerRow = COLUMNS.map(c => escapeCell(c.header)).join(',');
  const dataRows = rows.map(row =>
    COLUMNS.map(c => escapeCell(row[c.key])).join(',')
  );
  return BOM + [headerRow, ...dataRows].join('\r\n');
}

module.exports = { flattenPerson, buildCsv, COLUMNS };