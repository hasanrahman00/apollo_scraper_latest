/**
 * Gemini Client — manages a Gemini tab via CDP.
 * Opens gemini.google.com/app, sends batch queries, waits for
 * thinker-mode responses, extracts JSON from output.
 */

const GEMINI_URL = 'https://gemini.google.com/app';
const INPUT_SELECTOR = '.ql-editor, div[contenteditable="true"][role="textbox"], rich-textarea .text-input-field';
const SEND_SELECTOR = 'button[aria-label="Send message"], button.send-button, button[data-mat-icon-name="send"]';
const POLL_INTERVAL = 5000;   // poll every 5s (large responses need time)
const STABLE_CHECKS = 4;     // must be stable 4 consecutive polls before considering done
const MAX_WAIT = (parseInt(process.env.ENRICHER_MAX_WAIT, 10) || 600) * 1000; // default 10 min

// ─── Open Gemini tab ─────────────────────────────────────────

async function openGeminiTab(browser, log) {
  const contexts = browser.contexts();
  const ctx = contexts[0] || await browser.newContext();
  const page = await ctx.newPage();

  log('🌐 Opening Gemini...');
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Wait for input area
  try {
    await page.waitForSelector(INPUT_SELECTOR, { timeout: 15000 });
    log('✅ Gemini ready');
  } catch {
    log('⚠️  Gemini input not found — may need to log in');
  }

  return page;
}

// ─── Close Gemini tab ────────────────────────────────────────

async function closeGeminiTab(page, log) {
  if (!page) return;
  try {
    await page.close();
    log('🔒 Gemini tab closed');
  } catch {}
}

// ─── Get current response count ──────────────────────────────

async function getResponseCount(page) {
  return await page.evaluate(() => {
    // Count model response turns
    const turns = document.querySelectorAll(
      'model-response, .model-response-text, [data-content-type="model"], message-content.model-response-text'
    );
    return turns.length;
  });
}

// ─── Extract last response text ──────────────────────────────

async function getLastResponse(page) {
  return await page.evaluate(() => {
    // Try multiple selectors for the last model response
    const selectors = [
      'model-response:last-of-type .response-container',
      'model-response:last-of-type',
      '.model-response-text:last-of-type',
      'message-content.model-response-text:last-of-type',
      '[data-content-type="model"]:last-of-type',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        const last = els[els.length - 1];
        return last.innerText || last.textContent || '';
      }
    }

    // Fallback: get all text from the conversation and take the last chunk
    const all = document.querySelectorAll('.conversation-container, .chat-history');
    if (all.length > 0) {
      return all[all.length - 1].innerText || '';
    }

    return '';
  });
}

// ─── Send a query and wait for response ──────────────────────

async function sendQuery(page, query, log) {
  // Get response count before sending
  const beforeCount = await getResponseCount(page);

  // Click input area
  const inputEl = await page.$(INPUT_SELECTOR);
  if (!inputEl) {
    throw new Error('Gemini input area not found');
  }

  await inputEl.click();
  await page.waitForTimeout(300);

  // Clear any existing text
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);

  // Paste query via clipboard (not typing — typing triggers Enter on newlines)
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, query);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyV');
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);

  // Verify paste worked, fallback to evaluate insertion
  const pasted = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return (el?.innerText || '').trim().length;
  }, INPUT_SELECTOR);

  if (pasted < 10) {
    log('⚠️  Clipboard paste failed, using direct insertion...');
    await page.evaluate((sel, text) => {
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        el.innerText = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, INPUT_SELECTOR, query);
    await page.waitForTimeout(500);
  }

  // Click send button (never use Enter — it can split multiline)
  let sent = false;
  try {
    const sendBtn = await page.$(SEND_SELECTOR);
    if (sendBtn) {
      await sendBtn.click();
      sent = true;
    }
  } catch {}

  if (!sent) {
    // Fallback: try all possible send buttons
    sent = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const label = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
        if (label.includes('send') || label.includes('submit')) {
          b.click();
          return true;
        }
      }
      return false;
    });
  }

  if (!sent) {
    log('⚠️  Send button not found, trying Enter...');
    await page.keyboard.press('Enter');
  }

  log(`📤 Query sent (${Math.round(MAX_WAIT / 60000)}min max wait). Waiting for response...`);

  // Wait for new response to appear
  const startTime = Date.now();
  let newResponseAppeared = false;
  let lastLogTime = 0;

  while (Date.now() - startTime < MAX_WAIT) {
    await page.waitForTimeout(3000);
    const currentCount = await getResponseCount(page);
    if (currentCount > beforeCount) {
      newResponseAppeared = true;
      break;
    }
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed - lastLogTime >= 30) {
      log(`⏳ Waiting for Gemini... ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
      lastLogTime = elapsed;
    }
  }

  if (!newResponseAppeared) {
    throw new Error('Gemini did not respond within timeout');
  }

  // Now poll until response stabilizes (thinker mode may take a while)
  let stableCount = 0;
  let lastText = '';
  let lastPollLog = 0;

  while (Date.now() - startTime < MAX_WAIT) {
    await page.waitForTimeout(POLL_INTERVAL);
    const currentText = await getLastResponse(page);

    if (currentText === lastText && currentText.length > 10) {
      stableCount++;
      if (stableCount >= STABLE_CHECKS) {
        const secs = Math.floor((Date.now() - startTime) / 1000);
        log(`✅ Response complete (${Math.floor(secs / 60)}m ${secs % 60}s, ${currentText.length} chars)`);
        return currentText;
      }
    } else {
      stableCount = 0;
      lastText = currentText;
      // Log progress every 30s while Gemini is still typing
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed - lastPollLog >= 30) {
        log(`⏳ Gemini still generating... ${Math.floor(elapsed / 60)}m ${elapsed % 60}s (${currentText.length} chars so far)`);
        lastPollLog = elapsed;
      }
    }
  }

  // Return whatever we have
  log('⚠️  Response may be incomplete (timeout)');
  return lastText;
}

// ─── Parse JSON from Gemini response ─────────────────────────

function parseJsonFromResponse(text) {
  if (!text) return [];

  // Try to find JSON array in the response
  // It may be wrapped in markdown code blocks
  let cleaned = text;

  // Remove markdown code fences
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Try to find the array
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch {}
  }

  // Try parsing the whole cleaned text
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}

  return [];
}

module.exports = {
  openGeminiTab,
  closeGeminiTab,
  sendQuery,
  parseJsonFromResponse,
};