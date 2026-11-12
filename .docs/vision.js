import fs from 'fs';
import path from 'path';

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

const BASE = (process.env.VISION_BASE_URL || '').replace(/\/+$/, '');
const MODEL = process.env.VISION_MODEL || '';
const API_KEY = process.env.VISION_API_KEY || '';
// Remote 2B-Modell braucht ~150s pro Bild. Timeout bewusst groß.
const TIMEOUT = Number(process.env.VISION_TIMEOUT || 300000);

const DEFAULT_PROMPT =
  'Describe this image in detail: what kind of UI it shows, the layout/structure, ' +
  'all visible text/labels/buttons, colors and theme, and any notable components.';

const log = (...a) => console.error('[vision]', ...a);

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  };
  return map[ext] || 'image/png';
}

function usage() {
  console.log('Usage: node vision.js <image-path> [prompt ...]');
  console.log('Env:   VISION_BASE_URL  (default http://ollama.ai.home/v1)');
  console.log('        VISION_MODEL     (default qwen3.5:2b)');
  console.log('        VISION_API_KEY   (default empty)');
  console.log('        VISION_TIMEOUT   (default 300000 ms)');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const image = path.resolve(args[0]);
  const prompt = args.slice(1).join(' ').trim() || DEFAULT_PROMPT;

  if (!fs.existsSync(image)) throw new Error(`Image not found: ${image}`);

  const bytes = fs.readFileSync(image);
  const b64 = bytes.toString('base64');
  const mime = mimeFor(image);
  log(`image=${image} (${(bytes.length / 1024).toFixed(1)} KB)`);
  log(`model=${MODEL} base=${BASE} timeout=${TIMEOUT}ms`);

  const body = {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You describe images factually and concisely. No internal reasoning, ' +
          'no meta-commentary. Output only the description.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${TIMEOUT}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 500)}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`No content in response: ${text.slice(0, 500)}`);

  console.log(content);
  if (data?.usage) {
    log(`tokens: prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens}`);
  }
}

main().catch((e) => {
  console.error('FATAL', e.message || e);
  process.exit(1);
});
