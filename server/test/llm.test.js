import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Llm } from '../src/Llm.js';

const silent = { log: () => { }, error: () => { } };

/**
 * Mock-Server für OpenAI-kompatible (`/v1/chat/completions`) und
 * Ollama (`/api/chat`) Endpunkte.
 *
 * slow=true → sendet den ersten Chunk und hält die Antwort offen
 * (kein res.end()), damit ein Abort mid-stream getestet werden kann.
 */
function createMockLlm({ slow = false, refusal = false, model = null } = {}) {
    const sockets = new Set();
    // `withModel` injiziert den tatsächlichen Modell-Namen in jeden Chunk,
    // wie es echte OpenAI-/Ollama-Server tun (`chunk.model`).
    const withModel = (obj) => (model ? { model, ...obj } : obj);
    const srv = http.createServer((req, res) => {
        sockets.add(res.socket);
        res.on('close', () => sockets.delete(res.socket));

        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            const p = JSON.parse(body || '{}');

            if (req.url === '/v1/chat/completions') {
                if (p.stream) {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.write('data: ' + JSON.stringify(withModel({ choices: [{ delta: { reasoning_content: 'THINK' } }] })) + '\n\n');
                    if (slow) return; // offen halten
                    res.write('data: ' + JSON.stringify(withModel({ choices: [{ delta: { content: 'He' } }] })) + '\n\n');
                    res.write('data: ' + JSON.stringify(withModel({ choices: [{ delta: { content: 'llo' } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })) + '\n\n');
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    if (refusal) {
                        res.end(JSON.stringify({ choices: [{ message: { content: null, refusal: 'REFUSED_ANSWER' } }] }));
                    } else {
                        res.end(JSON.stringify({ choices: [{ message: { content: 'OPENAI_ANSWER' } }] }));
                    }
                }
            } else if (req.url === '/api/chat') {
                if (p.stream) {
                    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                    res.write(JSON.stringify(withModel({ thinking: 'OL_THINK' })) + '\n');
                    if (slow) return; // offen halten
                    res.write(JSON.stringify(withModel({ message: { content: 'ol' } })) + '\n');
                    res.write(JSON.stringify(withModel({ message: { content: 'la' } })) + '\n');
                    res.write(JSON.stringify(withModel({ message: { content: '' }, done: true, prompt_eval_count: 5, eval_count: 7 })) + '\n');
                    res.end();
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ message: { content: 'OLLAMA_ANSWER' } }));
                }
            } else {
                res.writeHead(404);
                res.end('nf');
            }
        });
    });

    // Alle offenen Sockets zerstören (für sauberen Test-Exit).
    srv.destroyAll = () => {
        for (const s of sockets) {
            try { s.destroy(); } catch { /* ignore */ }
        }
        sockets.clear();
    };
    return srv;
}

/**
 * Mock-Server für Ollamas `GET /api/show` (Capabilities-Endpoint).
 * `capabilities` steuert, ob "vision" enthalten ist; `fail=true` → HTTP 500.
 * `srv.requestCount` zählt die `/api/show`-Requests (Cache-Tests).
 */
function createShowServer({ capabilities = ['vision'], fail = false } = {}) {
    const srv = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/api/show')) {
            srv.requestCount += 1;
            if (fail) {
                res.writeHead(500);
                res.end('err');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ name: 'm', capabilities }));
            return;
        }
        res.writeHead(404);
        res.end('nf');
    });
    srv.requestCount = 0;
    return srv;
}

let fastSrv, slowSrv, refusalSrv, modelSrv, fastPort, slowPort, refusalPort, modelPort;
let showSrv, noVisionSrv, failSrv, showPort, noVisionPort, failPort;

beforeAll(async () => {
    fastSrv = createMockLlm({ slow: false });
    await new Promise((r) => fastSrv.listen(0, '127.0.0.1', r));
    fastPort = fastSrv.address().port;

    slowSrv = createMockLlm({ slow: true });
    await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r));
    slowPort = slowSrv.address().port;

    refusalSrv = createMockLlm({ refusal: true });
    await new Promise((r) => refusalSrv.listen(0, '127.0.0.1', r));
    refusalPort = refusalSrv.address().port;

    // Server, der den tatsächlichen Modell-Namen in den Chunks mitliefert.
    modelSrv = createMockLlm({ model: 'actual-model' });
    await new Promise((r) => modelSrv.listen(0, '127.0.0.1', r));
    modelPort = modelSrv.address().port;

    // Ollama-Capability-Mocks für visionEnabled() (auto-Detection).
    showSrv = createShowServer({ capabilities: ['vision'] });
    await new Promise((r) => showSrv.listen(0, '127.0.0.1', r));
    showPort = showSrv.address().port;

    noVisionSrv = createShowServer({ capabilities: ['completion'] });
    await new Promise((r) => noVisionSrv.listen(0, '127.0.0.1', r));
    noVisionPort = noVisionSrv.address().port;

    failSrv = createShowServer({ fail: true });
    await new Promise((r) => failSrv.listen(0, '127.0.0.1', r));
    failPort = failSrv.address().port;
});

