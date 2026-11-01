import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const OUT = process.env.OUT_DIR || './screenshots';
const VIEWPORT = { width: 1300, height: 1000 };
const ZOOM = '1.25'; // "zoom in twice": 100% -> 110% -> 125%

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

// Apply the "zoom in twice" (CSS zoom) on every new document automatically.
async function applyZoom(context) {
  await context.addInitScript((z) => {
    const apply = () => { document.documentElement.style.zoom = z; };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
  }, ZOOM);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await applyZoom(context);
  const page = await context.newPage();

  await goto(page, BASE + '/');
  await page.waitForSelector('.layout__sidebar, .page__title, main, body', { timeout: 15000 });
  await page.waitForTimeout(900);
  await scrollToTop(page);

  const file = path.join(OUT, 'dashboard.png');
  await page.screenshot({ path: file, fullPage: true });
  log('index', file);

  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
