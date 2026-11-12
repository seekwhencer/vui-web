
import express from 'express';
import { FrontendRouter } from './FrontendRouter.js';
import { TranscribeBridge } from '../Bridge/TranscribeBridge.js';
import { Llm } from '../Llm.js';
import { McpManager } from '../McpManager.js';
import { wrapUntrusted } from '../Security/Untrusted.js';
import { getSecurityPrompt } from '../Security/SystemPrompt.js';

/**
 * Main router class that aggregates all server routes.
 */
class Router {
    /**
     * @param {Config} config - Configuration object
     * @param {import('node:http').Server} httpServer - HTTP server instance
     * @param {Logger} [logger] - Logger instance
     * @param {{policy: PolicyEngine, approval: ApprovalService, audit: Audit, gateway: ExecutionGateway, store: ActionStore}} [security]
     *   Zero-Trust-Dependencies. Wenn vorhanden, erzwingt der Tool-Loop die
     *   Policy (deny / Approval / read via ExecutionGateway). Wenn nicht
     *   vorhanden, bleibt das Legacy-Verhalten (direkte Tool-Ausführung) —
     *   nur für Backward-Compatibility; die Produktion injiziert immer Security.
     * @param {McpManager} [mcp] - Optionaler geteilter MCP-Manager (sonst intern erzeugt).
     */
    constructor(config, httpServer, logger, security = null, mcp = null) {
        this.config = config;
        this.httpServer = httpServer;
        this.label = '[Router]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.security = security;

        this.router = express.Router();
        this.router.use(express.json());

        // WebSocket-Bridge für Live-Transkription (noServer, Upgrade wird
        // in setupUpgradeRouting gezielt hierher geroutet).
        this.transcribeBridge = new TranscribeBridge(this.config, this.logger);

        // LLM-Chat-Service (liest config.llm dynamisch zur Aufrufzeit).
        this.llm = new Llm({ config: this.config, logger: this.logger });

        // MCP-Manager (Verbindungen + Tool-Registry + Tool-Ausführung).
        // Liest config.mcpServers dynamisch zur Aufrufzeit.
        this.mcp = mcp || new McpManager({ config: this.config, logger: this.logger });
    }

