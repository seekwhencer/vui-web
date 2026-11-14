import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../src/Router/index.js';
import { Config } from '../src/Config.js';
import { McpManager } from '../src/McpManager.js';
import { PolicyEngine } from '../src/Security/PolicyEngine.js';
import { ApprovalService } from '../src/Security/ApprovalService.js';
import { ActionStore } from '../src/Security/ActionStore.js';
import { Audit } from '../src/Security/Audit.js';
import { ExecutionGateway } from '../src/Security/ExecutionGateway.js';

// FrontendRouter.init() startet Vite, wenn NODE_ENV=development.
// Für deterministische Tests ohne Vite (und sauberen Exit) NODE_ENV=test erzwingen.
process.env.NODE_ENV = 'test';

const silent = { log: () => { }, error: () => { } };

/**
 * Mock-McpManager: deckt die von den Routen genutzten Methoden ab und
 * trackt callTool-Aufrufe. Keine echten Netzwerkzugriffe.
 */
function makeMockMcp(config) {
    const connections = new Map();
    const state = { callToolCalls: [], callToolResult: { content: 'TOOL_RESULT', isError: false } };
    return {
        connections,
        state,
        listServers() {
            return config.mcpServers.map((server) => ({
                id: server.id, name: server.name, enabled: server.enabled, url: server.url,
                headers: server.headers || {}, transport: server.transport || 'auto',
                status: connections.get(server.id)?.status || 'disconnected',
                transportType: null, toolCount: 0, error: null,
            }));
        },
        async connect(id) {
            const server = config.mcpServers.find((s) => s.id === id);
            connections.set(id, {
                client: { close: async () => { }, callTool: async () => state.callToolResult },
                transport: null, server,
                tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }],
                status: 'connected', error: null, transportType: 'streamable-http',
            });
            return { id, status: 'connected', toolCount: 1, transport: 'streamable-http' };
        },
        async disconnect(id) { connections.delete(id); },
        setStatus(id, status) {
            const server = config.mcpServers.find((s) => s.id === id);
            connections.set(id, { client: null, transport: null, server, tools: [], status, error: null, transportType: null });
        },
        async reconnect(id) { return this.connect(id); },
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
                    out.push({ type: 'function', function: { name: `${id}__${t.name}`, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } });
                }
            }
            return out;
        },
    };
}

/**
 * Mock-Llm: deckt detectToolSupport/chatWithTools/streamChatWithTools/chat ab.
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
        streamChatWithTools: async function* (messages, tools, options) {
            state.chatWithToolsCalls.push({ messages, tools, options });
            const turn = turns.shift() || { content: 'DEFAULT', toolCalls: [] };
            yield { phase: 'turn', content: turn.content, toolCalls: turn.toolCalls, reasoning: '' };
            yield { phase: 'stats', tokens: 10 };
        },
        chat: async (messages, options) => {
            state.chatCalls.push({ messages, options });
            return 'PLAIN_CHAT_ANSWER';
        },
    };
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

let dir, configPath, config, app, appHttpServer, router, appPort;
let store, audit, policy, approval, gateway, security, mcp;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vui-router-policy-'));
    configPath = join(dir, 'config.json');
    config = new Config({ CONFIG_PATH: configPath }, silent);
    config.llm.host = '127.0.0.1';
    // Tool-Policies für die Tests (read/write/execute/deny).
    config.security.toolPolicies = {
        'weather__get_weather': 'read',
        'weather__set_forecast': 'write',
        'shell__run_command': 'execute',
        'shell__wipe_disk': 'deny',
    };

    app = express();
    appHttpServer = createHttpServer(app);

    mcp = new McpManager({ config, logger: silent });
    store = new ActionStore(join(dir, 'actions.json'), silent);
    audit = new Audit(join(dir, 'audit.jsonl'), silent);
    policy = new PolicyEngine({ config, logger: silent });
    approval = new ApprovalService({ store, audit, policy, config, logger: silent });
    gateway = new ExecutionGateway({ mcp, store, audit, config, logger: silent });
    security = { policy, approval, audit, gateway, store };

    router = new Router(config, appHttpServer, silent, security, mcp);
    await router.define();
    app.use(router.router);

    // 404 + zentraler Error-Handler (wie in Server.js).
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
    config.mcpServers = [{ id: 'weather', name: 'Weather', enabled: true, url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto' }];
});

const base = () => `http://127.0.0.1:${appPort}`;
const json = (method, path, bodyObj) => fetch(`${base()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
});

/** Verbindet den Mock-MCP + setzt den Gateway auf den Mock. */
function setupMockMcp() {
    const mock = makeMockMcp(config);
    mock.connections.set('weather', {
        server: config.mcpServers[0],
        tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }],
        status: 'connected', error: null, transportType: 'streamable-http',
    });
    router.mcp = mock;
    router.security.gateway.mcp = mock;
    return mock;
}

