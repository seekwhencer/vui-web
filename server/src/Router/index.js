
import express from 'express';
import { FrontendRouter } from './FrontendRouter.js';
import { TranscribeBridge } from '../Bridge/TranscribeBridge.js';
import { Llm } from '../Llm.js';

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
                const messages = this.buildChatMessages(question, req.body?.history);
                const answer = await this.llm.chat(messages);
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
            let stats = null;
            try {
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

        const frontendRouter = new FrontendRouter(this.config, this.httpServer, this.logger);
        await frontendRouter.init();
        this.router.use('/', frontendRouter.router);

        // WebSocket-Upgrade-Routing (MUSST nach Vite-Init, damit Vites
        // eigener HMR-Listener zuerst dran ist und fremde Upgrades nicht bricht).
        this.setupUpgradeRouting();
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
