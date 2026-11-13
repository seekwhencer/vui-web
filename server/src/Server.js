import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './Router/index.js';
import { McpManager } from './McpManager.js';
import { PolicyEngine } from './Security/PolicyEngine.js';
import { ApprovalService } from './Security/ApprovalService.js';
import { ActionStore } from './Security/ActionStore.js';
import { Audit } from './Security/Audit.js';
import { ExecutionGateway } from './Security/ExecutionGateway.js';
import { Stats } from './Stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Main server class
 * 
 */
export class Server {
    /**
     * @param {object} config - Configuration object
     * @param {Logger} [logger] - Logger instance
     */
    constructor(config, logger) {
        this.config = config;
        this.label = '[Server]';
        this.logger = logger || { log: () => {}, error: () => {} };

        // create
        this.app = express();
        this.httpServer = createHttpServer(this.app);

        // security headers on every response (covers all routes, 404 and 500 handlers)
        this.app.use((req, res, next) => {
            res.setHeader('X-Frame-Options', 'DENY');

            if (process.env.NODE_ENV === 'production') {
                res.setHeader("Content-Security-Policy", "default-src 'self'");
            }
            res.setHeader('X-Content-Type-Options', 'nosniff');
            next();
        });
   }

    /**
     * Starts the HTTP server 
     * Registers signal handlers for clean shutdown.
     * @returns {Promise<void>}
     */
    async start() {
        // Zero-Trust-Security-Dependencies instanziieren (Phase 1+2).
        // Daten unter server/data/ (git-ignored): actions.json + audit.jsonl.
        const dataDir = join(__dirname, 'data');
        mkdirSync(dataDir, { recursive: true });
        const store = new ActionStore(join(dataDir, 'actions.json'), this.logger);
        const audit = new Audit(join(dataDir, 'audit.jsonl'), this.logger);
        const policy = new PolicyEngine({ config: this.config, logger: this.logger });
        const approval = new ApprovalService({ store, audit, policy, config: this.config, logger: this.logger });

        // MCP-Manager wird zwischen Router und ExecutionGateway geteilt
        // (gleiche Verbindungen/Tool-Registry).
        const mcp = new McpManager({ config: this.config, logger: this.logger });
        const gateway = new ExecutionGateway({ mcp, store, audit, config: this.config, logger: this.logger });

        const security = { policy, approval, audit, gateway, store };

        // In-memory-Stats-Collector (LLM-Tokens, Transkriptionen, Uptime).
        // Reset bei Server-Neustart — bewusst nicht persistent.
        const stats = new Stats();

        // append the routes
        this.router = new Router(this.config, this.httpServer, this.logger, security, mcp, stats);
        this.router.stats = stats;
        this.router.transcribeBridge.onTranscription = () => stats.recordTranscription();
        await this.router.define();
        this.app.use(this.router.router);

        // 404
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Not found', status: 'error', code: 'not_found' });
        });

        // 500 (zentraler Error-Handler)
        this.app.use((error, req, res, next) => {
            const status = error.status || 500;
            const code = error.code || 'internal_error';
            if (status >= 500) {
                this.logger.error(this.label, 'Error', { error: error.message, code });
            }
            res.status(status).json({ error: error.message, status: 'error', code });
        });

        this.httpServer.listen(this.config.serverPort, () => {
            this.logger.log(this.label,`Server running on port ${this.config.serverPort}`);
        });

        const shutdown = async () => {
            this.logger.log(this.label, 'Shutting down...');
            this.router?.transcribeBridge?.close(); // Transkriptions-WS-Clients terminate
            this.router?.logsWs?.close(); // WS-Clients terminate (sonst hängt httpServer.close())
            this.router?.tailService?.stop(); // tail-Child-Process SIGTERM
            this.router?.mcp?.close(); // MCP-Verbindungen + SSE-Streams beenden (sonst blockiert --watch-Restart)
            this.httpServer.close(() => process.exit(0));
            // Offene Verbindungen aktiv beenden, sonst wartet close() ewig
            // und der Prozess läuft nicht aus (blockiert den --watch-Restart):
            // - HTTP Keep-Alive → closeAllConnections()
            // - WebSocket (Vite HMR, /logs) → upgraded Sockets explizit destroyen
            this.httpServer.closeAllConnections();
            this.router?.closeUpgradedSockets?.();
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

        // something goes wrong ;)
        process.on('unhandledRejection', (reason) => {
            this.logger.error(this.label, 'Unhandled Rejection', { reason: reason?.message, ...reason });
        });
    }

}
