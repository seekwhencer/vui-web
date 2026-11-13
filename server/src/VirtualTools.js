/**
 * Virtuelle Tools: Tool-Definitionen + Resolver-Registry für server-seitig
 * aufgelöste Tools (`get_config`, `get_mcp`, `get_policies`, `get_stats`).
 *
 * Die Definitionen werden in die LLM-Tool-Liste injiziert; die Auflösung
 * erfolgt lokal und deterministisch (kein Netzwerk, kein MCP-Client).
 * `ctx` = `{ config, mcp, stats }` — wird vom Router gebaut und übergeben.
 */

/** Formatiert einen Config-Wert für die Markdown-Tabelle (Arrays/Objekte → JSON). */
function formatValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/** Escaped Pipe-Zeichen in einer Markdown-Tabelle. */
function mdCell(value) {
    return String(value).replace(/\|/g, '\\|');
}

/** Baut eine Parameter/Wert-Tabelle aus [key, value]-Paaren. */
function kvTable(rows) {
    const lines = ['| Parameter | Wert |', '|-----------|------|'];
    for (const [key, value] of rows) {
        lines.push(`| ${mdCell(key)} | ${mdCell(formatValue(value))} |`);
    }
    return lines.join('\n');
}

/** Liefert die MCP-Server-Liste (defensive, leeres Array bei Fehlen). */
function listMcpServers(mcp) {
    return mcp?.listServers?.() || [];
}

