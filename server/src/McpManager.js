import { Client, StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client';

const MAX_MCP_TOOL_TURNS = 10;
const NAME_SEP = '__';

/**
 * Verwaltet alle MCP-Verbindungen + Tool-Registry + Tool-Ausführung.
 *
 * Die Server-Liste wird zur Aufrufzeit aus `config.mcpServers` gelesen
 * (Getter `servers`), damit Settings-Änderungen sofort wirksam werden,
 * ohne Neustart.
 */
class McpManager {
    /**
     * @param {object} params
     * @param {Config} params.config - Config-Objekt (liest `config.mcpServers`)
     * @param {Logger} params.logger
     */
    constructor({ config, logger } = {}) {
        this.config = config;
        this.label = '[McpManager]';
        this.logger = logger || { log: () => { }, error: () => { } };
        /** @type {Map<string, Connection>} */
        this.connections = new Map();
    }

    /** Liest die Server-Liste zur Aufrufzeit (dynamisch, wie Llm.chatConfig). */
    get servers() {
        return Array.isArray(this.config?.mcpServers) ? this.config.mcpServers : [];
    }

    /**
     * Verbindet alle `enabled`-Server (Start / Reconnect-all).
     * Fehler pro Server werden isoliert (ein kaputter Server bricht die anderen nicht ab).
     */
    async connectAll() {
        const results = [];
        for (const server of this.servers) {
            if (!server.enabled) {
                this.setStatus(server.id, 'disabled');
                continue;
            }
            results.push(await this.connect(server.id));
        }
        return results;
    }

    /**
     * Baut eine einzelne Verbindung auf (oder ersetzt eine bestehende).
     * Transport: Streamable HTTP (modern) mit Fallback auf HTTP+SSE (legacy).
     * @returns {Promise<ConnectionStatus>}
     */
    async connect(id) {
        const server = this.servers.find((s) => s.id === id);
        if (!server) return { id, status: 'error', error: 'Server nicht gefunden' };

        // Bestehende Verbindung sauber schließen (Reconnect).
        await this.disconnect(id).catch(() => { });

        let url;
        try {
            url = new URL(server.url);
        } catch {
            return { id, status: 'error', error: `Ungültige URL: ${server.url}` };
        }

        const options = server.headers && Object.keys(server.headers).length > 0
            ? { requestInit: { headers: server.headers } }
            : {};

        const mode = server.transport || 'auto';
        const attempts = mode === 'sse' ? ['sse'] : ['streamable-http', 'sse'];

        const newClient = () => new Client(
            { name: 'vui-mcp', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto' } },
        );
        const makeTransport = (type) =>
            type === 'sse'
                ? new SSEClientTransport(url, options)
                : new StreamableHTTPClientTransport(url, options);

        let lastErr = null;
        for (const type of attempts) {
            const client = newClient();
            try {
                const transport = makeTransport(type);
                await client.connect(transport);
                const { tools } = await client.listTools();
                this.connections.set(id, {
                    client, transport, server, tools,
                    status: 'connected', error: null, transportType: type,
                });
                this.logger.log(this.label, `Verbunden: ${id} (${tools.length} Tools, ${type})`);
                return { id, status: 'connected', toolCount: tools.length, transport: type };
            } catch (err) {
                lastErr = err;
                await client.close().catch(() => { });
            }
        }

        this.connections.set(id, {
            client: null, transport: null, server, tools: [],
            status: 'error', error: lastErr?.message || 'Verbindung fehlgeschlagen',
        });
        this.logger.error(this.label, `Verbindung fehlgeschlagen: ${id}`, { error: lastErr?.message });
        return { id, status: 'error', error: lastErr?.message };
    }

    /** Schließt eine Verbindung und entfernt sie aus dem Map. */
    async disconnect(id) {
        const conn = this.connections.get(id);
        if (!conn) return;
        // client kann null sein (vergebene Verbindung) → nur schließen, wenn vorhanden.
        if (conn.client) await conn.client.close().catch(() => { });
        this.connections.delete(id);
    }

    /** Reconnect = disconnect + connect. */
    async reconnect(id) {
        return this.connect(id);
    }

    /** Setzt nur den Status (z. B. 'disabled') ohne Verbindung. */
    setStatus(id, status) {
        const existing = this.connections.get(id);
        this.connections.set(id, {
            client: null, transport: null,
            server: this.servers.find((s) => s.id === id),
            tools: [], status, error: null,
            ...(existing ? {} : {}),
        });
    }

    /**
     * Status-Übersicht aller konfigurierten Server (für die UI).
     * @returns {Array<object>}
     */
    listServers() {
        return this.servers.map((server) => {
            const conn = this.connections.get(server.id);
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
    }

    /**
     * Aggregiert die Tools aller verbundenen Server (namespaced).
     * @returns {Array<{name: string, description: string, inputSchema: object, serverId: string, toolName: string}>}
     */
    listTools() {
        const out = [];
        for (const [id, conn] of this.connections) {
            if (conn.status !== 'connected') continue;
            for (const tool of conn.tools) {
                out.push({
                    name: this.buildToolName(id, tool.name),
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
                    serverId: id,
                    toolName: tool.name,
                });
            }
        }
        return out;
    }

    /**
     * Mappt MCP-Tools auf OpenAI-Function-Tools (für den LLM-Request).
     * @returns {Array<object>}
     */
    toOpenAITools() {
        return this.listTools().map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
            },
        }));
    }

    /**
     * Führt einen Tool-Call aus.
     * @param {string} serverId
     * @param {string} toolName - Original-Tool-Name (ohne Prefix)
     * @param {object} arguments_ - Argumente
     * @returns {Promise<{content: string, isError: boolean}>}
     */
    async callTool(serverId, toolName, arguments_) {
        const conn = this.connections.get(serverId);
        if (!conn || conn.status !== 'connected') {
            return { content: `MCP-Server '${serverId}' ist nicht verbunden.`, isError: true };
        }
        try {
            const result = await conn.client.callTool({ name: toolName, arguments: arguments_ || {} });
            const content = (result.content || [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');
            return { content: content || '', isError: result.isError === true };
        } catch (err) {
            this.logger.error(this.label, `Tool-Call fehlgeschlagen: ${serverId}/${toolName}`, { error: err.message });
            return { content: err.message, isError: true };
        }
    }

    /** Baut den namespaced Tool-Namen. */
    buildToolName(serverId, toolName) {
        return `${serverId}${NAME_SEP}${toolName}`;
    }

    /** Zerlegt einen namespaced Tool-Namen in (serverId, toolName). */
    parseToolName(name) {
        const idx = name.indexOf(NAME_SEP);
        if (idx === -1) return null;
        return { serverId: name.slice(0, idx), toolName: name.slice(idx + NAME_SEP.length) };
    }

    /** Schließt alle Verbindungen (Shutdown). */
    async close() {
        await Promise.allSettled(
            [...this.connections.keys()].map((id) => this.disconnect(id))
        );
        this.connections.clear();
    }
}

export { McpManager, MAX_MCP_TOOL_TURNS };
