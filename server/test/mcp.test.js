import { describe, it, expect, beforeEach } from 'vitest';
import { McpManager, MAX_MCP_TOOL_TURNS } from '../src/McpManager.js';

const silent = { log: () => { }, error: () => { } };

/**
 * Baut eine Fake-Verbindung für den `connections`-Map.
 * Der Mock-Client liefert deterministische Tool-Ergebnisse und
 * trackt `close()`-Aufrufe, ohne echte Netzwerkzugriffe.
 */
function makeFakeConnection({ tools = [], status = 'connected', client = null } = {}) {
    const closeCalls = [];
    const fakeClient = client || {
        close: async () => { closeCalls.push('close'); },
        callTool: async ({ name }) => ({
            content: [{ type: 'text', text: `result of ${name}` }],
            isError: false,
        }),
    };
    return {
        client: fakeClient,
        transport: null,
        server: { id: 'weather', name: 'Weather', enabled: true, url: 'http://localhost:8080/mcp' },
        tools,
        status,
        error: null,
        transportType: 'streamable-http',
        closeCalls,
    };
}

describe('McpManager', () => {
    let config, manager;

    beforeEach(() => {
        config = {
            mcpServers: [
                { id: 'weather', name: 'Weather', enabled: true, url: 'http://localhost:8080/mcp', headers: {}, transport: 'auto' },
                { id: 'off', name: 'Off', enabled: false, url: 'http://localhost:8081/mcp', headers: {}, transport: 'auto' },
            ],
        };
        manager = new McpManager({ config, logger: silent });
    });

    it('listServers() liefert eine Status-Übersicht (connected/disabled/error)', () => {
        manager.connections.set('weather', makeFakeConnection({ tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }] }));
        manager.connections.set('off', { client: null, transport: null, server: config.mcpServers[1], tools: [], status: 'error', error: 'boom', transportType: null });

        const servers = manager.listServers();
        expect(servers).toHaveLength(2);

        const weather = servers.find((s) => s.id === 'weather');
        expect(weather.status).toBe('connected');
        expect(weather.toolCount).toBe(1);
        expect(weather.error).toBeNull();
        expect(weather.transportType).toBe('streamable-http');

        const off = servers.find((s) => s.id === 'off');
        expect(off.status).toBe('error');
        expect(off.error).toBe('boom');
    });

    it('listServers() markiert einen deaktivierten Server ohne Verbindung als disabled', () => {
        const servers = manager.listServers();
        const off = servers.find((s) => s.id === 'off');
        expect(off.status).toBe('disabled');
        expect(off.enabled).toBe(false);
    });

    it('listTools() namespaced Tools als serverId__toolName', () => {
        manager.connections.set('weather', makeFakeConnection({ tools: [
            { name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } },
            { name: 'forecast', description: 'Forecast', inputSchema: { type: 'object', properties: {} } },
        ] }));

        const tools = manager.listTools();
        expect(tools).toHaveLength(2);
        expect(tools[0].name).toBe('weather__get_weather');
        expect(tools[0].serverId).toBe('weather');
        expect(tools[0].toolName).toBe('get_weather');
        expect(tools[1].name).toBe('weather__forecast');
    });

    it('listTools() überspringt nicht verbundene Server', () => {
        manager.connections.set('weather', makeFakeConnection({ tools: [{ name: 'get_weather' }], status: 'error' }));
        expect(manager.listTools()).toHaveLength(0);
    });

    it('toOpenAITools() liefert das korrekte OpenAI-Format', () => {
        manager.connections.set('weather', makeFakeConnection({ tools: [
            { name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
        ] }));

        expect(manager.toOpenAITools()).toEqual([
            {
                type: 'function',
                function: {
                    name: 'weather__get_weather',
                    description: 'Get weather',
                    parameters: {
                        type: 'object',
                        properties: {
                            city: { type: 'string' },
                            include_image: {
                                type: 'boolean',
                                description: 'Set to true if you need to SEE the returned image to answer well. The image is always shown to the user regardless.',
                            },
                        },
                    },
                },
            },
        ]);
    });

    it('parseToolName() roundtripped mit buildToolName()', () => {
        const name = manager.buildToolName('weather', 'get_weather');
        expect(name).toBe('weather__get_weather');
        expect(manager.parseToolName(name)).toEqual({ serverId: 'weather', toolName: 'get_weather' });
    });

    it('parseToolName() liefert null ohne Trenner', () => {
        expect(manager.parseToolName('no_separator')).toBeNull();
    });

    it('callTool() liefert content + isError vom Mock-Client', async () => {
        manager.connections.set('weather', makeFakeConnection({ tools: [{ name: 'get_weather' }] }));
        const result = await manager.callTool('weather', 'get_weather', { city: 'Berlin' });
        expect(result.isError).toBe(false);
        expect(result.content).toBe('result of get_weather');
    });

    it('callTool() liefert isError: true, wenn der Server nicht verbunden ist', async () => {
        const result = await manager.callTool('weather', 'get_weather', {});
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/nicht verbunden/);
    });

    it('callTool() liefert isError: true, wenn der Client wirft', async () => {
        const conn = makeFakeConnection({ tools: [{ name: 'get_weather' }] });
        conn.client.callTool = async () => { throw new Error('tool exploded'); };
        manager.connections.set('weather', conn);
        const result = await manager.callTool('weather', 'get_weather', {});
        expect(result.isError).toBe(true);
        expect(result.content).toBe('tool exploded');
    });

    it('callTool() extrahiert ImageContent-Blöcke in images', async () => {
        const conn = makeFakeConnection({ tools: [{ name: 'get_weather' }] });
        conn.client.callTool = async () => ({
            content: [
                { type: 'text', text: 'Sunny' },
                { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
            ],
            isError: false,
        });
        manager.connections.set('weather', conn);
        const result = await manager.callTool('weather', 'get_weather', {});
        expect(result.isError).toBe(false);
        expect(result.content).toBe('Sunny');
        expect(result.images).toEqual([{ mimeType: 'image/png', data: 'aW1hZ2U=' }]);
    });

    it('callTool() liefert images: [] bei nur Text', async () => {
        manager.connections.set('weather', makeFakeConnection({ tools: [{ name: 'get_weather' }] }));
        const result = await manager.callTool('weather', 'get_weather', {});
        expect(result.images).toEqual([]);
    });

    it('callTool() liefert images: [] im Fehlerpfad (nicht verbunden)', async () => {
        const result = await manager.callTool('weather', 'get_weather', {});
        expect(result.isError).toBe(true);
        expect(result.images).toEqual([]);
    });

    it('callTool() liefert images: [] im Fehlerpfad (Client wirft)', async () => {
        const conn = makeFakeConnection({ tools: [{ name: 'get_weather' }] });
        conn.client.callTool = async () => { throw new Error('tool exploded'); };
        manager.connections.set('weather', conn);
        const result = await manager.callTool('weather', 'get_weather', {});
        expect(result.isError).toBe(true);
        expect(result.images).toEqual([]);
    });

    it('callTool() ignoriert ImageContent ohne gültige data/mimeType', async () => {
        const conn = makeFakeConnection({ tools: [{ name: 'get_weather' }] });
        conn.client.callTool = async () => ({
            content: [
                { type: 'text', text: 'ok' },
                { type: 'image', data: 'aW1hZ2U=' },
                { type: 'image', mimeType: 'image/png' },
            ],
            isError: false,
        });
        manager.connections.set('weather', conn);
        const result = await manager.callTool('weather', 'get_weather', {});
        expect(result.images).toEqual([]);
    });

    it('close() schließt alle Verbindungen', async () => {
        const connA = makeFakeConnection({ tools: [] });
        const connB = makeFakeConnection({ tools: [] });
        manager.connections.set('a', connA);
        manager.connections.set('b', connB);

        await manager.close();

        expect(connA.closeCalls).toContain('close');
        expect(connB.closeCalls).toContain('close');
        expect(manager.connections.size).toBe(0);
    });

    it('servers-Getter spiegelt Änderungen an config.mcpServers (dynamisches Lesen)', () => {
        expect(manager.servers).toHaveLength(2);
        config.mcpServers = [
            { id: 'new', name: 'New', enabled: true, url: 'http://localhost:9999/mcp' },
        ];
        expect(manager.servers).toHaveLength(1);
        expect(manager.servers[0].id).toBe('new');
    });

    it('exportiert MAX_MCP_TOOL_TURNS als positive Zahl', () => {
        expect(Number.isInteger(MAX_MCP_TOOL_TURNS)).toBe(true);
        expect(MAX_MCP_TOOL_TURNS).toBeGreaterThan(0);
    });
});
