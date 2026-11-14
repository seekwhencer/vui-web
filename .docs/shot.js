import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
loadEnv(path.join(scriptDir, '.env.default'));
loadEnv(path.join(scriptDir, '.env'));

const BASE = (process.env.SHOT_BASE_URL || '').replace(/\/+$/, '');
const OUT = process.env.SHOT_OUT_DIR || './screenshots';
const VIEWPORT = { width: 1300, height: 1000 };
const ZOOM = '1.0'; // "zoom in twice": 100% -> 110% -> 125%
const THEMES = (process.env.SHOT_THEMES || 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);

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
  const launchOptions = { headless: true, args: ['--no-sandbox', '--disable-cache'] };
  if (process.env.SHOT_CHROME_PATH) launchOptions.executablePath = process.env.SHOT_CHROME_PATH;
  const browser = await chromium.launch(launchOptions);

  for (const theme of THEMES) {
    const context = await newThemedContext(browser, theme);
    const page = await context.newPage();

    // 1) Transcription screen (default route "/")
    await goto(page, BASE + '/');
    await page.waitForSelector('.layout__sidebar, .page__title, main, body', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `transcription-${theme}.png`));

    // 2) Chat screen: ask about MCP tools, wait for the answer, then screenshot
    await page.locator('.topnav__link', { hasText: 'Chat' }).click({ timeout: 15000 });
    await page.locator('.topnav__link--active', { hasText: 'Chat' }).waitFor({ timeout: 15000 });

    const chatTextarea = page.locator('.chat-input__textarea');
    await chatTextarea.waitFor({ timeout: 15000 });
    await chatTextarea.fill('Welche Tools kannst du aktuell verwenden per MCP?');

    const sendBtn = page.locator('.chat-input .btn--primary');
    await sendBtn.click({ timeout: 15000 });

    // While streaming, the send button is replaced by the stop button;
    // when the stream finishes, the send button is back in the DOM.
    await page.locator('.chat-input .btn--stop').waitFor({ timeout: 30000 });
    await sendBtn.waitFor({ timeout: 120000 });

    // The answer must be rendered (non-empty assistant bubble).
    await page.waitForFunction(
      () => {
        const bubbles = document.querySelectorAll('.msg--assistant .msg__bubble');
        const last = bubbles[bubbles.length - 1];
        return last && last.textContent.trim().length > 0;
      },
      null,
      { timeout: 30000 }
    );

    // Scroll the chat view back to the top (it auto-follows the stream to the bottom).
    await page.evaluate(() => {
      const el = document.querySelector('.chat-view');
      if (el) {
        el.style.scrollBehavior = 'auto';
        el.scrollTop = 0;
      }
    });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `chat-${theme}.png`));

    // 2b) Chat screen, second round: new chat, ask for a screenshot of the app itself
    await page.locator('.chat-history__new').click({ timeout: 15000 });
    await chatTextarea.waitFor({ timeout: 15000 });
    await chatTextarea.fill('mache ein screenshot von http://localhost:3000');
    await sendBtn.click({ timeout: 15000 });

    await page.locator('.chat-input .btn--stop').waitFor({ timeout: 30000 });
    await sendBtn.waitFor({ timeout: 120000 });

    await page.waitForFunction(
      () => {
        const bubbles = document.querySelectorAll('.msg--assistant .msg__bubble');
        const last = bubbles[bubbles.length - 1];
        return last && last.textContent.trim().length > 0;
      },
      null,
      { timeout: 30000 }
    );

    await page.evaluate(() => {
      const el = document.querySelector('.chat-view');
      if (el) {
        el.style.scrollBehavior = 'auto';
        el.scrollTop = 0;
      }
    });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `chat2-${theme}.png`));

    // 3) Settings page: two-level tabs (categories + sub-views), one screenshot each
    //    Mirrors CATEGORIES in frontend/src/pages/SettingsPage.jsx.
    const CATEGORIES = [
      { id: 'app', subs: [] },
      { id: 'asr', subs: ['basic', 'decoding', 'thresholds', 'context', 'vad', 'badwords'] },
      { id: 'llm', subs: ['connection', 'prompt', 'security'] },
      { id: 'mcp', subs: ['servers', 'builtin', 'ssrf'] },
      { id: 'ui', subs: [] },
    ];

    await goto(page, BASE + '/settings');
    const topTabs = page.locator('.settings__tabs:not(.settings__tabs--sub) .settings__tab');
    await topTabs.first().waitFor({ timeout: 15000 });
    const topCount = await topTabs.count();
    if (topCount !== CATEGORIES.length) {
      throw new Error(`Expected ${CATEGORIES.length} settings categories (${CATEGORIES.map((c) => c.id).join(', ')}), found ${topCount}`);
    }

    for (let ci = 0; ci < CATEGORIES.length; ci++) {
      const cat = CATEGORIES[ci];
      await topTabs.nth(ci).click();
      await page.waitForFunction(
        (idx) => {
          const tabs = document.querySelectorAll('.settings__tabs:not(.settings__tabs--sub) .settings__tab');
          return tabs[idx]?.classList.contains('settings__tab--active');
        },
        ci,
        { timeout: 15000 }
      );
      await page.waitForTimeout(400);

      if (cat.subs.length === 0) {
        await shot(page, path.join(OUT, `settings-${cat.id}-${theme}.png`));
        continue;
      }

      const subTabs = page.locator('.settings__tabs--sub .settings__tab');
      const subCount = await subTabs.count();
      if (subCount !== cat.subs.length) {
        throw new Error(`Expected ${cat.subs.length} sub-tabs for "${cat.id}" (${cat.subs.join(', ')}), found ${subCount}`);
      }
      for (let si = 0; si < cat.subs.length; si++) {
        const sub = cat.subs[si];
        await subTabs.nth(si).click();
        await page.waitForFunction(
          (idx) => {
            const tabs = document.querySelectorAll('.settings__tabs--sub .settings__tab');
            return tabs[idx]?.classList.contains('settings__tab--active');
          },
          si,
          { timeout: 15000 }
        );
        await page.waitForTimeout(400);
        await shot(page, path.join(OUT, `settings-${cat.id}-${sub}-${theme}.png`));

        if (cat.id === 'mcp' && sub === 'servers') {
          const firstItem = page.locator('.mcp__item').first();
          if ((await page.locator('.mcp__item').count()) === 0) {
            log('WARN: no MCP servers configured, skipping mcp-tools screenshots');
          } else {
            // Expand the tools of the first MCP server.
            await firstItem.locator('button[aria-expanded]').first().click();
            await firstItem.locator('.mcp__tool-filter').waitFor({ timeout: 15000 });
            await page.waitForTimeout(400);
            await shot(page, path.join(OUT, `settings-mcp-tools-${theme}.png`));

            // Apply the "deny" policy filter (4th button: read, write, execute, deny).
            const denyBtn = firstItem.locator('.mcp__tool-filter-policies .btn').nth(3);
            await denyBtn.click();
            await page.waitForFunction(
              () => {
                const item = document.querySelector('.mcp__item');
                const btns = item?.querySelectorAll('.mcp__tool-filter-policies .btn') || [];
                return btns[3]?.getAttribute('aria-pressed') === 'true';
              },
              null,
              { timeout: 15000 }
            );
            await page.waitForTimeout(400);
            await shot(page, path.join(OUT, `settings-mcp-tools-deny-${theme}.png`));
          }
        }
      }
    }

    await context.close();
  }

  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
