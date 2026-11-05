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
function createMockLlm({ slow = false } = {}) {
    const sockets = new Set();
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
                    res.write('data: {"choices":[{"delta":{"reasoning_content":"THINK"}}]}\n\n');
                    if (slow) return; // offen halten
                    res.write('data: {"choices":[{"delta":{"content":"He"}}]}\n\n');
                    res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ choices: [{ message: { content: 'OPENAI_ANSWER' } }] }));
                }
            } else if (req.url === '/api/chat') {
                if (p.stream) {
                    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                    res.write(JSON.stringify({ thinking: 'OL_THINK' }) + '\n');
                    if (slow) return; // offen halten
                    res.write(JSON.stringify({ message: { content: 'ol' } }) + '\n');
                    res.write(JSON.stringify({ message: { content: 'la' } }) + '\n');
                    res.write(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
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

let fastSrv, slowSrv, fastPort, slowPort;

beforeAll(async () => {
    fastSrv = createMockLlm({ slow: false });
    await new Promise((r) => fastSrv.listen(0, '127.0.0.1', r));
    fastPort = fastSrv.address().port;

    slowSrv = createMockLlm({ slow: true });
    await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r));
    slowPort = slowSrv.address().port;
});

afterAll(async () => {
    for (const srv of [fastSrv, slowSrv]) {
        srv.destroyAll();
        await new Promise((r) => srv.close(r));
    }
});

const openaiConfig = () => ({ llm: { api: 'openai', host: '127.0.0.1', port: fastPort, model: 'm' } });
const ollamaConfig = () => ({ llm: { api: 'ollama', host: '127.0.0.1', port: fastPort, model: 'm' } });

describe('Llm.chat()', () => {
    it('liefert den Antworttext (OpenAI-kompatibel)', async () => {
        const llm = new Llm({ config: openaiConfig(), logger: silent });
        const answer = await llm.chat([{ role: 'user', content: 'hi' }]);
        expect(answer).toBe('OPENAI_ANSWER');
    });

    it('liefert den Antworttext (Ollama)', async () => {
        const llm = new Llm({ config: ollamaConfig(), logger: silent });
        const answer = await llm.chat([{ role: 'user', content: 'hi' }]);
        expect(answer).toBe('OLLAMA_ANSWER');
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
        ]);
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
