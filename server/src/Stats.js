/**
 * In-memory-Collector für Laufzeit-Statistiken (LLM-Tokens, Transkriptionen, Uptime).
 *
 * Bewusst nicht persistent: Reset bei Server-Neustart, kein Persistenz-Overhead.
 */
class Stats {
    constructor() {
        this.startedAt = Date.now();
        this.llm = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        this.transcriptions = { count: 0 };
    }

    /**
     * Erfasst einen LLM-Turn (Requests + Token-Nutzung).
     * @param {{prompt?: number, completion?: number, total?: number}} [usage] - Token-Nutzung (fehlende Werte → 0)
     */
    recordLlm(usage) {
        this.llm.requests += 1;
        this.llm.promptTokens += usage?.prompt ?? 0;
        this.llm.completionTokens += usage?.completion ?? 0;
        this.llm.totalTokens += usage?.total ?? 0;
    }

    /**
     * Inkrementiert den Transkriptions-Counter (nur erfolgreiche Transkriptionen).
     */
    recordTranscription() {
        this.transcriptions.count += 1;
    }

    /**
     * Liefert einen Snapshot aus Uptime, LLM-Countern, Live-MCP-Daten und Transkriptionen.
     * @param {{listServers: () => Array<object>}} mcp - McpManager (liefert `listServers()`)
     * @returns {{server: object, llm: object, mcp: object, transcriptions: object}}
     */
    snapshot(mcp) {
        const servers = mcp.listServers();
        return {
            server: { startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt },
            llm: { ...this.llm },
            mcp: {
                configured: servers.length,
                connected: servers.filter((s) => s.status === 'connected').length,
                tools: servers.reduce((n, s) => n + (s.tools?.length ?? 0), 0),
            },
            transcriptions: { ...this.transcriptions },
        };
    }
}

export { Stats };
