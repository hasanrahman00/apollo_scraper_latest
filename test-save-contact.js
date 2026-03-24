/**
 * TEST — Save contact + reveal email
 * ⚠️  This USES 1 Apollo credit to save/reveal the contact!
 * Run: node test-save-contact.js <person_id>
 * Example: node test-save-contact.js 57de5363a6da987ae8cce6c6
 * 
 * The person_id comes from mixed_people/search results (the 'id' field)
 */


// node test-save-contact.js 69bf06190243540001142ce5



require('dotenv').config();
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const PERSON_ID = process.argv[2];

if (!PERSON_ID) {
  console.log('Usage: node test-save-contact.js <person_id>');
  console.log('Example: node test-save-contact.js 57de5363a6da987ae8cce6c6');
  console.log('\nGet person_id from the scraper results (the id field in mixed_people/search)');
  process.exit(1);
}

function getSettings() {
  try {
    const f = path.join(config.DATA_DIR, 'settings.json');
    if (fs.existsSync(f)) return { ...config.DEFAULTS, ...JSON.parse(fs.readFileSync(f, 'utf-8')) };
  } catch {}
  return { ...config.DEFAULTS };
}

async function apiCall(page, method, endpoint, body) {
  return await page.evaluate(async ({ method, endpoint, body }) => {
    try {
      const metaCsrf = document.querySelector('meta[name="csrf-token"]');
      let csrf = metaCsrf ? metaCsrf.getAttribute('content') : '';
      if (!csrf) { const m = document.cookie.match(/X-CSRF-TOKEN=([^;]+)/); csrf = m ? decodeURIComponent(m[1]) : ''; }
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
        credentials: 'same-origin',
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(endpoint, opts);
      return { status: res.status, body: await res.json() };
    } catch (err) { return { status: 0, error: err.message }; }
  }, { method, endpoint, body });
}

(async () => {
  const settings = getSettings();
  console.log(`Connecting to Chrome on port ${settings.PORT}...`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${settings.PORT}`);

  let apolloPage = null;
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      if (page.url().includes('app.apollo.io')) { apolloPage = page; break; }
    }
  }

  if (!apolloPage) {
    console.log('No Apollo tab found');
    await browser.close();
    return;
  }

  console.log(`Found Apollo tab\n`);
  console.log(`Person ID: ${PERSON_ID}\n`);

  // ═══ Step 1: Try different save/reveal endpoints ═══

  // Test A: POST /api/v1/contacts (create contact from person_id)
  console.log('=== Test A: POST /api/v1/contacts ===');
  console.log('  (This may use 1 Apollo credit)\n');
  const rA = await apiCall(apolloPage, 'POST', '/api/v1/contacts', {
    entity_id: PERSON_ID,
    entity_type: 'person',
  });
  console.log(`  HTTP ${rA.status}`);
  if (rA.status === 200 || rA.status === 201) {
    const c = rA.body.contact || rA.body;
    console.log(`  Name: ${c.first_name} ${c.last_name}`);
    console.log(`  Email: ${c.email}`);
    console.log(`  Email Status: ${c.email_status}`);
    console.log(`  Contact ID: ${c.id}`);
    console.log(`  Person ID: ${c.person_id}`);
    const emails = c.contact_emails || [];
    if (emails.length) {
      console.log(`  Contact Emails:`);
      for (const e of emails) console.log(`    ${e.email} — ${e.email_status}`);
    }
    fs.writeFileSync(path.join(__dirname, 'debug_save_a.json'), JSON.stringify(rA.body, null, 2));
    console.log('  Saved to debug_save_a.json');
  } else {
    console.log(`  Response: ${JSON.stringify(rA.body).substring(0, 300)}`);
  }

  // Test B: POST /api/v1/people/match with reveal
  console.log('\n=== Test B: POST /api/v1/people/match (with reveal) ===');
  const rB = await apiCall(apolloPage, 'POST', '/api/v1/people/match', {
    id: PERSON_ID,
    reveal_personal_emails: true,
    reveal_phone_number: true,
  });
  console.log(`  HTTP ${rB.status}`);
  if (rB.status === 200) {
    const p = rB.body.person || rB.body;
    console.log(`  Name: ${p.first_name} ${p.last_name}`);
    console.log(`  Email: ${p.email}`);
    console.log(`  Email Status: ${p.email_status}`);
    console.log(`  ID: ${p.id}`);
    fs.writeFileSync(path.join(__dirname, 'debug_save_b.json'), JSON.stringify(rB.body, null, 2));
    console.log('  Saved to debug_save_b.json');
  } else {
    console.log(`  Response: ${JSON.stringify(rB.body).substring(0, 300)}`);
  }

  // Test C: POST /api/v1/mixed_people/add_to_my_prospects
  console.log('\n=== Test C: POST /api/v1/mixed_people/add_to_my_prospects ===');
  const rC = await apiCall(apolloPage, 'POST', '/api/v1/mixed_people/add_to_my_prospects', {
    entity_ids: [PERSON_ID],
    entity_type: 'person',
  });
  console.log(`  HTTP ${rC.status}`);
  if (rC.status === 200) {
    console.log(`  Response: ${JSON.stringify(rC.body).substring(0, 300)}`);
    fs.writeFileSync(path.join(__dirname, 'debug_save_c.json'), JSON.stringify(rC.body, null, 2));
  } else {
    console.log(`  Response: ${JSON.stringify(rC.body).substring(0, 300)}`);
  }

  // Test D: Now try fetching the contact by person_id search
  console.log('\n=== Test D: Search contacts for this person ===');
  const rD = await apiCall(apolloPage, 'POST', '/api/v1/contacts/search', {
    page: 1, per_page: 5,
    q_keywords: PERSON_ID,
  });
  console.log(`  HTTP ${rD.status}`);
  if (rD.status === 200) {
    const contacts = rD.body.contacts || [];
    console.log(`  ${contacts.length} contacts found`);
    for (const c of contacts) {
      console.log(`    ${c.first_name} ${c.last_name} — ${c.email} — contact_id: ${c.id}`);
    }
  } else {
    console.log(`  Response: ${JSON.stringify(rD.body).substring(0, 300)}`);
  }

  // Test E: Now search prospected=yes again
  console.log('\n=== Test E: Search prospected people (should show saved contact now) ===');
  const rE = await apiCall(apolloPage, 'POST', '/api/v1/mixed_people/search', {
    page: 1, per_page: 5,
    context: 'people-index-page',
    display_mode: 'explorer_mode',
    finder_version: 2,
    prospected_by_current_team: ['yes'],
    cacheKey: Date.now(),
  });
  if (rE.status === 200) {
    const people = rE.body.people || [];
    console.log(`  ${people.length} prospected people`);
    for (const p of people) {
      console.log(`    ${p.first_name} ${p.last_name} — email: ${p.email} — id: ${p.id}`);
    }
  }

  await browser.close();
  console.log('\nDone. Check debug_save_*.json files for full responses.');
})().catch(err => console.error('Error:', err.message));