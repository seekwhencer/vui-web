import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { Router } from '../src/Router/index.js';

// FrontendRouter.init() startet Vite, wenn NODE_ENV=development.
// Für deterministische Tests ohne Vite (und sauberen Exit) NODE_ENV=test erzwingen.
process.env.NODE_ENV = 'test';

const silent = { log: () => { }, error: () => { } };

/**
 * Mock-Server für OpenAI-kompatible Endpunkte.
 * slow=true → sendet den ersten Chunk und hält die Antwort offen,
 * damit ein Client-Abbruch mid-stream getestet werden kann.
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
            } else {
                res.writeHead(404);
                res.end('nf');
            }
        });
    });

    srv.destroyAll = () => {
        for (const s of sockets) {
            try { s.destroy(); } catch { /* ignore */ }
        }
        sockets.clear();
    };
    return srv;
}

/** Parst einen SSE-Body in eine Liste von { event, data } (data als JSON geparst). */
function parseSSE(text) {
    const events = [];
    for (const block of text.split('\n\n')) {
        if (!block.trim()) continue;
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        events.push({ event, data: parsed });
    }
    return events;
}

let fastSrv, slowSrv, fastPort, slowPort;
let app, appHttpServer, appPort, config;

beforeAll(async () => {
    fastSrv = createMockLlm({ slow: false });
    await new Promise((r) => fastSrv.listen(0, '127.0.0.1', r));
    fastPort = fastSrv.address().port;

    slowSrv = createMockLlm({ slow: true });
    await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r));
    slowPort = slowSrv.address().port;

    config = {
        llm: { api: 'openai', host: '127.0.0.1', port: fastPort, model: 'm', systemPrompt: 'SYS' },
        serverPort: 0
    };

    app = express();
    appHttpServer = createHttpServer(app);
    const router = new Router(config, appHttpServer, silent);
    await router.define();
    app.use(router.router);
    await new Promise((r) => appHttpServer.listen(0, '127.0.0.1', r));
    appPort = appHttpServer.address().port;
});

afterAll(async () => {
    appHttpServer.closeAllConnections?.();
    await new Promise((r) => appHttpServer.close(r));
    for (const srv of [fastSrv, slowSrv]) {
        srv.destroyAll();
        await new Promise((r) => srv.close(r));
    }
});

const post = (path, bodyObj) => fetch(`http://127.0.0.1:${appPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj)
});

describe('POST /api/chat', () => {
    it('liefert 200 + { success:true, data:{ answer } }', async () => {
        const r = await post('/api/chat', { question: 'hi' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.answer).toBe('OPENAI_ANSWER');
    });

    it('liefert 400, wenn question fehlt', async () => {
        const r = await post('/api/chat', {});
        expect(r.status).toBe(400);
        const j = await r.json();
        expect(j.success).toBe(false);
    });

    it('liefert 400, wenn question leer ist', async () => {
        const r = await post('/api/chat', { question: '   ' });
        expect(r.status).toBe(400);
    });

    it('liefert 503, wenn config.llm.host leer ist', async () => {
        const originalHost = config.llm.host;
        config.llm.host = '';
        try {
            const r = await post('/api/chat', { question: 'hi' });
            expect(r.status).toBe(503);
            const j = await r.json();
            expect(j.success).toBe(false);
            expect(j.error).toMatch(/LLM is not configured/);
        } finally {
            config.llm.host = originalHost;
        }
    });
});

describe('POST /api/chat/stream', () => {
    it('sendet SSE-Events in der Reihenfolge thinking, answer, done', async () => {
        const r = await post('/api/chat/stream', { question: 'hi' });
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
        const text = await r.text();
        const events = parseSSE(text);
        expect(events.map((e) => e.event)).toEqual(['thinking', 'answer', 'answer', 'done']);
        expect(events[0].data).toBe('THINK');
        expect(events[1].data).toBe('He');
        expect(events[2].data).toBe('llo');
    });

    it('überlebt einen Client-Abbruch (Server bleibt erreichbar)', async () => {
        // Auf den slow-Mock zeigen, damit der Stream offen bleibt.
        const originalPort = config.llm.port;
        config.llm.port = slowPort;
        try {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: appPort,
                    path: '/api/chat/stream',
                    method: 'POST',
                    headers: { 'content-type': 'application/json' }
                },
                (res) => {
                    res.on('data', () => {
                        req.destroy(); // Client-Abbruch mid-stream
                    });
                }
            );
            req.write(JSON.stringify({ question: 'hi' }));
            req.end();

            await new Promise((r) => setTimeout(r, 300));

            // Server muss weiterhin erreichbar sein.
            const health = await fetch(`http://127.0.0.1:${appPort}/health`);
            expect(health.status).toBe(200);
        } finally {
            config.llm.port = originalPort;
        }
    });
});
