/**
 * Apollo API client — executes fetch() inside Chrome via Playwright CDP.
 * Cloudflare sees real Chrome TLS fingerprint + valid cf_clearance.
 * No manual cookie/CSRF needed — browser already has them.
 */

async function searchPeople(page, payload) {
  const result = await page.evaluate(async (p) => {
    try {
      // Grab CSRF from meta tag first, fallback to cookie
      const metaCsrf = document.querySelector('meta[name="csrf-token"]');
      let csrf = metaCsrf ? metaCsrf.getAttribute('content') : '';

      if (!csrf) {
        const match = document.cookie.match(/X-CSRF-TOKEN=([^;]+)/);
        csrf = match ? decodeURIComponent(match[1]) : '';
      }

      const res = await fetch('/api/v1/mixed_people/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrf,
        },
        credentials: 'same-origin',
        body: JSON.stringify(p),
      });

      const body = await res.json();
      return { status: res.status, body };
    } catch (err) {
      return { status: 0, body: { error: err.message } };
    }
  }, payload);

  return result;
}

module.exports = { searchPeople };