describe('Chat-Tool-Loop mit Zero-Trust-Policy (POST /api/chat)', () => {
    it('deny-Tool → DENIED, kein MCP-Call, Audit POLICY_DENIED', async () => {
        const mock = setupMockMcp();
        const llm = makeMockLlm({
            toolSupport: true,
            turns: [
                { content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'shell__wipe_disk', arguments: '{}' } }] },
                { content: 'FINAL_ANSWER', toolCalls: [] },
            ],
        });
        router.llm = llm;

        const r = await json('POST', '/api/chat', { question: 'wipe the disk' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        expect(j.data.answer).toBe('FINAL_ANSWER');
        // Das deny-Tool wurde NICHT ausgeführt.
        expect(mock.state.callToolCalls).toHaveLength(0);
        // Das LLM erhielt die Ablehnung als Tool-Ergebnis.
        const toolMsg = llm.state.chatWithToolsCalls[1].messages.find((m) => m.role === 'tool');
        expect(toolMsg.content).toMatch(/^DENIED:/);
        // Audit-Eintrag POLICY_DENIED.
        const entries = await audit.tail(100);
        expect(entries.some((e) => e.event === 'POLICY_DENIED' && e.metadata.toolName === 'wipe_disk')).toBe(true);
    });

    it('write-Tool → AWAITING_APPROVAL, kein MCP-Call, Aktion PENDING, Audit ACTION_PROPOSED', async () => {
        const mock = setupMockMcp();
        const llm = makeMockLlm({
            toolSupport: true,
            turns: [
                { content: 'Ich ändere die Vorhersage', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'weather__set_forecast', arguments: '{"city":"Berlin"}' } }] },
                { content: 'FINAL_ANSWER', toolCalls: [] },
            ],
        });
        router.llm = llm;

        const r = await json('POST', '/api/chat', { question: 'change the forecast' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        // LLM-Loop STOPPT nach AWAITING_APPROVAL (keine weitere LLM-Runde).
        expect(j.data.answer).toMatch(/Wartet auf Freigabe/);
        expect(llm.state.chatWithToolsCalls).toHaveLength(1);
        // Das write-Tool wurde NICHT ausgeführt.
        expect(mock.state.callToolCalls).toHaveLength(0);
        // Eine PENDING_APPROVAL-Aktion wurde gespeichert.
        const pending = await store.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0].toolName).toBe('set_forecast');
        expect(pending[0].status).toBe('PENDING_APPROVAL');
        // Audit-Eintrag ACTION_PROPOSED.
        const entries = await audit.tail(100);
        expect(entries.some((e) => e.event === 'ACTION_PROPOSED' && e.metadata.toolName === 'set_forecast')).toBe(true);
    });

    it('read-Tool → ausgeführt (MCP-Call), Untrusted-Wrapping, Audit EXECUTION_COMPLETED', async () => {
        const mock = setupMockMcp();
        mock.state.callToolResult = { content: 'Sunny, 20°C', isError: false };
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
        // Das read-Tool wurde ausgeführt.
        expect(mock.state.callToolCalls).toHaveLength(1);
        expect(mock.state.callToolCalls[0]).toEqual({ serverId: 'weather', toolName: 'get_weather', args: { city: 'Berlin' } });
        // Das LLM erhielt das Ergebnis als Untrusted Data.
        const toolMsg = llm.state.chatWithToolsCalls[1].messages.find((m) => m.role === 'tool');
        expect(toolMsg.content).toContain('[UNTRUSTED_EXTERNAL_DATA — BEGIN]');
        expect(toolMsg.content).toContain('Sunny, 20°C');
        expect(toolMsg.content).toContain('[UNTRUSTED_EXTERNAL_DATA — END]');
        // Audit-Eintrag EXECUTION_COMPLETED.
        const entries = await audit.tail(100);
        expect(entries.some((e) => e.event === 'EXECUTION_COMPLETED' && e.metadata.toolName === 'get_weather')).toBe(true);
    });

    it('execute-Tool → AWAITING_APPROVAL (braucht Freigabe)', async () => {
        const mock = setupMockMcp();
        const llm = makeMockLlm({
            toolSupport: true,
            turns: [
                { content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'shell__run_command', arguments: '{"cmd":"ls"}' } }] },
                { content: 'FINAL_ANSWER', toolCalls: [] },
            ],
        });
        router.llm = llm;

        const r = await json('POST', '/api/chat', { question: 'run ls' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.success).toBe(true);
        // LLM-Loop STOPPT nach AWAITING_APPROVAL (keine weitere LLM-Runde).
        expect(j.data.answer).toMatch(/Wartet auf Freigabe/);
        expect(llm.state.chatWithToolsCalls).toHaveLength(1);
        // Das execute-Tool wurde NICHT ausgeführt.
        expect(mock.state.callToolCalls).toHaveLength(0);
        const pending = await store.listPending();
        expect(pending.some((a) => a.toolName === 'run_command')).toBe(true);
    });

    it('maxToolTurns ist config-gesteuert (Loop stoppt nach config.security.maxToolTurns)', async () => {
        const mock = setupMockMcp();
        const originalMaxTurns = config.security.maxToolTurns;
        config.security.maxToolTurns = 2;
        try {
            // 3 Turns mit Tool-Calls — die Loop muss nach 2 stoppen.
            const llm = makeMockLlm({
                toolSupport: true,
                turns: [
                    { content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'weather__get_weather', arguments: '{}' } }] },
                    { content: null, toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'weather__get_weather', arguments: '{}' } }] },
                    { content: null, toolCalls: [{ id: 'call_3', type: 'function', function: { name: 'weather__get_weather', arguments: '{}' } }] },
                ],
            });
            router.llm = llm;

            const r = await json('POST', '/api/chat', { question: 'loop test' });
            expect(r.status).toBe(200);
            // Die Loop hat genau 2 LLM-Runden gefahren (maxToolTurns = 2).
            expect(llm.state.chatWithToolsCalls).toHaveLength(2);
            // Das read-Tool wurde 2x ausgeführt.
            expect(mock.state.callToolCalls).toHaveLength(2);
        } finally {
            config.security.maxToolTurns = originalMaxTurns;
        }
    });
});