    /**
     * Liest das Tool-Turn-Limit aus der Config (Zero-Trust-Budget).
     * Dynamisch zur Aufrufzeit, damit Runtime-Updates ohne Neustart wirken.
     * @returns {number} max. Tool-Runden (Default 10)
     */
    maxToolTurns() {
        const t = this.config?.security?.maxToolTurns;
        return Number.isFinite(t) && t > 0 ? t : 10;
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
                for (let turn = 0; turn < this.maxToolTurns(); turn++) {
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
                            if (this.security) {
                                const result = await this.handleToolCall(parsed, args, { send, reason: turnContent });
                                content = result.content;
                                isError = result.isError;
                            } else {
                                const result = await this.mcp.callTool(parsed.serverId, parsed.toolName, args);
                                content = result.content;
                                isError = result.isError;
                            }
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

        // Approval-API (Zero-Trust, Phase 2): Freigaben verwalten + Audit lesen.
        // Nur für den lokalen Menschen (UI) — das LLM erhält ausschließlich
        // Tool-Ergebnisse und hat keinen Zugriff auf diese Endpunkte.
        this.router.get('/api/actions/pending', async (req, res) => {
            if (!this.securityAvailable(res)) return;
            try {
                const actions = await this.security.store.listPending();
                res.status(200).json({ success: true, data: actions });
            } catch (err) {
                this.sendApprovalError(err, res);
            }
        });

        this.router.get('/api/actions/:id', async (req, res) => {
            if (!this.securityAvailable(res)) return;
            try {
                const action = await this.security.store.get(req.params.id);
                if (action === null) {
                    throw Router.approvalError('ACTION_NOT_FOUND', `Aktion ${req.params.id} nicht gefunden`);
                }
                res.status(200).json({ success: true, data: action });
            } catch (err) {
                this.sendApprovalError(err, res);
            }
        });

        this.router.post('/api/actions/:id/approve', async (req, res) => {
            if (!this.securityAvailable(res)) return;
            try {
                const action = await this.security.approval.approve(req.params.id);
                res.status(200).json({ success: true, data: action });
            } catch (err) {
                this.sendApprovalError(err, res);
            }
        });

        this.router.post('/api/actions/:id/reject', async (req, res) => {
            if (!this.securityAvailable(res)) return;
            try {
                const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
                const action = await this.security.approval.reject(req.params.id, reason);
                res.status(200).json({ success: true, data: action });
            } catch (err) {
                this.sendApprovalError(err, res);
            }
        });

        this.router.post('/api/actions/:id/cancel', async (req, res) => {
            if (!this.securityAvailable(res)) return;
            try {
                const action = await this.security.approval.cancel(req.params.id);
                res.status(200).json({ success: true, data: action });
            } catch (err) {
                this.sendApprovalError(err, res);
            }
        });

        this.router.get('/api/audit', async (req, res) => {
            if (!this.securityAvailable(res)) return;
            try {
                const entries = await this.security.audit.tail(Router.parseAuditLimit(req.query.limit));
                res.status(200).json({ success: true, data: entries });
            } catch (err) {
                this.sendApprovalError(err, res);
            }
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
     * Mappt Approval-Fehler-Codes auf HTTP-Status.
     * @type {Record<string, number>}
     */
    static APPROVAL_ERROR_STATUS = {
        ACTION_NOT_FOUND: 404,
        INVALID_ACTION_STATE: 409,
        APPROVAL_EXPIRED: 410,
        INTEGRITY_FAILURE: 500,
        POLICY_DENIED: 403,
    };

    /**
     * Erzeugt einen Fehler mit maschinenlesbarem Approval-Code.
     * @param {string} code
     * @param {string} message
     * @returns {Error}
     */
    static approvalError(code, message) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    /**
     * Parst den ?limit-Parameter des Audit-Endpunkts (Default 50, max 500).
     * @param {unknown} value
     * @returns {number}
     */
    static parseAuditLimit(value) {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) return 50;
        return Math.min(n, 500);
    }

    /**
     * Guard für die Approval-/Audit-Endpunkte: Security-Stack muss injiziert sein.
     * @param {import('express').Response} res
     * @returns {boolean} false, wenn bereits geantwortet wurde
     */
    securityAvailable(res) {
        if (this.security) return true;
        res.status(503).json({
            success: false,
            error: { code: 'SECURITY_DISABLED', message: 'Security-Stack ist nicht aktiviert' },
        });
        return false;
    }

    /**
     * Antwortet auf Approval-Fehler mit dem gemappten HTTP-Status und
     * { success: false, error: { code, message } }.
     * @param {Error} err
     * @param {import('express').Response} res
     */
    sendApprovalError(err, res) {
        const status = Router.APPROVAL_ERROR_STATUS[err?.code] || 500;
        if (status >= 500) {
            this.logger.error(this.label, 'Approval-Endpunkt fehlgeschlagen', { code: err?.code, error: err?.message });
        }
        res.status(status).json({
            success: false,
            error: { code: err?.code || 'INTERNAL_ERROR', message: err?.message || 'Internal Server Error' },
        });
    }

    /**
     * Baut die Chat-Nachrichten in der Reihenfolge:
     * Security-Prompt → System-Prompt → History → aktuelle Frage.
     * @param {string} question - Die aktuelle Frage
     * @param {Array<{role: string, content: string}>} [history] - Optionale frühere Nachrichten
     * @returns {Array<{role: string, content: string}>}
     */
    buildChatMessages(question, history) {
        const messages = [];

        // Security-Prompt (Zero-Trust, Phase 3) + LLM-System-Prompt werden zu
        // EINER System-Message zusammengeführt. Viele Chat-Templates (z. B.
        // Qwen3 via llama.cpp) erlauben nur genau eine System-Message an
        // Position 0 und werfen sonst "System message must be at the
        // beginning". Zwei separate System-Nachrichten brechen den Request.
        //
        // Der Security-Prompt ist KEINE Sicherheitsgrenze — die Grenze ist die
        // Policy Engine + Approval Flow. Er reduziert nur die Chance, dass das
        // LLM injizierte Anweisungen aus Tool-Ergebnissen befolgt.
        const parts = [];
        const securityPrompt = getSecurityPrompt(this.config);
        if (securityPrompt && String(securityPrompt).trim() !== '') {
            parts.push(String(securityPrompt).trim());
        }
        const systemPrompt = this.config.llm?.systemPrompt;
        if (systemPrompt && String(systemPrompt).trim() !== '') {
            parts.push(String(systemPrompt).trim());
        }
        if (parts.length > 0) {
            messages.push({ role: 'system', content: parts.join('\n\n') });
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
     * Führt einen Tool-Call gemäß der Zero-Trust-Policy aus.
     *
     * - deny        → DENIED (Audit POLICY_DENIED), LLM erhält Ablehnung.
     * - write/exec  → AWAITING_APPROVAL (Aktion vorgeschlagen, NICHT ausgeführt).
     *                 Optional wird ein `approval_required`-SSE-Event gesendet.
     * - read        → direkt ausgeführt (ExecutionGateway: Timeout + Größenlimit),
     *                 Ergebnis als Untrusted Data markiert.
     *
     * @param {{serverId: string, toolName: string}} parsed - Zerlegter Tool-Name
     * @param {object} args - Tool-Argumente
     * @param {{send?: Function, reason?: string}} [options]
     *   send: SSE-Helper (für `approval_required`), reason: Kontext für die Freigabe
     * @returns {Promise<{content: string, isError: boolean}>}
     */
    async handleToolCall(parsed, args, { send, reason } = {}) {
        const policyResult = this.security.policy.evaluate(parsed.serverId, parsed.toolName, args);

        if (!policyResult.allowed) {
            await this.security.audit.log('POLICY_DENIED', { toolName: parsed.toolName, reason: policyResult.reason });
            this.logger.log(this.label, 'Tool-Call abgelehnt (Policy)', {
                tool: `${parsed.serverId}__${parsed.toolName}`, reason: policyResult.reason,
            });
            return { content: `DENIED: ${policyResult.reason}`, isError: true };
        }

        if (policyResult.requiresApproval) {
            const action = await this.security.approval.propose({
                serverId: parsed.serverId,
                toolName: parsed.toolName,
                args,
                reason: reason || '',
            });
            if (send) {
                send('approval_required', {
                    actionId: action.id,
                    toolName: parsed.toolName,
                    arguments: args,
                    reason: action.reason,
                    expiresAt: action.expiresAt,
                });
            }
            this.logger.log(this.label, 'Tool-Call wartet auf Freigabe', {
                actionId: action.id, tool: `${parsed.serverId}__${parsed.toolName}`,
            });
            return { content: `AWAITING_APPROVAL: Aktion ${action.id} wartet auf Freigabe.`, isError: false };
        }

        // read: direkt ausführen (Timeout + Größenlimit) + Untrusted-Wrapping.
        const result = await this.security.gateway.executeRead(parsed.serverId, parsed.toolName, args);
        return { content: wrapUntrusted(result.content), isError: result.isError };
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
        const maxTurns = this.maxToolTurns();

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
                    if (this.security) {
                        const result = await this.handleToolCall(parsed, args, { reason: turnResult.content });
                        content = result.content;
                    } else {
                        const result = await this.mcp.callTool(parsed.serverId, parsed.toolName, args);
                        content = result.content;
                    }
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
