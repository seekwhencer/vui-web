import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../src/Router/index.js';
import { Config } from '../src/Config.js';

// FrontendRouter.init() startet Vite, wenn NODE_ENV=development.
// Für deterministische Tests ohne Vite (und sauberen Exit) NODE_ENV=test erzwingen.
process.env.NODE_ENV = 'test';

const silent = { log: () => { }, error: () => { } };

/**
 * Mock-McpManager: deckt die von den Routen genutzten Methoden ab
 * (listServers/connect/disconnect/setStatus/reconnect/callTool/
 * parseToolName/toOpenAITools + connections-Map) und trackt Aufrufe.
 *
 * Wie der echte McpManager liest `listServers()`/`connect()` die Server-Daten
 * aus `config.mcpServers` (Name/URL), die `connections`-Map liefert Status/Tools.
 * Keine echten Netzwerkzugriffe.
 */
function makeMockMcp(config) {
    const connections = new Map();
    const state = {
        connectCalls: [],
        disconnectCalls: [],
        reconnectCalls: [],
        callToolCalls: [],
        callToolResult: { content: 'TOOL_RESULT', isError: false },
    };

    const mock = {
        connections,
        state,

        listServers() {
            return config.mcpServers.map((server) => {
                const conn = connections.get(server.id);
                return {
                    id: server.id,
                    name: server.name,
                    enabled: server.enabled,
                    url: server.url,
                    headers: server.headers || {},
                    transport: server.transport || 'auto',
                    status: conn?.status || (server.enabled ? 'disconnected' : 'disabled'),
                    transportType: conn?.transportType || null,
                    toolCount: conn?.tools?.length || 0,
                    error: conn?.error || null,
                };
            });
        },

        async connect(id) {
            state.connectCalls.push(id);
            const server = config.mcpServers.find((s) => s.id === id);
            connections.set(id, {
                client: { close: async () => { }, callTool: async () => state.callToolResult },
                transport: null,
                server,
                tools: [{ name: 'do_thing', description: 'Does a thing', inputSchema: { type: 'object', properties: {} } }],
                status: 'connected',
                error: null,
                transportType: 'streamable-http',
            });
            return { id, status: 'connected', toolCount: 1, transport: 'streamable-http' };
        },

        async disconnect(id) {
            state.disconnectCalls.push(id);
            connections.delete(id);
        },

        setStatus(id, status) {
            const server = config.mcpServers.find((s) => s.id === id);
            connections.set(id, { client: null, transport: null, server, tools: [], status, error: null, transportType: null });
        },

        async reconnect(id) {
            state.reconnectCalls.push(id);
            return mock.connect(id);
        },

        async callTool(serverId, toolName, args) {
            state.callToolCalls.push({ serverId, toolName, args });
            return state.callToolResult;
        },

        parseToolName(name) {
            const idx = name.indexOf('__');
            if (idx === -1) return null;
            return { serverId: name.slice(0, idx), toolName: name.slice(idx + 2) };
        },

        toOpenAITools() {
            const out = [];
            for (const [id, conn] of connections) {
                if (conn.status !== 'connected') continue;
                for (const t of conn.tools) {
                    out.push({
                        type: 'function',
                        function: { name: `${id}__${t.name}`, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } },
                    });
                }
            }
            return out;
        },
    };
    return mock;
}

/**
 * Mock-Llm: deckt detectToolSupport/chatWithTools/chat ab.
 * `turns` ist eine Warteschlange von Antworten für chatWithTools (Tool-Loop).
 */
function makeMockLlm({ toolSupport = true, turns = [] } = {}) {
    const state = { chatWithToolsCalls: [], chatCalls: [] };
    return {
        state,
        detectToolSupport: async () => toolSupport,
        chatWithTools: async (messages, tools, options) => {
            state.chatWithToolsCalls.push({ messages, tools, options });
            return turns.shift() || { content: 'DEFAULT', toolCalls: [] };
        },
        chat: async (messages, options) => {
            state.chatCalls.push({ messages, options });
            return 'PLAIN_CHAT_ANSWER';
        },
    };
}

let dir, configPath, config, app, appHttpServer, router, appPort;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vui-router-mcp-'));
    configPath = join(dir, 'config.json');
    config = new Config({ CONFIG_PATH: configPath }, silent);
    // /api/chat prüft config.llm.host → nicht leer setzen.
    config.llm.host = '127.0.0.1';

    app = express();
    appHttpServer = createHttpServer(app);
    router = new Router(config, appHttpServer, silent);
    await router.define();
    app.use(router.router);

    // 404 + zentraler Error-Handler (wie in Server.js), damit next(err)
    // JSON statt Express-HTML liefert.
    app.use((req, res) => {
        res.status(404).json({ error: 'Not found', status: 'error', code: 'not_found' });
    });
    app.use((error, req, res, next) => {
        const status = error.status || 500;
        const code = error.code || 'internal_error';
        res.status(status).json({ error: error.message, status: 'error', code });
    });

    await new Promise((r) => appHttpServer.listen(0, '127.0.0.1', r));
    appPort = appHttpServer.address().port;
});

