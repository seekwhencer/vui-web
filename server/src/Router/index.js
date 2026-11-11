
import express from 'express';
import { FrontendRouter } from './FrontendRouter.js';
import { TranscribeBridge } from '../Bridge/TranscribeBridge.js';
import { Llm } from '../Llm.js';
import { McpManager, MAX_MCP_TOOL_TURNS } from '../McpManager.js';

/**
 * Main router class that aggregates all server routes.
 */
class Router {
    /**
     * @param {Config} config - Configuration object
     * @param {import('node:http').Server} httpServer - HTTP server instance
     * @param {Logger} [logger] - Logger instance
     */
    constructor(config, httpServer, logger) {
        this.config = config;
        this.httpServer = httpServer;
        this.label = '[Router]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();
        this.router.use(express.json());

        // WebSocket-Bridge für Live-Transkription (noServer, Upgrade wird
        // in setupUpgradeRouting gezielt hierher geroutet).
        this.transcribeBridge = new TranscribeBridge(this.config, this.logger);

        // LLM-Chat-Service (liest config.llm dynamisch zur Aufrufzeit).
        this.llm = new Llm({ config: this.config, logger: this.logger });

        // MCP-Manager (Verbindungen + Tool-Registry + Tool-Ausführung).
        // Liest config.mcpServers dynamisch zur Aufrufzeit.
        this.mcp = new McpManager({ config: this.config, logger: this.logger });
    }

