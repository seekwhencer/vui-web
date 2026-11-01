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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  for (const theme of THEMES) {
    const context = await newThemedContext(browser, theme);
    const page = await context.newPage();

    await goto(page, BASE + '/');
    await page.waitForSelector('.layout__sidebar, .page__title, main, body', { timeout: 15000 });
    await page.waitForTimeout(900);
    await scrollToTop(page);

    const file = path.join(OUT, `dashboard-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(theme, file);

    await context.close();
  }

  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