describe('Chat-Tool-Loop mit Zero-Trust-Policy (POST /api/chat/stream)', () => {
    it('write-Tool → approval_required SSE-Event + AWAITING_APPROVAL tool_result', async () => {
        const mock = setupMockMcp();
        const llm = makeMockLlm({
            toolSupport: true,
            turns: [
                { content: 'Ich ändere die Vorhersage', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'weather__set_forecast', arguments: '{"city":"Berlin"}' } }] },
                { content: 'FINAL_ANSWER', toolCalls: [] },
            ],
        });
        router.llm = llm;

        const r = await fetch(`${base()}/api/chat/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: 'change the forecast' }),
        });
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
        const text = await r.text();
        const events = parseSSE(text);

        // approval_required-Event mit Action-Details.
        const approvalEvent = events.find((e) => e.event === 'approval_required');
        expect(approvalEvent).toBeTruthy();
        expect(approvalEvent.data.actionId).toBeTruthy();
        expect(approvalEvent.data.toolName).toBe('set_forecast');
        expect(approvalEvent.data.arguments).toEqual({ city: 'Berlin' });
        expect(approvalEvent.data.reason).toBeTruthy();
        expect(approvalEvent.data.expiresAt).toBeTruthy();

        // tool_result-Event mit AWAITING_APPROVAL.
        const toolResult = events.find((e) => e.event === 'tool_result');
        expect(toolResult).toBeTruthy();
        expect(toolResult.data.content).toMatch(/^AWAITING_APPROVAL:/);
        expect(toolResult.data.isError).toBe(false);

        // Das write-Tool wurde NICHT ausgeführt.
        expect(mock.state.callToolCalls).toHaveLength(0);

        // Eine PENDING_APPROVAL-Aktion wurde gespeichert.
        const pending = await store.listPending();
        expect(pending.some((a) => a.toolName === 'set_forecast')).toBe(true);
    });

    it('read-Tool → tool_result mit Untrusted-Wrapping (kein approval_required)', async () => {
        const mock = setupMockMcp();
        mock.state.callToolResult = { content: 'Sunny, 20°C', isError: false };
        const llm = makeMockLlm({
            toolSupport: true,
            turns: [
                { content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'weather__get_weather', arguments: '{"city":"Berlin"}' } }] },
                { content: 'FINAL_ANSWER', toolCalls: [] },
            ],
        });
        router.llm = llm;

        const r = await fetch(`${base()}/api/chat/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: 'What is the weather in Berlin?' }),
        });
        expect(r.status).toBe(200);
        const text = await r.text();
        const events = parseSSE(text);

        // Kein approval_required-Event (read-Tool).
        expect(events.find((e) => e.event === 'approval_required')).toBeUndefined();

        // tool_result-Event mit Untrusted-Wrapping.
        const toolResult = events.find((e) => e.event === 'tool_result');
        expect(toolResult).toBeTruthy();
        expect(toolResult.data.content).toContain('[UNTRUSTED_EXTERNAL_DATA — BEGIN]');
        expect(toolResult.data.content).toContain('Sunny, 20°C');
        expect(toolResult.data.isError).toBe(false);

        // Das read-Tool wurde ausgeführt.
        expect(mock.state.callToolCalls).toHaveLength(1);
    });

    it('deny-Tool → tool_result mit DENIED (kein approval_required)', async () => {
        const mock = setupMockMcp();
        const llm = makeMockLlm({
            toolSupport: true,
            turns: [
                { content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'shell__wipe_disk', arguments: '{}' } }] },
                { content: 'FINAL_ANSWER', toolCalls: [] },
            ],
        });
        router.llm = llm;

        const r = await fetch(`${base()}/api/chat/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: 'wipe the disk' }),
        });
        expect(r.status).toBe(200);
        const text = await r.text();
        const events = parseSSE(text);

        // Kein approval_required-Event (deny-Tool).
        expect(events.find((e) => e.event === 'approval_required')).toBeUndefined();

        // tool_result-Event mit DENIED.
        const toolResult = events.find((e) => e.event === 'tool_result');
        expect(toolResult).toBeTruthy();
        expect(toolResult.data.content).toMatch(/^DENIED:/);
        expect(toolResult.data.isError).toBe(true);

        // Das deny-Tool wurde NICHT ausgeführt.
        expect(mock.state.callToolCalls).toHaveLength(0);
    });
});