afterAll(async () => {
    appHttpServer.closeAllConnections?.();
    await new Promise((r) => appHttpServer.close(r));
    rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    // MCP-Server-Liste pro Test zurücksetzen (CRUD-Tests sind unabhängig).
    config.mcpServers = [];
});

const base = () => `http://127.0.0.1:${appPort}`;
const json = (method, path, bodyObj) => fetch(`${base()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
});

describe('GET /api/mcp/servers', () => {
    it('liefert 200 + Liste', async () => {
        config.mcpServers = [{ id: 'weather', name: 'Weather', enabled: true, url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto' }];
        const mcp = makeMockMcp(config);
        mcp.connections.set('weather', {
            server: config.mcpServers[0],
            tools: [{ name: 'get_weather' }],
            status: 'connected', error: null, transportType: 'streamable-http',
        });
        router.mcp = mcp;

        const r = await fetch(`${base()}/api/mcp/servers`);
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(Array.isArray(j.data.servers)).toBe(true);
        const weather = j.data.servers.find((s) => s.id === 'weather');
        expect(weather).toBeDefined();
        expect(weather.status).toBe('connected');
        expect(weather.name).toBe('Weather');
    });
});

describe('POST /api/mcp/servers', () => {
    it('liefert 201 + verbunden (Mock-McpManager)', async () => {
        const mcp = makeMockMcp(config);
        router.mcp = mcp;

        const r = await json('POST', '/api/mcp/servers', { name: 'Weather', url: 'http://localhost:8080/mcp' });
        expect(r.status).toBe(201);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.server.id).toBe('weather');
        expect(j.data.server.name).toBe('Weather');
        expect(j.data.result.status).toBe('connected');
        expect(mcp.state.connectCalls).toContain('weather');
        expect(config.mcpServers.some((s) => s.id === 'weather')).toBe(true);
    });

    it('liefert 400 bei ungültigem Eintrag (leerer url)', async () => {
        const mcp = makeMockMcp(config);
        router.mcp = mcp;

        const r = await json('POST', '/api/mcp/servers', { name: 'Weather', url: '' });
        expect(r.status).toBe(400);
        const j = await r.json();
        expect(j.status).toBe('error');
        expect(j.error).toMatch(/url/);
        expect(mcp.state.connectCalls).toHaveLength(0);
    });
});

describe('PUT /api/mcp/servers/:id', () => {
    it('liefert 200 + aktualisiert', async () => {
        config.mcpServers = [{ id: 'weather', name: 'Weather', url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto', enabled: true }];
        const mcp = makeMockMcp(config);
        router.mcp = mcp;

        const r = await json('PUT', '/api/mcp/servers/weather', { name: 'Weather Updated' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.server.name).toBe('Weather Updated');
        expect(config.mcpServers.find((s) => s.id === 'weather').name).toBe('Weather Updated');
    });

    it('liefert 404, wenn der Server nicht gefunden wird', async () => {
        config.mcpServers = [];
        router.mcp = makeMockMcp(config);

        const r = await json('PUT', '/api/mcp/servers/nonexistent', { name: 'X' });
        expect(r.status).toBe(404);
        const j = await r.json();
        expect(j.status).toBe('error');
        expect(j.error).toMatch(/nicht gefunden/);
    });
});

describe('DELETE /api/mcp/servers/:id', () => {
    it('liefert 200 + entfernt', async () => {
        config.mcpServers = [{ id: 'weather', name: 'Weather', url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto', enabled: true }];
        const mcp = makeMockMcp(config);
        router.mcp = mcp;

        const r = await fetch(`${base()}/api/mcp/servers/weather`, { method: 'DELETE' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.removed).toBe('weather');
        expect(config.mcpServers.some((s) => s.id === 'weather')).toBe(false);
        expect(mcp.state.disconnectCalls).toContain('weather');
    });
});

describe('POST /api/mcp/servers/:id/reconnect', () => {
    it('liefert 200', async () => {
        config.mcpServers = [{ id: 'weather', name: 'Weather', url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto', enabled: true }];
        const mcp = makeMockMcp(config);
        router.mcp = mcp;

        const r = await fetch(`${base()}/api/mcp/servers/weather/reconnect`, { method: 'POST' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(mcp.state.reconnectCalls).toContain('weather');
    });
});

describe('GET /api/mcp/servers/:id/tools', () => {
    it('liefert 200 + Tools', async () => {
        config.mcpServers = [{ id: 'weather', name: 'Weather', enabled: true, url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto' }];
        const mcp = makeMockMcp(config);
        mcp.connections.set('weather', {
            server: config.mcpServers[0],
            tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }],
            status: 'connected', error: null,
        });
        router.mcp = mcp;

        const r = await fetch(`${base()}/api/mcp/servers/weather/tools`);
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.tools).toHaveLength(1);
        expect(j.data.tools[0].name).toBe('get_weather');
    });

    it('liefert 404, wenn der Server nicht gefunden wird', async () => {
        config.mcpServers = [];
        router.mcp = makeMockMcp(config);
        const r = await fetch(`${base()}/api/mcp/servers/nonexistent/tools`);
        expect(r.status).toBe(404);
        const j = await r.json();
        expect(j.success).toBe(false);
    });
});

describe('POST /api/mcp/call', () => {
    it('liefert 200 + content', async () => {
        const mcp = makeMockMcp(config);
        mcp.state.callToolResult = { content: 'TOOL_RESULT', isError: false };
        router.mcp = mcp;

        const r = await json('POST', '/api/mcp/call', { serverId: 'weather', name: 'get_weather', arguments: { city: 'Berlin' } });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.content).toBe('TOOL_RESULT');
        expect(j.data.isError).toBe(false);
        expect(mcp.state.callToolCalls).toHaveLength(1);
        expect(mcp.state.callToolCalls[0]).toEqual({ serverId: 'weather', toolName: 'get_weather', args: { city: 'Berlin' } });
    });

    it('liefert 400 bei fehlenden Parametern', async () => {
        const mcp = makeMockMcp(config);
        router.mcp = mcp;

        const r = await json('POST', '/api/mcp/call', {});
        expect(r.status).toBe(400);
        const j = await r.json();
        expect(j.success).toBe(false);
        expect(mcp.state.callToolCalls).toHaveLength(0);
    });
});

describe('GET /api/mcp/capability', () => {
    it('liefert 200 + toolSupport (Mock-Llm detectToolSupport)', async () => {
        router.llm = { detectToolSupport: async () => true };
        const r = await fetch(`${base()}/api/mcp/capability`);
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.toolSupport).toBe(true);
    });
});

describe('Chat-Tool-Loop (POST /api/chat)', () => {
    it('fährt tool_calls → Ergebnis → finale Antwort', async () => {
        config.mcpServers = [{ id: 'weather', name: 'Weather', enabled: true, url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto' }];
        const mcp = makeMockMcp(config);
        mcp.connections.set('weather', {
            server: config.mcpServers[0],
            tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }],
            status: 'connected', error: null,
        });
        router.mcp = mcp;

        const llm = makeMockLlm({
            toolSupport: true,
            turns: [
                { content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'weather__get_weather', arguments: '{"city":"Berlin"}' } }] },
                { content: 'FINAL_ANSWER', toolCalls: [] },
            ],
        });
        router.llm = llm;

        const r = await json('POST', '/api/chat', { question: 'What is the weather in Berlin?' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.answer).toBe('FINAL_ANSWER');
        // Das Tool wurde ausgeführt
        expect(mcp.state.callToolCalls).toHaveLength(1);
        expect(mcp.state.callToolCalls[0]).toEqual({ serverId: 'weather', toolName: 'get_weather', args: { city: 'Berlin' } });
        // Zwei LLM-Runden
        expect(llm.state.chatWithToolsCalls).toHaveLength(2);
    });

    it('fällt ohne Tool-Support auf normalen Chat zurück (keine Tools)', async () => {
        config.mcpServers = [{ id: 'weather', name: 'Weather', enabled: true, url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto' }];
        const mcp = makeMockMcp(config);
        mcp.connections.set('weather', {
            server: config.mcpServers[0],
            tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }],
            status: 'connected', error: null,
        });
        router.mcp = mcp;

        const llm = makeMockLlm({ toolSupport: false });
        router.llm = llm;

        const r = await json('POST', '/api/chat', { question: 'What is the weather in Berlin?' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.answer).toBe('PLAIN_CHAT_ANSWER');
        // Kein Tool-Loop, kein chatWithTools
        expect(mcp.state.callToolCalls).toHaveLength(0);
        expect(llm.state.chatWithToolsCalls).toHaveLength(0);
        expect(llm.state.chatCalls).toHaveLength(1);
    });
});
