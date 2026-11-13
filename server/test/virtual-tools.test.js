import { describe, it, expect } from 'vitest';
import {
    getVirtualToolDefinitions,
    resolveVirtualTool,
    VIRTUAL_TOOLS,
} from '../src/VirtualTools.js';
import { Stats } from '../src/Stats.js';

/** Mock-Config mit `getSettings()` (wie die echte Config-Instanz). */
function makeConfig(overrides = {}) {
    const config = {
        llm: { api: 'openai', host: '127.0.0.1', port: 8080, model: 'qwen3.5:2b', systemPrompt: 'SECRET_SYSTEM_PROMPT' },
        whisper: { language: 'de', temperature: [0.0], beamSize: 5 },
        security: { maxToolTurns: 10, maxToolResultBytes: 65536, toolTimeoutMs: 30000, maxPendingActions: 5, approvalTtlMs: 60000 },
        badwords: ['word1', 'word2'],
        serverPort: 3000,
        verbose: false,
        whisperHost: '127.0.0.1',
        whisperPort: 9000,
        mcpServers: [],
        ...overrides,
    };
    config.getSettings = () => config;
    return config;
}

/** Mock-MCP mit `listServers()` + `connections` (kein Netzwerk). */
function makeMcp({ servers = [], connections = {} } = {}) {
    return {
        listServers: () => servers,
        connections: new Map(Object.entries(connections)),
    };
}

/** Standard-`ctx` für `resolveVirtualTool` (`{ config, mcp, stats }`). */
function makeCtx({ config, mcp, stats } = {}) {
    return {
        config: config || makeConfig(),
        mcp: mcp || makeMcp(),
        stats: stats || new Stats(),
    };
}

describe('getVirtualToolDefinitions', () => {
    it('liefert Array mit genau 4 Tools', () => {
        const defs = getVirtualToolDefinitions();
        expect(Array.isArray(defs)).toBe(true);
        expect(defs).toHaveLength(4);
    });

    it('alle Tools haben name, description, parameters', () => {
        for (const def of getVirtualToolDefinitions()) {
            expect(def.type).toBe('function');
            expect(def.function.name).toBeTruthy();
            expect(def.function.description).toBeTruthy();
            expect(def.function.parameters).toBeTruthy();
        }
    });

    it("'get_config'.parameters.section ist optional, enum mit 6 Werten", () => {
        const params = VIRTUAL_TOOLS.get_config.definition.function.parameters;
        expect(params.properties.section.enum).toHaveLength(6);
        expect(params.required).not.toContain('section');
    });

    it("'get_stats'.parameters.section ist optional, enum mit 3 Werten", () => {
        const params = VIRTUAL_TOOLS.get_stats.definition.function.parameters;
        expect(params.properties.section.enum).toHaveLength(3);
        expect(params.required).not.toContain('section');
    });

    it("'get_mcp'.parameters.serverId ist optional (string)", () => {
        const params = VIRTUAL_TOOLS.get_mcp.definition.function.parameters;
        expect(params.properties.serverId.type).toBe('string');
        expect(params.required).not.toContain('serverId');
    });

    it("'get_policies'.parameters.serverId ist optional (string)", () => {
        const params = VIRTUAL_TOOLS.get_policies.definition.function.parameters;
        expect(params.properties.serverId.type).toBe('string');
        expect(params.required).not.toContain('serverId');
    });
});