    /**
     * Defines all routes in the required order:
     * 
     * @returns {Promise<void>}
     */
    async define() {
        this.router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

        // Settings-API: Whisper-Parameter + Badwords lesen/schreiben.
        // Die Bridge liest die Werte dynamisch → Änderungen wirken sofort.
        this.router.get('/api/settings', (req, res) => {
            res.status(200).json({ success: true, data: this.config.getSettings() });
        });

        this.router.put('/api/settings', (req, res, next) => {
            try {
                const result = this.config.updateSettings(req.body || {});
                res.status(200).json({
                    success: true,
                    data: this.config.getSettings(),
                    applied: result.applied,
                    restartRequired: result.restartRequired
                });
            } catch (err) {
                next(err);
            }
        });

        // Chat-API: Non-Streaming + SSE-Streaming.
        // Der Llm-Service liest config.llm dynamisch → Settings-Änderungen wirken sofort.
        this.router.post('/api/chat', async (req, res) => {
            const question = req.body?.question;
            if (typeof question !== 'string' || question.trim() === '') {
                return res.status(400).json({ success: false, error: 'Missing "question" in request body' });
            }
            if (!this.config.llm?.host) {
                return res.status(503).json({ success: false, error: 'LLM is not configured. Set LLM_HOST.' });
            }

            try {
                const answer = await this.runChatWithMcpTools(question, req.body?.history);
                res.status(200).json({ success: true, data: { answer } });
            } catch (err) {
                this.logger.error(this.label, 'Chat fehlgeschlagen', { error: err.message });
                res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
            }
        });

        this.router.post('/api/chat/stream', async (req, res) => {
            const question = req.body?.question;
            if (typeof question !== 'string' || question.trim() === '') {
                return res.status(400).json({ success: false, error: 'Missing "question" in request body' });
            }
            // 503 VOR den SSE-Headern → Client erhält normales JSON, keinen kaputten Stream.
            if (!this.config.llm?.host) {
                return res.status(503).json({ success: false, error: 'LLM is not configured. Set LLM_HOST.' });
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            const send = (event, data) => {
                if (res.writableEnded) return false;
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                return true;
            };

            // Client-Abbruch → Stream abbrechen (AbortController).
            const controller = new AbortController();
            res.on('close', () => controller.abort());

            const messages = this.buildChatMessages(question, req.body?.history);
            const llmOptions = { signal: controller.signal };
            if (req.body?.reasoning_effort) {
                llmOptions.reasoning_effort = req.body.reasoning_effort;
            }

            const tools = this.mcp.toOpenAITools();
            let stats = null;

            // Graceful Degradation: Nur wenn Tools vorhanden UND das Backend
            // Function-Calling unterstützt, wird der Tool-Loop gefahren.
            // Sonst bleibt das bisherige streamChat()-Verhalten (keine Tools).
            let useTools = tools.length > 0;
            if (useTools) {
                try {
                    useTools = await this.llm.detectToolSupport();
                } catch {
                    useTools = false;
                }
            }

            try {
                if (!useTools) {
                    for await (const chunk of this.llm.streamChat(messages, llmOptions)) {
                        if (res.writableEnded) break;
                        if (chunk.phase === 'stats') {
                            stats = chunk;
                            continue;
                        }
                        if (send(chunk.phase, chunk.token) === false) break;
                    }
                    if (!res.writableEnded) {
                        send('done', stats || {});
                        res.end();
                    }
                    return;
                }

                // Tool-Loop: LLM-Runden streamen, Tool-Calls ausführen,
                // Ergebnis anhängen, bis keine Tool-Calls mehr oder Cap erreicht.
                for (let turn = 0; turn < MAX_MCP_TOOL_TURNS; turn++) {
                    let turnContent = '';
                    let turnToolCalls = [];
                    let turnReasoning = '';

                    for await (const chunk of this.llm.streamChatWithTools(messages, tools, llmOptions)) {
                        if (res.writableEnded) break;
                        if (chunk.phase === 'stats') {
                            stats = chunk;
                            continue;
                        }
                        if (chunk.phase === 'turn') {
                            turnContent = chunk.content || '';
                            turnToolCalls = chunk.toolCalls || [];
                            turnReasoning = chunk.reasoning || '';
                            continue;
                        }
                        if (send(chunk.phase, chunk.token) === false) break;
                    }
                    if (res.writableEnded) break;

                    // Keine Tool-Calls → finale Antwort fertig.
                    if (!turnToolCalls || turnToolCalls.length === 0) {
                        send('done', stats || {});
                        res.end();
                        return;
                    }

                    // Assistant-Turn (mit tool_calls) anhängen. Reasoning-Modelle
                    // brauchen `reasoning_content` beim Replay, sonst bricht die
                    // Denk-Kette im nächsten Turn ab (OpenAI-Docs: reasoning items
                    // müssen mit Tool-Call-Outputs zurückgegeben werden).
                    messages.push({
                        role: 'assistant',
                        content: turnContent,
                        ...(turnReasoning ? { reasoning_content: turnReasoning } : {}),
                        tool_calls: turnToolCalls,
                    });

                    // Jeden Tool-Call ausführen + Ergebnis senden + anhängen.
                    for (const call of turnToolCalls) {
                        if (res.writableEnded) break;
                        const parsed = this.mcp.parseToolName(call.function?.name);
                        let args = {};
                        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }

                        send('tool_call', {
                            id: call.id,
                            name: call.function?.name,
                            arguments: args,
                        });

                        let content = 'Unbekanntes Tool';
                        let isError = true;
                        if (parsed) {
                            const result = await this.mcp.callTool(parsed.serverId, parsed.toolName, args);
                            content = result.content;
                            isError = result.isError;
                        }

                        send('tool_result', { id: call.id, content, isError });

                        messages.push({
                            role: 'tool',
                            tool_call_id: call.id,
                            content,
                        });
                    }
                    if (res.writableEnded) break;
                }

                // Turn-Cap erreicht (oder Abbruch) → Stream beenden.
                if (!res.writableEnded) {
                    send('done', stats || {});
                    res.end();
                }
            } catch (err) {
                // Client-Abbruch (AbortController) → axios wirft CanceledError,
                // nativer Fetch wirft AbortError. Beides ist kein echter Fehler.
                const isAbort = err && (
                    err.name === 'AbortError' ||
                    err.name === 'CanceledError' ||
                    err.code === 'ERR_CANCELED'
                );
                if (isAbort) return;
                this.logger.error(this.label, 'Chat-Streaming fehlgeschlagen', { error: err.message });
                if (!res.writableEnded) {
                    send('error', { message: err?.message || 'Streaming fehlgeschlagen' });
                    res.end();
                }
            }
        });

        // MCP-API: CRUD für MCP-Server + Capability + Tool-Liste + direkter Tool-Call.
        // Der McpManager liest config.mcpServers dynamisch → Änderungen wirken sofort.
        this.router.get('/api/mcp/servers', (req, res) => {
            res.status(200).json({ success: true, data: { servers: this.mcp.listServers() } });
        });

        // Tool-Support des LLM-Backends (für UI-Hinweis).
        this.router.get('/api/mcp/capability', async (req, res, next) => {
            try {
                const toolSupport = await this.llm.detectToolSupport();
                res.status(200).json({ success: true, data: { toolSupport } });
            } catch (err) { next(err); }
        });

        // MCP-Server anlegen (ID aus Name generiert) + verbinden.
        this.router.post('/api/mcp/servers', (req, res, next) => {
            (async () => {
                const { name, url, headers, transport, enabled } = req.body || {};

                // ID wird serverseitig aus dem Namen generiert (Kollisionen → -2, -3).
                // Erst ID erzeugen, dann den vollständigen Eintrag validieren
                // (validateMcpServers erwartet eine nicht-leere id).
                const existing = new Set(this.config.mcpServers.map((s) => s.id));
                const id = this.config.slugify(name, existing);
                const entry = { id, name, url, headers: headers || {}, transport: transport || 'auto', enabled: enabled !== false };

                const errors = this.validateMcpEntry(entry);
                if (errors.length) {
                    const e = new Error(errors.join('; '));
                    e.status = 400;
                    e.code = 'invalid_mcp_server';
                    throw e;
                }

                const mcpServers = [...this.config.mcpServers, entry];
                this.config.updateSettings({ mcpServers });

                const result = entry.enabled ? await this.mcp.connect(id) : { id, status: 'disabled' };
                res.status(201).json({ success: true, data: { server: this.mcp.listServers().find((s) => s.id === id), result } });
            })().catch(next);
        });

        // MCP-Server aktualisieren (Partial) + bei Verbindungsänderung reconnecten.
        this.router.put('/api/mcp/servers/:id', (req, res, next) => {
            (async () => {
                const id = req.params.id;
                const current = this.config.mcpServers.find((s) => s.id === id);
                if (!current) {
                    const e = new Error('MCP-Server nicht gefunden');
                    e.status = 404;
                    throw e;
                }

                const patch = req.body || {};
                const updated = { ...current, ...patch, id }; // id ist immutable
                const errors = this.validateMcpEntry(updated);
                if (errors.length) {
                    const e = new Error(errors.join('; '));
                    e.status = 400;
                    e.code = 'invalid_mcp_server';
                    throw e;
                }

                const mcpServers = this.config.mcpServers.map((s) => (s.id === id ? updated : s));
                this.config.updateSettings({ mcpServers });

                // Bei Änderung von url/headers/transport/enabled → (re)connect.
                const connChanged = JSON.stringify({ u: updated.url, h: updated.headers, t: updated.transport, en: updated.enabled })
                    !== JSON.stringify({ u: current.url, h: current.headers, t: current.transport, en: current.enabled });
                let result = null;
                if (updated.enabled) {
                    result = connChanged ? await this.mcp.reconnect(id) : await this.mcp.connect(id);
                } else {
                    await this.mcp.disconnect(id);
                    this.mcp.setStatus(id, 'disabled');
                }
                res.status(200).json({ success: true, data: { server: this.mcp.listServers().find((s) => s.id === id), result } });
            })().catch(next);
        });

        // MCP-Server löschen + disconnecten.
        this.router.delete('/api/mcp/servers/:id', async (req, res, next) => {
            try {
                const id = req.params.id;
                await this.mcp.disconnect(id);
                const mcpServers = this.config.mcpServers.filter((s) => s.id !== id);
                this.config.updateSettings({ mcpServers });
                res.status(200).json({ success: true, data: { removed: id } });
            } catch (err) { next(err); }
        });

        // Reconnect eines Servers.
        this.router.post('/api/mcp/servers/:id/reconnect', async (req, res, next) => {
            try {
                const id = req.params.id;
                const result = await this.mcp.reconnect(id);
                res.status(200).json({ success: true, data: { server: this.mcp.listServers().find((s) => s.id === id), result } });
            } catch (err) { next(err); }
        });

        // Tool-Liste eines Servers.
        this.router.get('/api/mcp/servers/:id/tools', (req, res) => {
            const conn = this.mcp.connections.get(req.params.id);
            if (!conn) return res.status(404).json({ success: false, error: 'MCP-Server nicht gefunden' });
            res.status(200).json({ success: true, data: { tools: conn.tools } });
        });

        // Direkter Tool-Call (für Tests / Debug).
        this.router.post('/api/mcp/call', async (req, res, next) => {
            try {
                const { serverId, name, arguments: args } = req.body || {};
                if (!serverId || !name) return res.status(400).json({ success: false, error: 'serverId und name erforderlich' });
                const result = await this.mcp.callTool(serverId, name, args);
                res.status(200).json({ success: true, data: result });
            } catch (err) { next(err); }
        });

        const frontendRouter = new FrontendRouter(this.config, this.httpServer, this.logger);
        await frontendRouter.init();
        this.router.use('/', frontendRouter.router);

        // MCP: alle enabled-Server verbinden (fault-tolerant — ein kaputter
        // Server blockiert den Start nicht).
        await this.mcp.connectAll();

        // WebSocket-Upgrade-Routing (MUSST nach Vite-Init, damit Vites
        // eigener HMR-Listener zuerst dran ist und fremde Upgrades nicht bricht).
        this.setupUpgradeRouting();
    }

