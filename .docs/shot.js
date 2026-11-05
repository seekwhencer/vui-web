import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const OUT = process.env.OUT_DIR || './screenshots';
const VIEWPORT = { width: 1300, height: 1000 };
const ZOOM = '1.25'; // "zoom in twice": 100% -> 110% -> 125%
const THEMES = (process.env.THEMES || 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);

const log = (...a) => console.log('[shot]', ...a);

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

async function scrollToTop(page) {
  await page.evaluate(() => {
    // Override global "scroll-behavior: smooth" so the jump is instant.
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
  await page.waitForTimeout(150);
}

// Apply zoom + forced theme on every new document automatically.
async function newThemedContext(browser, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript(({ zoom, theme: forcedTheme }) => {
    const apply = () => {
      document.documentElement.style.zoom = zoom;
      document.documentElement.dataset.theme = forcedTheme;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
  }, { zoom: ZOOM, theme });
  return context;
}

async function shot(page, file) {
  await scrollToTop(page);
  await page.screenshot({ path: file, fullPage: true });
  log(file);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const launchOptions = { headless: true, args: ['--no-sandbox'] };
  if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(launchOptions);

  for (const theme of THEMES) {
    const context = await newThemedContext(browser, theme);
    const page = await context.newPage();

    // 1) Transcription screen (default route "/")
    await goto(page, BASE + '/');
    await page.waitForSelector('.layout__sidebar, .page__title, main, body', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `transcription-${theme}.png`));

    // 2) Chat screen via the top-right toggle ("Chat" label is locale-stable)
    await page.locator('.topnav__link', { hasText: 'Chat' }).click({ timeout: 15000 });
    await page.locator('.topnav__link--active', { hasText: 'Chat' }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `chat-${theme}.png`));

    // 3) Settings page: one screenshot per tab (incl. the frontend-only "UI" tab)
    await goto(page, BASE + '/settings');
    const settingsTab = page.locator('.settings__tab');
    await settingsTab.first().waitFor({ timeout: 15000 });
    const expectedTabs = ['basic', 'decoding', 'thresholds', 'context', 'vad', 'llm', 'badwords', 'ui'];
    const tabCount = await settingsTab.count();
    if (tabCount !== expectedTabs.length) {
      throw new Error(`Expected ${expectedTabs.length} settings tabs (${expectedTabs.join(', ')}), found ${tabCount}`);
    }
    for (let i = 0; i < tabCount; i++) {
      await settingsTab.nth(i).click();
      await page.waitForFunction(
        (idx) => document.querySelectorAll('.settings__tab')[idx]?.classList.contains('settings__tab--active'),
        i,
        { timeout: 15000 }
      );
      await page.waitForTimeout(400);
      const label = (await settingsTab.nth(i).innerText())
        .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await shot(page, path.join(OUT, `settings-${label}-${theme}.png`));
    }

    await context.close();
  }

  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