afterAll(async () => {
    for (const srv of [fastSrv, slowSrv, refusalSrv, modelSrv, showSrv, noVisionSrv, failSrv]) {
        srv.destroyAll?.();
        await new Promise((r) => srv.close(r));
    }
});

const openaiConfig = () => ({ llm: { api: 'openai', host: '127.0.0.1', port: fastPort, model: 'm' } });
const ollamaConfig = () => ({ llm: { api: 'ollama', host: '127.0.0.1', port: fastPort, model: 'm' } });
const refusalConfig = () => ({ llm: { api: 'openai', host: '127.0.0.1', port: refusalPort, model: 'm' } });

describe('Llm.chat()', () => {
    it('liefert den Antworttext (OpenAI-kompatibel)', async () => {
        const llm = new Llm({ config: openaiConfig(), logger: silent });
        const answer = await llm.chat([{ role: 'user', content: 'hi' }]);
        expect(answer.content).toBe('OPENAI_ANSWER');
        expect(answer.usage).toEqual({ prompt: 0, completion: 0, total: 0 });
    });

    it('liefert den Antworttext (Ollama)', async () => {
        const llm = new Llm({ config: ollamaConfig(), logger: silent });
        const answer = await llm.chat([{ role: 'user', content: 'hi' }]);
        expect(answer.content).toBe('OLLAMA_ANSWER');
        expect(answer.usage).toEqual({ prompt: 0, completion: 0, total: 0 });
    });

    it('liefert die Refusal, wenn content null ist', async () => {
        const llm = new Llm({ config: refusalConfig(), logger: silent });
        const answer = await llm.chat([{ role: 'user', content: 'hi' }]);
        expect(answer.content).toBe('REFUSED_ANSWER');
        expect(answer.usage).toEqual({ prompt: 0, completion: 0, total: 0 });
    });
});

describe('Llm.streamChat()', () => {
    it('yields thinking dann answer (OpenAI SSE)', async () => {
        const llm = new Llm({ config: openaiConfig(), logger: silent });
        const events = [];
        for await (const e of llm.streamChat([{ role: 'user', content: 'hi' }])) events.push(e);
        expect(events).toEqual([
            { phase: 'thinking', token: 'THINK' },
            { phase: 'answer', token: 'He' },
            { phase: 'answer', token: 'llo' },
            { phase: 'stats', tokens: { prompt: 5, completion: 3, total: 8 }, model: 'm' },
        ]);
    });

    it('yields thinking dann answer (Ollama NDJSON)', async () => {
        const llm = new Llm({ config: ollamaConfig(), logger: silent });
        const events = [];
        for await (const e of llm.streamChat([{ role: 'user', content: 'hi' }])) events.push(e);
        expect(events).toEqual([
            { phase: 'thinking', token: 'OL_THINK' },
            { phase: 'answer', token: 'ol' },
            { phase: 'answer', token: 'la' },
            { phase: 'stats', tokens: { prompt: 5, completion: 7, total: 12 }, model: 'm' },
        ]);
    });

    it('nimmt den Modell-Namen aus den Response-Chunks (nicht nur Config)', async () => {
        const config = { llm: { api: 'openai', host: '127.0.0.1', port: modelPort, model: '' } };
        const llm = new Llm({ config, logger: silent });
        const events = [];
        for await (const e of llm.streamChat([{ role: 'user', content: 'hi' }])) events.push(e);
        const stats = events[events.length - 1];
        expect(stats.phase).toBe('stats');
        expect(stats.model).toBe('actual-model');
    });
});

describe('Llm.streamChunks()', () => {
    it('yields rohe Chunks (OpenAI)', async () => {
        const llm = new Llm({ config: openaiConfig(), logger: silent });
        const chunks = [];
        for await (const c of llm.streamChunks([{ role: 'user', content: 'hi' }])) chunks.push(c);
        expect(chunks).toHaveLength(3);
        expect(chunks[0].choices[0].delta.reasoning_content).toBe('THINK');
        expect(chunks[1].choices[0].delta.content).toBe('He');
        expect(chunks[2].choices[0].delta.content).toBe('llo');
    });

    it('bricht den Stream bei AbortSignal ab', async () => {
        const llm = new Llm({
            config: { llm: { api: 'openai', host: '127.0.0.1', port: slowPort, model: 'm' } },
            logger: silent
        });
        const controller = new AbortController();
        const gen = llm.streamChat([{ role: 'user', content: 'hi' }], { signal: controller.signal });

        const first = await gen.next();
        expect(first.done).toBe(false);
        expect(first.value).toEqual({ phase: 'thinking', token: 'THINK' });

        controller.abort();
        await expect(gen.next()).rejects.toThrow();
    });
});

