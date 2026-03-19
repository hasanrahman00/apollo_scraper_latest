const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const config = require('../../config');

// ─── Load saved settings or defaults ─────────────────────────

function getSettings() {
  try {
    if (fs.existsSync(config.SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8'));
      return { ...config.DEFAULTS, ...saved };
    }
  } catch {}
  return { ...config.DEFAULTS };
}

// ─── Check if Chrome debug port is reachable ─────────────────

function isChromeRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// ─── Launch Chrome with remote debugging ─────────────────────

function launchChrome(settings, log) {
  return new Promise((resolve, reject) => {
    const args = [
      `--remote-debugging-port=${settings.PORT}`,
      `--user-data-dir=${settings.USER_DATA_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];

    log(`🚀 Launching Chrome: ${settings.CHROME_PATH}`);
    log(`   Port: ${settings.PORT}, Profile: ${settings.USER_DATA_DIR}`);

    const child = spawn(settings.CHROME_PATH, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();

    child.on('error', (err) => {
      reject(new Error(`Failed to launch Chrome: ${err.message}\nPath: ${settings.CHROME_PATH}`));
    });

    // Give Chrome time to start CDP listener
    setTimeout(() => resolve(), 3000);
  });
}

// ─── Connect to Chrome (launch if needed) ────────────────────

async function connectBrowser(log) {
  const settings = getSettings();
  const port = settings.PORT;

  // Check if already running
  const running = await isChromeRunning(port);

  if (!running) {
    log(`⚠️  Chrome not detected on port ${port}. Launching...`);
    await launchChrome(settings, log);

    // Wait and verify
    let retries = 5;
    while (retries > 0) {
      const ok = await isChromeRunning(port);
      if (ok) break;
      retries--;
      log(`⏳ Waiting for Chrome... (${5 - retries}/5)`);
      await new Promise(r => setTimeout(r, 2000));
    }

    const ok = await isChromeRunning(port);
    if (!ok) {
      throw new Error(
        `Chrome did not start on port ${port}.\n` +
        `Check Settings tab:\n` +
        `  Chrome Path: ${settings.CHROME_PATH}\n` +
        `  User Data Dir: ${settings.USER_DATA_DIR}\n` +
        `  Port: ${port}`
      );
    }
    log('✅ Chrome launched successfully');
  } else {
    log(`✅ Chrome already running on port ${port}`);
  }

  // Connect via CDP
  const cdpUrl = `http://127.0.0.1:${port}`;
  log(`🔌 Connecting CDP...`);

  const browser = await chromium.connectOverCDP(cdpUrl);
  log(`✅ Connected (${browser.contexts().length} context(s))`);

  return browser;
}

// ─── Find existing Apollo tab or navigate to it ──────────────

async function getApolloPage(browser, log) {
  const contexts = browser.contexts();

  // Search all tabs for an open Apollo page
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url();
      if (url.includes('app.apollo.io')) {
        log(`📌 Found Apollo tab: ${url.substring(0, 80)}`);
        return page;
      }
    }
  }

  // No Apollo tab — open one in the first context
  log('🌐 No Apollo tab found. Opening app.apollo.io...');
  const ctx = contexts[0] || await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('https://app.apollo.io/#/people', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(3000);
  log('✅ Apollo page loaded');

  return page;
}

module.exports = { connectBrowser, getApolloPage, getSettings };