/** Kürzt einen Text auf max Zeichen (mit Ellipse). */
function truncate(text, max) {
    const s = String(text);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Formatiert eine Uptime-Dauer (ms) als "3h 12m" / "12m 5s" / "45s". */
function formatUptime(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

/** Formatiert einen ms-Zeitstempel als ISO-String (ohne Millisekunden). */
function formatIso(ts) {
    return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Gültige Sektionen für get_config. */
const CONFIG_SECTIONS = ['llm', 'whisper', 'security', 'mcp', 'badwords', 'server'];

/**
 * Rendert die Config als Markdown-Dokument.
 * Sensibel: `systemPrompt` und MCP-`headers` werden nicht angezeigt.
 * @param {object} config - Config-Instanz
 * @param {object} mcp - McpManager-Instanz
 * @param {string} [section] - Optionale Sektion (llm|whisper|security|mcp|badwords|server)
 * @returns {string}
 */
function renderConfigMarkdown(config, mcp, section) {
    if (section !== undefined && !CONFIG_SECTIONS.includes(section)) {
        throw new Error(`Unbekannte Sektion: '${section}'. Verfügbare: ${CONFIG_SECTIONS.join(', ')}.`);
    }
    const settings = config.getSettings();
    const parts = ['# VUI Configuration'];

    if (section === undefined || section === 'llm') {
        const llm = settings.llm || {};
        parts.push(`## LLM\n${kvTable([
            ['api', llm.api],
            ['host', llm.host],
            ['port', llm.port],
            ['model', llm.model],
        ])}`);
    }

    if (section === undefined || section === 'whisper') {
        const whisper = settings.whisper || {};
        parts.push(`## Whisper\n${kvTable(Object.entries(whisper))}`);
    }

    if (section === undefined || section === 'security') {
        const security = settings.security || {};
        parts.push(`## Security\n${kvTable([
            ['maxToolTurns', security.maxToolTurns],
            ['maxToolResultBytes', security.maxToolResultBytes],
            ['toolTimeoutMs', security.toolTimeoutMs],
            ['maxPendingActions', security.maxPendingActions],
            ['approvalTtlMs', security.approvalTtlMs],
        ])}`);
    }

    if (section === undefined || section === 'mcp') {
        const lines = ['## MCP-Server', '| ID | Name | URL | Status |', '|----|------|-----|--------|'];
        for (const s of listMcpServers(mcp)) {
            lines.push(`| ${mdCell(s.id)} | ${mdCell(s.name)} | ${mdCell(s.url)} | ${mdCell(s.status)} |`);
        }
        parts.push(lines.join('\n'));
    }

    if (section === undefined || section === 'badwords') {
        const badwords = settings.badwords || [];
        const lines = ['## Badwords'];
        if (badwords.length === 0) {
            lines.push('(leer)');
        } else {
            for (const w of badwords) lines.push(`- ${mdCell(w)}`);
        }
        parts.push(lines.join('\n'));
    }

    if (section === undefined || section === 'server') {
        parts.push(`## Server\n${kvTable([
            ['serverPort', settings.serverPort],
            ['verbose', settings.verbose],
            ['whisperHost', settings.whisperHost],
            ['whisperPort', settings.whisperPort],
        ])}`);
    }

    return parts.join('\n\n');
}

/**
 * Rendert die MCP-Server als Markdown-Dokument.
 * Sensibel: `headers` werden nicht angezeigt.
 * @param {object} mcp - McpManager-Instanz
 * @param {string} [serverId] - Optionale Server-ID
 * @returns {string}
 */
function renderMcpMarkdown(mcp, serverId) {
    const servers = listMcpServers(mcp);
    if (servers.length === 0) {
        return '# MCP-Server\n\n(keine MCP-Server konfiguriert)';
    }

    let selected;
    if (serverId !== undefined) {
        selected = servers.filter((s) => s.id === serverId);
        if (selected.length === 0) {
            throw new Error(`Unbekannter MCP-Server: '${serverId}'. Verfügbare IDs: ${servers.map((s) => s.id).join(', ')}.`);
        }
    } else {
        selected = servers;
    }

    const parts = ['# MCP-Server'];
    for (const server of selected) {
        const rows = [
            ['name', server.name],
            ['url', server.url],
            ['transport', server.transport],
            ['enabled', server.enabled],
            ['status', server.status],
            ['toolCount', server.toolCount],
        ];
        if (server.error) rows.push(['error', server.error]);
        const block = [`## ${server.id}\n${kvTable(rows)}`];

        const tools = mcp?.connections?.get(server.id)?.tools || [];
        if (server.status === 'connected' && tools.length > 0) {
            const toolLines = ['### Tools', '| Tool | Beschreibung |', '|------|--------------|'];
            for (const tool of tools) {
                toolLines.push(`| ${mdCell(tool.name)} | ${mdCell(truncate(tool.description || '', 100))} |`);
            }
            block.push(toolLines.join('\n'));
        }
        parts.push(block.join('\n\n'));
    }

    return parts.join('\n\n');
}

/**
 * Rendert die Tool-Policies als Markdown-Dokument.
 * @param {object} config - Config-Instanz
 * @param {string} [serverId] - Optionale Server-ID
 * @returns {string}
 */
function renderPoliciesMarkdown(config, serverId) {
    const security = config.security || {};
    const toolPolicies = (security.toolPolicies && typeof security.toolPolicies === 'object' && !Array.isArray(security.toolPolicies))
        ? security.toolPolicies
        : {};
    const allowedHosts = Array.isArray(security.allowedHosts) ? security.allowedHosts : [];
    const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];

    let selected;
    if (serverId !== undefined) {
        if (!servers.some((s) => s.id === serverId)) {
            throw new Error(`Unbekannter MCP-Server: '${serverId}'. Verfügbare IDs: ${servers.map((s) => s.id).join(', ')}.`);
        }
        selected = servers.filter((s) => s.id === serverId);
    } else {
        selected = servers;
    }

    const parts = [
        '# MCP-Policies',
        'Default: **deny** (nicht konfigurierte Tools sind gesperrt)',
    ];

    for (const server of selected) {
        const prefix = `${server.id}__`;
        const entries = Object.entries(toolPolicies).filter(([key]) => key.startsWith(prefix));
        let block;
        if (entries.length === 0) {
            block = `## ${server.id}\n(keine Policies gesetzt — alle Tools: deny)`;
        } else {
            const lines = ['| Tool | Policy |', '|------|--------|'];
            for (const [key, policy] of entries) {
                lines.push(`| ${mdCell(key.slice(prefix.length))} | ${mdCell(policy)} |`);
            }
            block = `## ${server.id}\n${lines.join('\n')}`;
        }
        parts.push(block);
    }

    const allowLines = ['## SSRF-Allowlist'];
    if (allowedHosts.length === 0) {
        allowLines.push('(leer — nur localhost/127.0.0.1 erlaubt)');
    } else {
        for (const host of allowedHosts) allowLines.push(`- ${mdCell(host)}`);
    }
    parts.push(allowLines.join('\n'));

    parts.push('Hinweis: Virtuelle Tools (get_config, get_mcp, get_policies, get_stats) sind nicht policy-geschützt — sie werden lokal aufgelöst, bevor der Policy-Check greift.');

    return parts.join('\n\n');
}

/** Gültige Sektionen für get_stats. */
const STATS_SECTIONS = ['llm', 'mcp', 'transcriptions'];

/**
 * Rendert die Laufzeit-Statistiken als Markdown-Dokument.
 * Nur Zahlen (Tokens, Counts, Uptime) — keine Prompts, Inhalte oder URLs.
 * @param {object} stats - Stats-Instanz
 * @param {object} mcp - McpManager-Instanz
 * @param {string} [section] - Optionale Sektion (llm|mcp|transcriptions)
 * @returns {string}
 */
function renderStatsMarkdown(stats, mcp, section) {
    if (section !== undefined && !STATS_SECTIONS.includes(section)) {
        throw new Error(`Unbekannte Sektion: '${section}'. Verfügbare: ${STATS_SECTIONS.join(', ')}.`);
    }
    const snap = stats.snapshot(mcp);
    const parts = ['# VUI Stats'];

    if (section === undefined) {
        parts.push(`## Server\n${kvTable([
            ['uptime', formatUptime(snap.server.uptimeMs)],
            ['startedAt', formatIso(snap.server.startedAt)],
        ])}`);
    }

    if (section === undefined || section === 'llm') {
        parts.push(`## LLM\n${kvTable([
            ['requests', snap.llm.requests],
            ['promptTokens', snap.llm.promptTokens],
            ['completionTokens', snap.llm.completionTokens],
            ['totalTokens', snap.llm.totalTokens],
        ])}`);
    }

    if (section === undefined || section === 'mcp') {
        parts.push(`## MCP\n${kvTable([
            ['configured', snap.mcp.configured],
            ['connected', snap.mcp.connected],
            ['tools', snap.mcp.tools],
        ])}`);
    }

    if (section === undefined || section === 'transcriptions') {
        parts.push(`## Transkriptionen\n${kvTable([
            ['count', snap.transcriptions.count],
        ])}`);
    }

    return parts.join('\n\n');
}

/** Resolver-Registry: Tool-Name → { definition, handler }. */
const VIRTUAL_TOOLS = {
    get_config: {
        definition: {
            type: 'function',
            function: {
                name: 'get_config',
                description: 'Liefert die aktuelle VUI-Server-Configuration als strukturiertes Markdown. Aufrufen, wenn der Nutzer nach Konfiguration, Modell-Einstellungen, Security-Parametern, Whisper-Settings oder MCP-Server-Status fragt.',
                parameters: {
                    type: 'object',
                    properties: {
                        section: {
                            type: 'string',
                            enum: ['llm', 'whisper', 'security', 'mcp', 'badwords', 'server'],
                            description: 'Optionale Sektion. Weglassen für die vollständige Config.'
                        }
                    },
                    required: []
                }
            }
        },
        handler: (args, ctx) => renderConfigMarkdown(ctx.config, ctx.mcp, args?.section)
    },
    get_mcp: {
        definition: {
            type: 'function',
            function: {
                name: 'get_mcp',
                description: 'Liefert die konfigurierten MCP-Server mit Einstellungen, Verbindungsstatus und Tool-Listen. Aufrufen, wenn der Nutzer nach MCP-Servern, deren Konfiguration, Status oder verfügbaren Tools fragt.',
                parameters: {
                    type: 'object',
                    properties: {
                        serverId: {
                            type: 'string',
                            description: 'Optionale Server-ID. Weglassen für alle Server.'
                        }
                    },
                    required: []
                }
            }
        },
        handler: (args, ctx) => renderMcpMarkdown(ctx.mcp, args?.serverId)
    },
    get_policies: {
        definition: {
            type: 'function',
            function: {
                name: 'get_policies',
                description: 'Liefert die Tool-Policies (read/write/execute/deny) und die SSRF-Allowlist. Aufrufen, wenn der Nutzer nach Berechtigungen, Freigaben oder der Security-Policy fragt.',
                parameters: {
                    type: 'object',
                    properties: {
                        serverId: {
                            type: 'string',
                            description: 'Optionale Server-ID. Weglassen für alle Policies.'
                        }
                    },
                    required: []
                }
            }
        },
        handler: (args, ctx) => renderPoliciesMarkdown(ctx.config, args?.serverId)
    },
    get_stats: {
        definition: {
            type: 'function',
            function: {
                name: 'get_stats',
                description: 'Liefert Laufzeit-Statistiken: Uptime, LLM-Token-Nutzung, MCP-Verbindungen, Transkriptionen. Aufrufen, wenn der Nutzer nach Nutzung, Token-Verbrauch oder Systemstatus fragt.',
                parameters: {
                    type: 'object',
                    properties: {
                        section: {
                            type: 'string',
                            enum: ['llm', 'mcp', 'transcriptions'],
                            description: 'Optionale Sektion. Weglassen für alle Statistiken.'
                        }
                    },
                    required: []
                }
            }
        },
        handler: (args, ctx) => renderStatsMarkdown(ctx.stats, ctx.mcp, args?.section)
    }
};

/**
 * Liefert die Tool-Definitionen aller virtuellen Tools (für die LLM-Tool-Liste).
 * @returns {Array<object>}
 */
export function getVirtualToolDefinitions() {
    return Object.values(VIRTUAL_TOOLS).map((t) => t.definition);
}

/**
 * Löst ein virtuelles Tool server-seitig auf.
 * @param {string} name - Tool-Name
 * @param {object} [args] - Tool-Argumente
 * @param {{config: object, mcp: object, stats: object}} ctx - Kontext (Config, McpManager, Stats)
 * @returns {{content: string, isError: boolean}}
 */
export function resolveVirtualTool(name, args, ctx) {
    const tool = VIRTUAL_TOOLS[name];
    if (!tool) return { content: `Unbekanntes virtuelles Tool: ${name}`, isError: true };
    try {
        return { content: tool.handler(args, ctx), isError: false };
    } catch (err) {
        return { content: `Fehler: ${err.message}`, isError: true };
    }
}

export { VIRTUAL_TOOLS, renderConfigMarkdown, renderMcpMarkdown, renderPoliciesMarkdown, renderStatsMarkdown };