describe('resolveVirtualTool — get_config', () => {
    it('ohne section → Markdown enthält ## LLM, ## Whisper, ## Security', () => {
        const { content, isError } = resolveVirtualTool('get_config', {}, makeCtx());
        expect(isError).toBe(false);
        expect(content).toContain('## LLM');
        expect(content).toContain('## Whisper');
        expect(content).toContain('## Security');
    });

    it('mit section=llm → Markdown enthält NUR ## LLM', () => {
        const { content, isError } = resolveVirtualTool('get_config', { section: 'llm' }, makeCtx());
        expect(isError).toBe(false);
        expect(content).toContain('## LLM');
        expect(content).not.toContain('## Whisper');
        expect(content).not.toContain('## Security');
        expect(content).not.toContain('## MCP-Server');
        expect(content).not.toContain('## Badwords');
        expect(content).not.toContain('## Server');
    });

    it('mit section=mcp → Markdown enthält ## MCP-Server', () => {
        const mcp = makeMcp({ servers: [{ id: 'my-server', name: 'My Server', url: 'https://mcp.example.com/sse', status: 'connected' }] });
        const { content, isError } = resolveVirtualTool('get_config', { section: 'mcp' }, makeCtx({ mcp }));
        expect(isError).toBe(false);
        expect(content).toContain('## MCP-Server');
        expect(content).toContain('my-server');
    });

    it('→ Markdown enthält NICHT systemPrompt (sensibel)', () => {
        const config = makeConfig({ llm: { api: 'openai', host: '127.0.0.1', port: 8080, model: 'm', systemPrompt: 'SECRET_SYSTEM_PROMPT' } });
        const { content } = resolveVirtualTool('get_config', {}, makeCtx({ config }));
        expect(content).not.toContain('SECRET_SYSTEM_PROMPT');
    });

    it('→ Markdown enthält NICHT headers (sensibel)', () => {
        const config = makeConfig({
            mcpServers: [{ id: 'my-server', name: 'My Server', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer SECRET' } }],
        });
        const mcp = makeMcp({ servers: [{ id: 'my-server', name: 'My Server', url: 'https://mcp.example.com/sse', status: 'connected', headers: { Authorization: 'Bearer SECRET' } }] });
        const { content } = resolveVirtualTool('get_config', {}, makeCtx({ config, mcp }));
        expect(content).not.toContain('SECRET');
        expect(content).not.toContain('headers');
    });

    it('mit section=foo → isError: true', () => {
        const { content, isError } = resolveVirtualTool('get_config', { section: 'foo' }, makeCtx());
        expect(isError).toBe(true);
        expect(content).toMatch(/Unbekannte Sektion/);
    });
});

describe('resolveVirtualTool — get_mcp', () => {
    const servers = [
        { id: 'server-a', name: 'Server A', url: 'https://a.example.com/sse', transport: 'streamable-http', enabled: true, status: 'connected', toolCount: 2, error: null },
        { id: 'server-b', name: 'Server B', url: 'https://b.example.com/sse', transport: 'sse', enabled: true, status: 'error', toolCount: 0, error: 'Verbindung fehlgeschlagen' },
    ];
    const connections = {
        'server-a': { tools: [{ name: 'search', description: 'Sucht in der Datenbank' }, { name: 'insert', description: 'Fügt einen Eintrag ein' }] },
    };

    it('ohne serverId → Markdown enthält alle konfigurierten Server', () => {
        const mcp = makeMcp({ servers, connections });
        const { content, isError } = resolveVirtualTool('get_mcp', {}, makeCtx({ mcp }));
        expect(isError).toBe(false);
        expect(content).toContain('## server-a');
        expect(content).toContain('## server-b');
    });

    it('mit serverId → Markdown enthält NUR diesen Server', () => {
        const mcp = makeMcp({ servers, connections });
        const { content, isError } = resolveVirtualTool('get_mcp', { serverId: 'server-a' }, makeCtx({ mcp }));
        expect(isError).toBe(false);
        expect(content).toContain('## server-a');
        expect(content).not.toContain('## server-b');
    });

    it('mit unbekannter serverId → isError: true + Liste gültiger IDs', () => {
        const mcp = makeMcp({ servers, connections });
        const { content, isError } = resolveVirtualTool('get_mcp', { serverId: 'unknown' }, makeCtx({ mcp }));
        expect(isError).toBe(true);
        expect(content).toMatch(/Unbekannter MCP-Server/);
        expect(content).toContain('server-a');
        expect(content).toContain('server-b');
    });

    it('→ Markdown enthält NICHT headers (sensibel)', () => {
        const serversWithHeaders = [{ id: 'server-a', name: 'Server A', url: 'https://a.example.com/sse', transport: 'streamable-http', enabled: true, status: 'connected', toolCount: 1, error: null, headers: { Authorization: 'Bearer SECRET' } }];
        const mcp = makeMcp({ servers: serversWithHeaders, connections: { 'server-a': { tools: [{ name: 'search', description: 'Sucht' }] } } });
        const { content } = resolveVirtualTool('get_mcp', {}, makeCtx({ mcp }));
        expect(content).not.toContain('SECRET');
        expect(content).not.toContain('headers');
    });

    it('Server mit status=error → enthält error-Zeile, keine Tool-Tabelle', () => {
        const mcp = makeMcp({ servers, connections });
        const { content } = resolveVirtualTool('get_mcp', { serverId: 'server-b' }, makeCtx({ mcp }));
        expect(content).toContain('Verbindung fehlgeschlagen');
        expect(content).not.toContain('### Tools');
    });

    it('Server mit Tools → enthält Tool-Tabelle (Name + Beschreibung)', () => {
        const mcp = makeMcp({ servers, connections });
        const { content } = resolveVirtualTool('get_mcp', { serverId: 'server-a' }, makeCtx({ mcp }));
        expect(content).toContain('### Tools');
        expect(content).toContain('search');
        expect(content).toContain('Sucht in der Datenbank');
        expect(content).toContain('insert');
    });
});

describe('resolveVirtualTool — get_policies', () => {
    const config = makeConfig({
        security: {
            toolPolicies: { 'server-a__search': 'read', 'server-a__insert': 'write' },
            allowedHosts: ['192.168.1.100', 'ollama.local'],
        },
        mcpServers: [
            { id: 'server-a', name: 'Server A' },
            { id: 'server-b', name: 'Server B' },
        ],
    });

    it('→ Markdown enthält Default: deny', () => {
        const { content, isError } = resolveVirtualTool('get_policies', {}, makeCtx({ config }));
        expect(isError).toBe(false);
        expect(content).toContain('Default: **deny**');
    });

    it('→ Markdown enthält Policies des Servers (Tool + Policy)', () => {
        const { content } = resolveVirtualTool('get_policies', { serverId: 'server-a' }, makeCtx({ config }));
        expect(content).toContain('## server-a');
        expect(content).toContain('| search | read |');
        expect(content).toContain('| insert | write |');
    });

    it('Server ohne Policies → (keine Policies gesetzt — alle Tools: deny)', () => {
        const { content } = resolveVirtualTool('get_policies', { serverId: 'server-b' }, makeCtx({ config }));
        expect(content).toContain('(keine Policies gesetzt — alle Tools: deny)');
    });

    it('→ Markdown enthält SSRF-Allowlist', () => {
        const { content } = resolveVirtualTool('get_policies', {}, makeCtx({ config }));
        expect(content).toContain('## SSRF-Allowlist');
        expect(content).toContain('192.168.1.100');
        expect(content).toContain('ollama.local');
    });

    it('mit unbekannter serverId → isError: true', () => {
        const { content, isError } = resolveVirtualTool('get_policies', { serverId: 'unknown' }, makeCtx({ config }));
        expect(isError).toBe(true);
        expect(content).toMatch(/Unbekannter MCP-Server/);
    });
});

describe('resolveVirtualTool — get_stats', () => {
    it('→ Markdown enthält ## Server, ## LLM, ## MCP, ## Transkriptionen', () => {
        const { content, isError } = resolveVirtualTool('get_stats', {}, makeCtx());
        expect(isError).toBe(false);
        expect(content).toContain('## Server');
        expect(content).toContain('## LLM');
        expect(content).toContain('## MCP');
        expect(content).toContain('## Transkriptionen');
    });

    it('mit section=llm → Markdown enthält NUR ## LLM', () => {
        const { content, isError } = resolveVirtualTool('get_stats', { section: 'llm' }, makeCtx());
        expect(isError).toBe(false);
        expect(content).toContain('## LLM');
        expect(content).not.toContain('## Server');
        expect(content).not.toContain('## MCP');
        expect(content).not.toContain('## Transkriptionen');
    });

    it('mit section=foo → isError: true + Liste gültiger Sektionen', () => {
        const { content, isError } = resolveVirtualTool('get_stats', { section: 'foo' }, makeCtx());
        expect(isError).toBe(true);
        expect(content).toMatch(/Unbekannte Sektion/);
        expect(content).toContain('llm');
        expect(content).toContain('mcp');
        expect(content).toContain('transcriptions');
    });

    it('nach recordLlm({prompt: 10, completion: 5, total: 15}) → promptTokens | 10', () => {
        const stats = new Stats();
        stats.recordLlm({ prompt: 10, completion: 5, total: 15 });
        const { content } = resolveVirtualTool('get_stats', { section: 'llm' }, makeCtx({ stats }));
        expect(content).toContain('| promptTokens | 10 |');
    });

    it('nach recordTranscription() → count | 1', () => {
        const stats = new Stats();
        stats.recordTranscription();
        const { content } = resolveVirtualTool('get_stats', { section: 'transcriptions' }, makeCtx({ stats }));
        expect(content).toContain('| count | 1 |');
    });

    it('→ Markdown enthält NICHT Prompt-Inhalte (nur Zahlen)', () => {
        const config = makeConfig({ llm: { api: 'openai', host: '127.0.0.1', port: 8080, model: 'm', systemPrompt: 'SECRET_PROMPT_CONTENT' } });
        const stats = new Stats();
        stats.recordLlm({ prompt: 10, completion: 5, total: 15 });
        const { content } = resolveVirtualTool('get_stats', {}, makeCtx({ config, stats }));
        expect(content).not.toContain('SECRET_PROMPT_CONTENT');
    });
});

describe('resolveVirtualTool — allgemein', () => {
    it("'unbekanntes_tool' → isError: true", () => {
        const { content, isError } = resolveVirtualTool('unbekanntes_tool', {}, makeCtx());
        expect(isError).toBe(true);
        expect(content).toMatch(/Unbekanntes virtuelles Tool/);
    });

    it('Handler wirft Exception → isError: true + Fehlermeldung', () => {
        const config = { getSettings: () => { throw new Error('boom'); } };
        const { content, isError } = resolveVirtualTool('get_config', {}, makeCtx({ config }));
        expect(isError).toBe(true);
        expect(content).toContain('boom');
    });
});

describe('Stats', () => {
    it('recordLlm() akkumuliert requests + Tokens', () => {
        const stats = new Stats();
        stats.recordLlm({ prompt: 10, completion: 5, total: 15 });
        stats.recordLlm({ prompt: 20, completion: 10, total: 30 });
        expect(stats.llm.requests).toBe(2);
        expect(stats.llm.promptTokens).toBe(30);
        expect(stats.llm.completionTokens).toBe(15);
        expect(stats.llm.totalTokens).toBe(45);
    });

    it('recordLlm(undefined) → keine Exception, requests += 1', () => {
        const stats = new Stats();
        expect(() => stats.recordLlm(undefined)).not.toThrow();
        expect(stats.llm.requests).toBe(1);
        expect(stats.llm.promptTokens).toBe(0);
    });

    it('recordTranscription() inkrementiert count', () => {
        const stats = new Stats();
        stats.recordTranscription();
        stats.recordTranscription();
        expect(stats.transcriptions.count).toBe(2);
    });

    it('snapshot(mcp) → enthält server/llm/mcp/transcriptions', () => {
        const stats = new Stats();
        stats.recordLlm({ prompt: 10, completion: 5, total: 15 });
        stats.recordTranscription();
        const mcp = makeMcp({ servers: [{ id: 'a', status: 'connected', tools: [{ name: 'x' }] }] });
        const snap = stats.snapshot(mcp);
        expect(snap.server).toHaveProperty('startedAt');
        expect(snap.server).toHaveProperty('uptimeMs');
        expect(snap.llm).toEqual({ requests: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15 });
        expect(snap.mcp).toEqual({ configured: 1, connected: 1, tools: 1 });
        expect(snap.transcriptions).toEqual({ count: 1 });
    });
});
