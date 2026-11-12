/**
 * Policy-Engine (Zero-Trust, Phase 1).
 *
 * Klassifiziert namespaced MCP-Tools (`${serverId}__${toolName}`) und
 * bewertet Tool-Aufrufe. Default für nicht klassifizierte Tools: 'deny'
 * (deny-by-default). Die Engine ist die einzige Autorisierungsinstanz —
 * das LLM darf nur vorschlagen.
 */

/** @typedef {'read'|'write'|'execute'|'deny'} ToolClass */
/** @typedef {{allowed: boolean, requiresApproval: boolean, risk: string, reason: string}} PolicyResult */

const TOOL_CLASSES = ['read', 'write', 'execute', 'deny'];

class PolicyEngine {
    /**
     * @param {object} params
     * @param {object} [params.config] - Config (liest config.security.toolPolicies)
     * @param {import('../Logger.js')} [params.logger]
     */
    constructor({ config, logger } = {}) {
        this.config = config;
        this.label = '[PolicyEngine]';
        this.logger = logger || { log: () => { }, error: () => { } };
    }

    /**
     * Liest die Tool-Policies aus der Config (dynamisch, damit
     * Runtime-Updates ohne Neustart wirken). Ungültige Werte → leeres Map.
     * @returns {Record<string, string>}
     */
    #policies() {
        const security = this.config?.security;
        const policies = security?.toolPolicies;
        if (policies && typeof policies === 'object' && !Array.isArray(policies)) {
            return policies;
        }
        return {};
    }

    /**
     * Klassifiziert ein namespaced MCP-Tool.
     * Default (nicht konfiguriert): 'deny' (deny-by-default).
     * @param {string} serverId
     * @param {string} toolName
     * @returns {ToolClass}
     */
    classify(serverId, toolName) {
        const key = `${serverId}__${toolName}`;
        const value = this.#policies()[key];
        if (TOOL_CLASSES.includes(value)) return value;
        return 'deny';
    }

    /**
     * Bewertet einen Tool-Aufruf.
     * @param {string} serverId
     * @param {string} toolName
     * @param {object} [args]
     * @returns {PolicyResult}
     */
    evaluate(serverId, toolName, args = {}) {
        const key = `${serverId}__${toolName}`;
        const cls = this.classify(serverId, toolName);
        switch (cls) {
            case 'read':
                return { allowed: true, requiresApproval: false, risk: 'low', reason: `Tool ${key} ist als read klassifiziert` };
            case 'write':
                return { allowed: true, requiresApproval: true, risk: 'medium', reason: `Tool ${key} ist als write klassifiziert und benötigt Freigabe` };
            case 'execute':
                return { allowed: true, requiresApproval: true, risk: 'high', reason: `Tool ${key} ist als execute klassifiziert und benötigt Freigabe` };
            case 'deny':
            default:
                this.logger.log(`${this.label} evaluate: abgelehnt`, { tool: key, class: cls });
                return { allowed: false, requiresApproval: false, risk: 'blocked', reason: `Tool ${key} ist durch die Policy gesperrt (deny)` };
        }
    }
}

export { PolicyEngine, TOOL_CLASSES };
