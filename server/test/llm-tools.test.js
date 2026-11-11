import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { Llm } from '../src/Llm.js';

const silent = { log: () => { }, error: () => { } };

/**
 * Mock-Server für den OpenAI-kompatiblen `/v1/chat/completions`-Endpunkt.
 * `withToolCalls=true` → die Antwort enthält `message.tool_calls` (Tool-Support).
 * Zählt die eingehenden Requests, damit Cache-Verhalten geprüft werden kann.
 */
function createMockLlm({ withToolCalls = false } = {}) {
    let requestCount = 0;
    const sockets = new Set();
    const srv = http.createServer((req, res) => {
        sockets.add(res.socket);
        res.on('close', () => sockets.delete(res.socket));

        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            requestCount++;
            if (req.url === '/v1/chat/completions') {
                res.writeHead(200, { 'content-type': 'application/json' });
                const message = { content: null };
                if (withToolCalls) {
                    message.tool_calls = [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }];
                }
                res.end(JSON.stringify({ choices: [{ message }] }));
            } else {
                res.writeHead(404);
                res.end('nf');
            }
        });
    });

    srv.requestCount = () => requestCount;
    srv.destroyAll = () => {
        for (const s of sockets) {
            try { s.destroy(); } catch { /* ignore */ }
        }
        sockets.clear();
    };
    return srv;
}

/** Führt `fn(port, srv)` mit einem frischen Mock-Server aus und räumt auf. */
async function withMockLlm(withToolCalls, fn) {
    const srv = createMockLlm({ withToolCalls });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
        return await fn(port, srv);
    } finally {
        srv.destroyAll();
        await new Promise((r) => srv.close(r));
    }
}

describe('Llm.detectToolSupport()', () => {
    it('liefert true, wenn die Probe toolCalls zurückgibt', async () => {
        await withMockLlm(true, async (port) => {
            const config = { llm: { api: 'openai', host: '127.0.0.1', port, model: 'm' } };
            const llm = new Llm({ config, logger: silent });
            expect(await llm.detectToolSupport()).toBe(true);
        });
    });

    it('liefert false, wenn die Probe keine toolCalls zurückgibt', async () => {
        await withMockLlm(false, async (port) => {
            const config = { llm: { api: 'openai', host: '127.0.0.1', port, model: 'm' } };
            const llm = new Llm({ config, logger: silent });
            expect(await llm.detectToolSupport()).toBe(false);
        });
    });

    it('cacht das Ergebnis (zweiter Call ohne neuen Request)', async () => {
        await withMockLlm(true, async (port, srv) => {
            const config = { llm: { api: 'openai', host: '127.0.0.1', port, model: 'm' } };
            const llm = new Llm({ config, logger: silent });

            await llm.detectToolSupport();
            expect(srv.requestCount()).toBe(1);

            await llm.detectToolSupport();
            expect(srv.requestCount()).toBe(1); // kein zweiter Request
        });
    });

    it('invalidiert den Cache bei Modell-Wechsel', async () => {
        await withMockLlm(true, async (port, srv) => {
            const config = { llm: { api: 'openai', host: '127.0.0.1', port, model: 'model-a' } };
            const llm = new Llm({ config, logger: silent });

            await llm.detectToolSupport();
            expect(srv.requestCount()).toBe(1);
            expect(llm._toolSupport).toBe(true);

            // Modell wechseln → der chatConfig-Getter (den chatWithTools/chat
            // aufrufen) invalidiert den Cache.
            config.llm.model = 'model-b';
            llm.chatConfig;
            expect(llm._toolSupport).toBeNull(); // Cache invalidiert

            await llm.detectToolSupport();
            expect(srv.requestCount()).toBe(2); // neu probed
        });
    });
});