    /**
     * Validiert einen einzelnen MCP-Server-Eintrag (wiederverwendet die
     * Config-Validierung).
     * @param {object} entry - MCP-Server-Eintrag
     * @returns {string[]} Fehlerliste (leer = gültig)
     */
    validateMcpEntry(entry) {
        return this.config.validateMcpServers([entry]);
    }

    /**
     * Baut die Chat-Nachrichten in der Reihenfolge:
     * System-Prompt → History → aktuelle Frage.
     * @param {string} question - Die aktuelle Frage
     * @param {Array<{role: string, content: string}>} [history] - Optionale frühere Nachrichten
     * @returns {Array<{role: string, content: string}>}
     */
    buildChatMessages(question, history) {
        const messages = [];

        const systemPrompt = this.config.llm?.systemPrompt;
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        if (Array.isArray(history)) {
            for (const msg of history) {
                if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        messages.push({ role: 'user', content: question });
        return messages;
    }

    /**
     * Führt den Chat mit MCP-Tool-Loop aus (Non-Streaming).
     *
     * Graceful Degradation: Wenn keine MCP-Tools verbunden sind, verhält sich
     * die Methode wie der alte `chat()` (keine Tools im Payload). Wenn Tools
     * vorhanden sind, aber das Backend kein Function-Calling unterstützt,
     * wird ebenfalls auf den normalen Chat zurückgefallen.
     *
     * @param {string} question - Die aktuelle Frage
     * @param {Array<{role: string, content: string}>} [history] - Optionale frühere Nachrichten
     * @param {object} [options={}] - Zusätzliche Optionen (z. B. signal, model)
     * @returns {Promise<string>} Die finale Antwort
     */
    async runChatWithMcpTools(question, history, options = {}) {
        const messages = this.buildChatMessages(question, history);
        const tools = this.mcp.toOpenAITools();
        const maxTurns = MAX_MCP_TOOL_TURNS;

        // Kein Tool-Support im Backend → normaler Chat (Graceful Degradation).
        if (tools.length > 0) {
            const supported = await this.llm.detectToolSupport();
            if (!supported) {
                this.logger.log(this.label,
                    'LLM-Backend unterstützt kein Function-Calling. MCP-Tools werden nicht aufgerufen.');
                return this.llm.chat(messages, options);
            }
        }

        for (let turn = 0; turn < maxTurns; turn++) {
            const turnResult = await this.llm.chatWithTools(messages, tools, options);

            // Keine Tool-Calls → finale Antwort.
            if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
                return turnResult.content || turnResult.refusal || '';
            }

            // Assistant-Turn (mit tool_calls) anhängen.
            messages.push({
                role: 'assistant',
                content: turnResult.content,
                tool_calls: turnResult.toolCalls,
            });

            // Jeden Tool-Call ausführen + Ergebnis anhängen.
            for (const call of turnResult.toolCalls) {
                const parsed = this.mcp.parseToolName(call.function?.name);
                let content = 'Unbekanntes Tool';
                if (parsed) {
                    let args = {};
                    try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
                    const result = await this.mcp.callTool(parsed.serverId, parsed.toolName, args);
                    content = result.content;
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content,
                });
            }
        }

        // Turn-Cap erreicht.
        return `[Gestoppt nach ${maxTurns} MCP-Tool-Runden]`;
    }

