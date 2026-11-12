import { assertSafeUrl } from './NetworkGuard.js';

/**
 * Execution-Gateway (Zero-Trust, Phase 4).
 *
 * Führt read-Klasse-Tools aus (direkt, ohne Approval) mit Timeout und
 * Ergebnis-Größenlimit. write/execute-Tools werden hier NICHT ausgeführt —
 * die brauchen eine menschliche Freigabe (ApprovalService) und werden über
 * `executeApproved(actionId)` ausgeführt.
 *
 * Zentrale Regel: Nur der Execution Gateway darf ausführen.
 */

/**
 * Erzeugt einen Fehler mit maschinenlesbarem Code (konsistent mit ApprovalService).
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function createError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

class ExecutionGateway {
    /**
     * @param {object} params
     * @param {McpManager} params.mcp - MCP-Transport (keine Autorisierung)
     * @param {ActionStore} params.store
     * @param {Audit} params.audit
     * @param {object} params.config - Config (liest config.security.toolTimeoutMs, maxToolResultBytes)
     * @param {import('../Logger.js')} [params.logger]
     */
    constructor({ mcp, store, audit, config, logger } = {}) {
        this.mcp = mcp;
        this.store = store;
        this.audit = audit;
        this.config = config;
        this.label = '[ExecutionGateway]';
        this.logger = logger || { log: () => { }, error: () => { } };
    }

    /** Liest das Tool-Timeout aus der Config (Default 30 s). */
    #timeoutMs() {
        const t = this.config?.security?.toolTimeoutMs;
        return Number.isFinite(t) && t > 0 ? t : 30000;
    }

    /** Liest das Ergebnis-Größenlimit aus der Config (Default 64 KB). */
    #maxResultBytes() {
        const m = this.config?.security?.maxToolResultBytes;
        return Number.isFinite(m) && m > 0 ? m : 65536;
    }

    /**
     * Führt ein read-Klasse-Tool aus (direkt, ohne Approval).
     * - Timeout (config.security.toolTimeoutMs)
     * - Ergebnis-Größenlimit (config.security.maxToolResultBytes)
     * - Audit: EXECUTION_COMPLETED / EXECUTION_FAILED
     *
     * @param {string} serverId
     * @param {string} toolName
     * @param {object} [args]
     * @returns {Promise<{content: string, isError: boolean}>}
     */
    async executeRead(serverId, toolName, args = {}) {
        const timeoutMs = this.#timeoutMs();
        let result;
        let failed = false;
        let errorMsg = null;
        try {
            result = await this.#withTimeout(
                this.mcp.callTool(serverId, toolName, args),
                timeoutMs,
                toolName
            );
        } catch (err) {
            failed = true;
            errorMsg = err.message;
            result = { content: err.message, isError: true };
        }

        if (failed || result.isError) {
            await this.#auditSafe('EXECUTION_FAILED', { toolName, error: errorMsg || result.content }, null);
            this.logger.error(`${this.label} executeRead fehlgeschlagen`, { serverId, toolName, error: errorMsg || result.content });
        } else {
            await this.#auditSafe('EXECUTION_COMPLETED', { toolName }, null);
        }

        // Größenlimit durchsetzen (Truncation + Hinweis).
        let content = result.content;
        const maxBytes = this.#maxResultBytes();
        const buf = Buffer.from(content, 'utf8');
        if (buf.length > maxBytes) {
            content = buf.slice(0, maxBytes).toString('utf8')
                + '\n[TRUNCATED: Ergebnis war größer als das erlaubte Limit]';
        }

        return { content, isError: result.isError };
    }

    /**
     * Führt eine APPROVED-Aktion aus (write/execute, Phase 4).
     *
     * Replay-Schutz: Der atomare Übergang APPROVED → EXECUTING ist die
     * Idempotenz-Garantie. Ein zweiter (oder konkurrenter) Aufruf für
     * dieselbe actionId findet den Status nicht mehr in APPROVED →
     * wirft INVALID_ACTION_STATE. Doppelte Ausführung ist ausgeschlossen.
     *
     * Ablauf:
     * 1. Existenz prüfen (ACTION_NOT_FOUND)
     * 2. Status muss APPROVED sein (INVALID_ACTION_STATE)
     * 3. Atomar APPROVED → EXECUTING (Replay-Schutz)
     * 4. NetworkGuard.assertSafeUrl erneut (URL-Argumente) → blockiert = FAILED
     * 5. mcp.callTool mit Timeout
     * 6. EXECUTING → COMPLETED | FAILED + Audit
     *
     * @param {string} actionId
     * @returns {Promise<object>} die COMPLETED- oder FAILED-Aktion
     * @throws {Error} ACTION_NOT_FOUND | INVALID_ACTION_STATE
     */
    async executeApproved(actionId) {
        // 1. Existenz
        const action = await this.store.get(actionId);
        if (action === null) {
            this.logger.error(`${this.label} executeApproved: Aktion nicht gefunden`, { actionId });
            throw createError('ACTION_NOT_FOUND', `Aktion ${actionId} nicht gefunden`);
        }

        // 2. Status muss APPROVED sein
        if (action.status !== 'APPROVED') {
            this.logger.error(`${this.label} executeApproved: falscher Status`, { actionId, status: action.status });
            throw createError('INVALID_ACTION_STATE', `Aktion ${actionId} ist im Status ${action.status}, erwartet APPROVED`);
        }

        // 3. Atomarer Übergang APPROVED → EXECUTING (Replay-Schutz)
        const executing = await this.store.transition(actionId, 'APPROVED', 'EXECUTING', {});
        if (executing === null) {
            this.logger.error(`${this.label} executeApproved: Übergang abgelehnt (Replay?)`, { actionId });
            throw createError('INVALID_ACTION_STATE', `Zustandsübergang APPROVED → EXECUTING für Aktion ${actionId} abgelehnt`);
        }

        // 4. NetworkGuard.assertSafeUrl erneut (falls URL-Argumente)
        for (const url of this.#collectUrls(action.arguments)) {
            const guard = await assertSafeUrl(url);
            if (!guard.ok) {
                const failed = await this.store.transition(actionId, 'EXECUTING', 'FAILED', {
                    result: { content: `BLOCKED: ${guard.reason}`, isError: true },
                });
                await this.#auditSafe('EXECUTION_FAILED', { toolName: action.toolName, error: `network-guard: ${guard.reason}` }, actionId);
                this.logger.error(`${this.label} executeApproved: durch NetworkGuard blockiert`, { actionId, url, reason: guard.reason });
                return failed;
            }
        }

        // 5. mcp.callTool mit Timeout
        const timeoutMs = this.#timeoutMs();
        let result;
        let failed = false;
        let errorMsg = null;
        try {
            result = await this.#withTimeout(
                this.mcp.callTool(action.serverId, action.toolName, action.arguments),
                timeoutMs,
                action.toolName
            );
        } catch (err) {
            failed = true;
            errorMsg = err.message;
            result = { content: err.message, isError: true };
        }

        // 6. EXECUTING → COMPLETED | FAILED + Audit
        if (failed || result.isError) {
            const finalAction = await this.store.transition(actionId, 'EXECUTING', 'FAILED', {
                result: { content: result.content, isError: true },
            });
            await this.#auditSafe('EXECUTION_FAILED', { toolName: action.toolName, error: errorMsg || result.content }, actionId);
            this.logger.error(`${this.label} executeApproved fehlgeschlagen`, { actionId, toolName: action.toolName, error: errorMsg || result.content });
            return finalAction;
        }

        const finalAction = await this.store.transition(actionId, 'EXECUTING', 'COMPLETED', {
            result: { content: result.content, isError: false },
        });
        await this.#auditSafe('EXECUTION_COMPLETED', { toolName: action.toolName }, actionId);
        this.logger.log(`${this.label} executeApproved erfolgreich`, { actionId, toolName: action.toolName });
        return finalAction;
    }

    /**
     * Sammelt alle http/https-URLs aus einem (möglicherweise verschachtelten)
     * Argument-Objekt. Nicht-URL-Strings und andere Typen werden ignoriert.
     * @param {unknown} value
     * @param {string[]} [out]
     * @returns {string[]}
     */
    #collectUrls(value, out = []) {
        if (typeof value === 'string') {
            try {
                const u = new URL(value);
                if (u.protocol === 'http:' || u.protocol === 'https:') out.push(value);
            } catch { /* keine URL */ }
        } else if (Array.isArray(value)) {
            for (const item of value) this.#collectUrls(item, out);
        } else if (value !== null && typeof value === 'object') {
            for (const v of Object.values(value)) this.#collectUrls(v, out);
        }
        return out;
    }

    /**
     * Race zwischen Promise und Timeout.
     * @param {Promise<unknown>} promise
     * @param {number} ms
     * @param {string} toolName
     * @returns {Promise<unknown>}
     */
    #withTimeout(promise, ms, toolName) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Tool-Call ${toolName} timeout nach ${ms}ms`)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    /**
     * Audit-Eintrag schreiben; ein Audit-Fehler darf den Hauptfehler nicht verdecken.
     * @param {string} event
     * @param {object} metadata
     * @param {string|null} actionId
     */
    async #auditSafe(event, metadata, actionId) {
        try {
            await this.audit.log(event, metadata, actionId);
        } catch (err) {
            this.logger.error(`${this.label} Audit-Eintrag fehlgeschlagen`, { event, error: err.message });
        }
    }
}

export { ExecutionGateway };