describe('dynamisches Config-Reading', () => {
    it('chatConfig spiegelt config.llm-Mutationen ohne Re-Instanziierung', () => {
        const config = { llm: { api: 'openai', host: 'a', port: 1, model: 'x' } };
        const llm = new Llm({ config, logger: silent });

        expect(llm.chatConfig).toEqual({ api: 'openai', baseUrl: 'http://a:1/v1', modelName: 'x' });

        // config.llm mutieren → Getter liefert neue Werte
        config.llm = { api: 'ollama', host: 'b', port: 2, model: 'y' };
        expect(llm.chatConfig).toEqual({ api: 'ollama', baseUrl: 'http://b:2', modelName: 'y' });
    });
});

describe('Llm.buildToolMessage()', () => {
    it('liefert den plain String zurück, wenn keine Bilder da sind', () => {
        const llm = new Llm({ logger: silent });
        expect(llm.buildToolMessage('TEXT', [], 'openai')).toBe('TEXT');
        expect(llm.buildToolMessage('TEXT', undefined, 'ollama')).toBe('TEXT');
    });

    it('baut OpenAI-Content-Parts (image_url + Data-URL)', () => {
        const llm = new Llm({ logger: silent });
        const out = llm.buildToolMessage('TEXT', [{ mimeType: 'image/png', data: 'AAA' }], 'openai');
        expect(out).toEqual([
            { type: 'text', text: 'TEXT' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ]);
    });

    it('baut Ollama-Content-Parts (image + images-Array)', () => {
        const llm = new Llm({ logger: silent });
        const out = llm.buildToolMessage('TEXT', [{ mimeType: 'image/png', data: 'AAA' }], 'ollama');
        expect(out).toEqual([
            { type: 'text', text: 'TEXT' },
            { type: 'image', images: ['AAA'] },
        ]);
    });

    it('baut mehrere Bilder in der Reihenfolge', () => {
        const llm = new Llm({ logger: silent });
        const out = llm.buildToolMessage('T', [
            { mimeType: 'image/png', data: 'A' },
            { mimeType: 'image/jpeg', data: 'B' },
        ], 'openai');
        expect(out).toHaveLength(3);
        expect(out[0]).toEqual({ type: 'text', text: 'T' });
        expect(out[1].image_url.url).toBe('data:image/png;base64,A');
        expect(out[2].image_url.url).toBe('data:image/jpeg;base64,B');
    });
});

describe('Llm.visionEnabled()', () => {
    it('vision=true erzwingt true (ohne HTTP)', async () => {
        const llm = new Llm({ config: { llm: { api: 'ollama', host: '127.0.0.1', port: 1, model: 'm', vision: true } }, logger: silent });
        expect(await llm.visionEnabled()).toBe(true);
    });

    it('vision=false erzwingt false (ohne HTTP)', async () => {
        const llm = new Llm({ config: { llm: { api: 'ollama', host: '127.0.0.1', port: 1, model: 'm', vision: false } }, logger: silent });
        expect(await llm.visionEnabled()).toBe(false);
    });

    it('auto + OpenAI-kompatibel → false (kein Capabilities-Endpoint)', async () => {
        const llm = new Llm({ config: { llm: { api: 'openai', host: '127.0.0.1', port: 1, model: 'm' } }, logger: silent });
        expect(await llm.visionEnabled()).toBe(false);
    });

    it('auto + Ollama → true, wenn capabilities "vision" enthält', async () => {
        const llm = new Llm({ config: { llm: { api: 'ollama', host: '127.0.0.1', port: showPort, model: 'm' } }, logger: silent });
        expect(await llm.visionEnabled()).toBe(true);
    });

    it('auto + Ollama → false, wenn capabilities "vision" fehlt', async () => {
        const llm = new Llm({ config: { llm: { api: 'ollama', host: '127.0.0.1', port: noVisionPort, model: 'm' } }, logger: silent });
        expect(await llm.visionEnabled()).toBe(false);
    });

    it('auto + Ollama → false bei HTTP-Fehler (Graceful Degradation)', async () => {
        const llm = new Llm({ config: { llm: { api: 'ollama', host: '127.0.0.1', port: failPort, model: 'm' } }, logger: silent });
        expect(await llm.visionEnabled()).toBe(false);
    });

    it('cacht das Ergebnis (nur ein /api/show-Request)', async () => {
        const before = showSrv.requestCount;
        const llm = new Llm({ config: { llm: { api: 'ollama', host: '127.0.0.1', port: showPort, model: 'm' } }, logger: silent });
        expect(await llm.visionEnabled()).toBe(true);
        expect(await llm.visionEnabled()).toBe(true);
        expect(showSrv.requestCount).toBe(before + 1);
    });

    it('invalidiert den Cache bei Modell-Wechsel', async () => {
        const before = showSrv.requestCount;
        const config = { llm: { api: 'ollama', host: '127.0.0.1', port: showPort, model: 'm' } };
        const llm = new Llm({ config, logger: silent });
        expect(await llm.visionEnabled()).toBe(true);
        config.llm.model = 'other-model';
        expect(await llm.visionEnabled()).toBe(true);
        expect(showSrv.requestCount).toBe(before + 2);
    });
});