    /**
     * Zentrales Upgrade-Routing auf dem gemeinsamen httpServer.
     *
     * Verteilt WebSocket-Upgrade-Anfragen gezielt:
     *   - /logs  → Log-WebSocket (noServer-Modus, manuelles handleUpgrade)
     *   - sonst  → Vite HMR (Vites eigener selektiver Listener, gebunden via
     *              ws: { server: httpServer } in der Vite-Konfiguration)
     *
     * Wichtig: Der Log-WebSocket läuft im noServer-Modus und registriert KEINEN
     * eigenen upgrade-Listener. Ein an den Server gebundener ws-Server würde
     * fremde Upgrades (z. B. Vite HMR) mit 400 Bad Request abbrechen.
     */
    setupUpgradeRouting() {
        // Alle upgraded Sockets (WebSocket) tracken: httpServer.close() und
        // closeAllConnections() beenden sie NICHT (nach dem Upgrade gehören
        // sie nicht mehr zum Server) — ohne explizites Destroyen hängt der
        // Shutdown (z. B. node --watch-Restart) auf offenen HMR-/Log-WS.
        this.upgradedSockets = new Set();
        this.httpServer.on('upgrade', (request, socket, head) => {
            this.upgradedSockets.add(socket);
            socket.on('close', () => this.upgradedSockets.delete(socket));

            let pathname;
            try {
                pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
            } catch {
                socket.destroy();
                return;
            }

            if (pathname === '/transcribe') {
                this.transcribeBridge.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.transcribeBridge.wss.emit('connection', ws, request);
                });
            } else if (pathname === '/logs' && this.logsWs) {
                this.logsWs.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.logsWs.wss.emit('connection', ws, request);
                });
            }
            // Alle anderen Upgrades (Vite HMR mit ?token=…) übernimmt Vites
            // eigener selektiver Listener — hier bewusst nichts weiter tun.
        });
    }

    /** Beendet alle offenen WebSocket-Verbindungen (Shutdown). */
    closeUpgradedSockets() {
        for (const socket of this.upgradedSockets) {
            socket.destroy();
        }
        this.upgradedSockets.clear();
    }
}

export { Router };
