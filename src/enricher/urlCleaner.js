/**
 * Clean a website URL — keep only protocol + hostname.
 * "https://example.com/about?ref=1" → "https://example.com"
 */
function cleanWebsite(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim();
  if (!u) return '';

  // Add protocol if missing
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

  try {
    const parsed = new URL(u);
    // Return clean: protocol + hostname only
    return parsed.protocol + '//' + parsed.hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
}

module.exports = { cleanWebsite };
