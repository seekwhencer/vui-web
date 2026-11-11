import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Whisper-Transkriptionsparameter (faster-whisper / Wyoming-Protokoll).
 *
 * Jede Zeile:
 *   env       – Umgebungsvariable, die den Wert überschreibt
 *   type      – 'string' | 'boolean' | 'integer' | 'number' | 'array' | 'object'
 *   default   – Standardwert (wird in config.json geschrieben)
 *   wyoming   – Schlüsselname im Wyoming-Protokoll (snake_case)
 *
 * Die Reihenfolge bestimmt die Reihenfolge in der UI.
 */
const WHISPER_PARAMS = {
    language: { env: 'WHISPER_LANG', type: 'string', default: 'de', wyoming: 'language' },
    temperature: { env: 'WHISPER_TEMPERATURE', type: 'array', default: [0.0], wyoming: 'temperature' },
    prompt: { env: 'WHISPER_PROMPT', type: 'string', default: '', wyoming: 'prompt' },
    translate: { env: 'WHISPER_TRANSLATE', type: 'boolean', default: false, wyoming: 'translate' },
    beamSize: { env: 'WHISPER_BEAM_SIZE', type: 'integer', default: 5, wyoming: 'beam_size', min: 0 },
    bestOf: { env: 'WHISPER_BEST_OF', type: 'integer', default: 5, wyoming: 'best_of', min: 1 },
    patience: { env: 'WHISPER_PATIENCE', type: 'number', default: 1.0, wyoming: 'patience' },
    lengthPenalty: { env: 'WHISPER_LENGTH_PENALTY', type: 'number', default: 1.0, wyoming: 'length_penalty' },
    repetitionPenalty: { env: 'WHISPER_REPETITION_PENALTY', type: 'number', default: 1.0, wyoming: 'repetition_penalty' },
    compressionRatioThreshold: { env: 'WHISPER_COMPRESSION_RATIO_THRESHOLD', type: 'number', default: 2.4, wyoming: 'compression_ratio_threshold' },
    logProbThreshold: { env: 'WHISPER_LOG_PROB_THRESHOLD', type: 'number', default: -1.0, wyoming: 'log_prob_threshold' },
    noSpeechThreshold: { env: 'WHISPER_NO_SPEECH_THRESHOLD', type: 'number', default: 0.6, wyoming: 'no_speech_threshold' },
    conditionOnPreviousText: { env: 'WHISPER_CONDITION_ON_PREVIOUS_TEXT', type: 'boolean', default: true, wyoming: 'condition_on_previous_text' },
    initialPrompt: { env: 'WHISPER_INITIAL_PROMPT', type: 'string', default: '', wyoming: 'initial_prompt' },
    hotwords: { env: 'WHISPER_HOTWORDS', type: 'string', default: '', wyoming: 'hotwords' },
    vadFilter: { env: 'WHISPER_VAD_FILTER', type: 'boolean', default: false, wyoming: null },
    vadParameters: { env: 'WHISPER_VAD_PARAMETERS', type: 'object', default: {}, wyoming: 'vad_parameters' },
};

/** Gültige Schlüssel für vad_parameters (faster-whisper VAD). */
const VAD_PARAM_KEYS = [
    'threshold',
    'min_speech_duration_ms',
    'min_silence_duration_ms',
    'window_size_samples',
    'speech_pad_ms',
];

/**
 * LLM-Chat-Parameter (OpenAI-kompatible API / Ollama).
 *
 * Jede Zeile:
 *   env       – Umgebungsvariable, die den Wert überschreibt
 *   type      – 'string' | 'integer'
 *   default   – Standardwert (wird in config.json geschrieben)
 *
 * Die Reihenfolge bestimmt die Reihenfolge in der UI.
 */
const LLM_PARAMS = {
    api: { env: 'LLM_API', type: 'string', default: 'openai' },
    host: { env: 'LLM_HOST', type: 'string', default: '' },
    port: { env: 'LLM_PORT', type: 'integer', default: 8080 },
    model: { env: 'LLM_MODEL', type: 'string', default: '' },
    systemPrompt: { env: 'LLM_SYSTEM_PROMPT', type: 'string', default: 'You are a helpful assistant. Answer in markdown format.' },
};

/**
 * Loads and manages server configuration from environment variables and a config.json file.
 */
class Config {
    /** @type {Record<string, string | number>} */
    static defaults = {
        serverPort: 3000,
        verbose: false
    };

    /** Keys, die ohne Neustart wirksam werden (Bridge liest sie dynamisch). */
    static runtimeKeys = ['verbose', 'whisper', 'llm', 'badwords', 'whisperHost', 'whisperPort', 'mcpServers'];

    /** Keys, die einen Neustart erfordern. */
    static restartKeys = ['serverPort'];

    constructor(env = process.env, logger) {
        this.env = env;
        this.configPath = this.resolvePath();
        this.label = '[Config]';
        this.logger = logger || { log: () => { }, error: () => { } };

        const loaded = existsSync(this.configPath) ? this.readConfigFile() : null;

        this.serverPort = parseInt(env.SERVER_PORT, 10) || loaded?.serverPort || Config.defaults.serverPort;
        this.verbose = env.VERBOSE === 'true' || loaded?.verbose || Config.defaults.verbose;

        // Whisper-Service (linuxserver/faster-whisper) spricht das Wyoming-Protokoll
        // (TCP), kein HTTP. Default zeigt auf den Container im Docker-Netzwerk.
        this.whisperHost = env.WHISPER_HOST || loaded?.whisperHost || 'vui-service';
        this.whisperPort = parseInt(env.WHISPER_PORT, 10) || loaded?.whisperPort || 10300;

        // Transkriptionsparameter: env > config.json > Default
        this.whisper = this.resolveWhisperParams(loaded);

        // LLM-Chat-Parameter: env > config.json > Default
        this.llm = this.resolveLlmParams(loaded);

        // Badword-Liste (serverseitig aus dem Transkript gefiltert)
        this.badwords = this.resolveBadwords(loaded);

        // MCP-Server (beliebig viele, HTTP/SSE). Default: keine.
        this.mcpServers = this.resolveMcpServers(loaded);
    }

    /**
     * Resolves the path to the configuration file.
     * @returns {string}
     */
    resolvePath() {
        return this.env.CONFIG_PATH || join(__dirname, '..', 'config.json');
    }

    /**
     * Liest die config.json (defensive: fehlerhafte Datei → null).
     * @returns {Record<string, unknown> | null}
     */
    readConfigFile() {
        try {
            return JSON.parse(readFileSync(this.configPath, 'utf8'));
        } catch (err) {
            this.logger.error(this.label, 'config.json konnte nicht gelesen werden', { error: err.message });
            return null;
        }
    }

    /**
     * Parst einen Env-Wert gemäß Typ. Liefert undefined, wenn der Wert leer/ungültig ist.
     * @param {unknown} raw
     * @param {string} type
     * @returns {unknown}
     */
    parseEnvValue(raw, type) {
        if (raw === undefined || raw === null || raw === '') return undefined;
        switch (type) {
            case 'boolean':
                return raw === 'true' || raw === '1';
            case 'integer': {
                const n = parseInt(raw, 10);
                return Number.isNaN(n) ? undefined : n;
            }
            case 'number': {
                const n = parseFloat(raw);
                return Number.isNaN(n) ? undefined : n;
            }
            case 'array': {
                try {
                    const parsed = JSON.parse(raw);
                    return Array.isArray(parsed) ? parsed : undefined;
                } catch {
                    // Komma-getrennt → Strings (z. B. Badwords)
                    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
                }
            }
            case 'object': {
                try {
                    const parsed = JSON.parse(raw);
                    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
                } catch {
                    return undefined;
                }
            }
            default:
                return String(raw);
        }
    }

    /**
     * Ermittelt die Transkriptionsparameter: env > config.json > Default.
     * @param {Record<string, unknown> | null} loaded
     * @returns {Record<string, unknown>}
     */
    resolveWhisperParams(loaded) {
        const params = {};
        for (const [key, spec] of Object.entries(WHISPER_PARAMS)) {
            const fromEnv = this.parseEnvValue(this.env[spec.env], spec.type);
            const fromFile = loaded?.whisper?.[key];
            let value =
                fromEnv !== undefined ? fromEnv
                    : fromFile !== undefined ? fromFile
                        : spec.default;

            // temperature ist ein Zahlen-Array (Env/JSON können Strings liefern)
            if (key === 'temperature' && Array.isArray(value)) {
                value = value
                    .map((n) => (typeof n === 'number' ? n : parseFloat(n)))
                    .filter((n) => Number.isFinite(n));
            }

            params[key] = value;
        }
        return params;
    }

    /**
     * Ermittelt die LLM-Parameter: env > config.json > Default.
     * @param {Record<string, unknown> | null} loaded
     * @returns {Record<string, unknown>}
     */
    resolveLlmParams(loaded) {
        const params = {};
        for (const [key, spec] of Object.entries(LLM_PARAMS)) {
            const fromEnv = this.parseEnvValue(this.env[spec.env], spec.type);
            const fromFile = loaded?.llm?.[key];
            params[key] =
                fromEnv !== undefined ? fromEnv
                    : fromFile !== undefined ? fromFile
                        : spec.default;
        }
        return params;
    }

    /**
     * Ermittelt die Badword-Liste: env > config.json > [].
     * @param {Record<string, unknown> | null} loaded
     * @returns {string[]}
     */
    resolveBadwords(loaded) {
        const fromEnv = this.parseEnvValue(this.env.WHISPER_BADWORDS, 'array');
        if (Array.isArray(fromEnv)) return fromEnv.map((w) => String(w)).filter(Boolean);
        const fromFile = loaded?.badwords;
        if (Array.isArray(fromFile)) return fromFile.map((w) => String(w)).filter(Boolean);
        return [];
    }

    /**
     * Ermittelt die MCP-Server-Liste: config.json > []. @returns {Array<object>}
     */
    resolveMcpServers(loaded) {
        const fromFile = loaded?.mcpServers;
        if (Array.isArray(fromFile)) return fromFile;
        return [];
    }

    /**
     * Schreibt die Default-Konfiguration explizit (Setup-Schritt, z. B. --init-config).
     */
    saveDefaults() {
        const defaults = {
            serverPort: parseInt(this.env.SERVER_PORT, 10) || Config.defaults.serverPort,
            verbose: this.env.VERBOSE === 'true' || Config.defaults.verbose,
            whisperHost: this.env.WHISPER_HOST || 'vui-service',
            whisperPort: parseInt(this.env.WHISPER_PORT, 10) || 10300,
            whisper: Object.fromEntries(
                Object.entries(WHISPER_PARAMS).map(([key, spec]) => [key, spec.default])
            ),
            llm: Object.fromEntries(
                Object.entries(LLM_PARAMS).map(([key, spec]) => [key, spec.default])
            ),
            badwords: [],
            mcpServers: []
        };
        writeFileSync(this.configPath, JSON.stringify(defaults, null, 4), 'utf8');
    }

    /**
     * Liefert die aktuellen Settings für die UI.
     * @returns {Record<string, unknown>}
     */
    getSettings() {
        return {
            serverPort: this.serverPort,
            verbose: this.verbose,
            whisperHost: this.whisperHost,
            whisperPort: this.whisperPort,
            whisper: { ...this.whisper },
            llm: { ...this.llm },
            badwords: [...this.badwords],
            mcpServers: [...this.mcpServers]
        };
    }

    /**
     * Validiert ein vollständiges Settings-Objekt.
     * @param {Record<string, unknown>} s
     * @returns {string[]} Fehlerliste (leer = gültig)
     */
    validateSettings(s) {
        const errors = [];
        if (!Number.isInteger(s.serverPort) || s.serverPort < 1 || s.serverPort > 65535)
            errors.push('serverPort muss eine Ganzzahl zwischen 1 und 65535 sein');
        if (typeof s.verbose !== 'boolean')
            errors.push('verbose muss ein Boolean sein');

        if (typeof s.whisperHost !== 'string' || s.whisperHost.trim() === '')
            errors.push('whisperHost muss ein nicht-leerer String sein');
        if (!Number.isInteger(s.whisperPort) || s.whisperPort < 1 || s.whisperPort > 65535)
            errors.push('whisperPort muss eine Ganzzahl zwischen 1 und 65535 sein');

        const w = s.whisper || {};
        for (const [key, spec] of Object.entries(WHISPER_PARAMS)) {
            const value = w[key];
            const err = this.validateWhisperParam(key, spec, value);
            if (err) errors.push(err);
        }

        const l = s.llm || {};
        for (const [key, spec] of Object.entries(LLM_PARAMS)) {
            const value = l[key];
            const err = this.validateLlmParam(key, spec, value);
            if (err) errors.push(err);
        }

        if (!Array.isArray(s.badwords) || s.badwords.some((b) => typeof b !== 'string'))
            errors.push('badwords muss ein Array aus Strings sein');

        errors.push(...this.validateMcpServers(s.mcpServers || []));

        return errors;
    }

    /**
     * Validiert einen einzelnen Whisper-Parameter.
     * @param {string} key
     * @param {{type: string}} spec
     * @param {unknown} value
     * @returns {string | null}
     */
    validateWhisperParam(key, spec, value) {
        const label = key;
        switch (spec.type) {
            case 'string':
                if (typeof value !== 'string') return `${label} muss ein String sein`;
                break;
            case 'boolean':
                if (typeof value !== 'boolean') return `${label} muss ein Boolean sein`;
                break;
            case 'integer': {
                if (value === '') break; // leer → Standardwert
                const min = spec.min ?? 1;
                if (!Number.isInteger(value) || value < min) return `${label} muss eine Ganzzahl >= ${min} sein`;
                break;
            }
            case 'number':
                if (value === '') break; // leer → Standardwert
                if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} muss eine Zahl sein`;
                break;
            case 'array':
                if (value === '' || (Array.isArray(value) && value.length === 0)) break; // leer → Standardwert
                if (!Array.isArray(value) || value.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
                    return `${label} muss ein Array aus Zahlen sein`;
                break;
            case 'object':
                if (value === null || typeof value !== 'object' || Array.isArray(value))
                    return `${label} muss ein Objekt sein`;
                for (const k of Object.keys(value)) {
                    if (!VAD_PARAM_KEYS.includes(k)) return `${label}.${k} ist kein gültiger VAD-Parameter`;
                }
                break;
        }
        return null;
    }

    /**
     * Validiert einen einzelnen LLM-Parameter.
     * @param {string} key
     * @param {{type: string}} spec
     * @param {unknown} value
     * @returns {string | null}
     */
    validateLlmParam(key, spec, value) {
        const label = key;
        switch (spec.type) {
            case 'string':
                if (typeof value !== 'string') return `${label} muss ein String sein`;
                if (key === 'api' && !['openai', 'ollama'].includes(value))
                    return `${label} muss 'openai' oder 'ollama' sein`;
                break;
            case 'integer': {
                if (value === '') break; // leer → Standardwert
                if (!Number.isInteger(value) || value < 1 || value > 65535)
                    return `${label} muss eine Ganzzahl zwischen 1 und 65535 sein`;
                break;
            }
        }
        return null;
    }

    /**
     * Validiert eine MCP-Server-Liste. @returns {string[]} Fehlerliste
     */
    validateMcpServers(list) {
        const errors = [];
        if (!Array.isArray(list)) {
            errors.push('mcpServers muss ein Array sein');
            return errors;
        }
        const seen = new Set();
        for (const [i, s] of list.entries()) {
            const label = `mcpServers[${i}]`;
            if (typeof s !== 'object' || s === null) { errors.push(`${label} muss ein Objekt sein`); continue; }
            if (typeof s.id !== 'string' || s.id.trim() === '') errors.push(`${label}.id muss ein nicht-leerer String sein`);
            if (typeof s.name !== 'string' || s.name.trim() === '') errors.push(`${label}.name muss ein nicht-leerer String sein`);
            if (typeof s.url !== 'string' || s.url.trim() === '') {
                errors.push(`${label}.url muss ein nicht-leerer String sein`);
            } else {
                try { new URL(s.url); } catch { errors.push(`${label}.url muss eine gültige URL sein`); }
            }
            if (s.headers !== undefined && (typeof s.headers !== 'object' || s.headers === null || Array.isArray(s.headers)
                || Object.values(s.headers).some((v) => typeof v !== 'string')))
                errors.push(`${label}.headers muss ein Objekt aus Strings sein`);
            if (s.transport !== undefined && !['auto', 'streamable-http', 'sse'].includes(s.transport))
                errors.push(`${label}.transport muss 'auto', 'streamable-http' oder 'sse' sein`);
            if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errors.push(`${label}.enabled muss ein Boolean sein`);
            if (s.id) {
                if (seen.has(s.id)) errors.push(`${label}.id '${s.id}' ist doppelt`);
                seen.add(s.id);
            }
        }
        return errors;
    }

    /**
     * Erzeugt einen eindeutigen Slug aus einem Namen.
     * @param {string} name
     * @param {Set<string>} existing
     * @returns {string}
     */
    slugify(name, existing = new Set()) {
        const base = String(name).toLowerCase().trim()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
        let id = base; let n = 2;
        while (existing.has(id)) { id = `${base}-${n}`; n++; }
        return id;
    }

    /**
     * Wendet einen Partial-Patch an: validieren → mergen → persistieren → klassifizieren.
     * @param {Record<string, unknown>} patch
     * @returns {{ applied: string[], restartRequired: string[] }}
     */
    updateSettings(patch) {
        const current = this.getSettings();

        // Deep-Merge für die verschachtelten Objekte (whisper, llm, vadParameters)
        const next = {
            ...current,
            ...patch,
            whisper: { ...current.whisper, ...(patch.whisper || {}) },
            llm: { ...current.llm, ...(patch.llm || {}) },
            badwords: patch.badwords !== undefined ? patch.badwords : current.badwords,
            mcpServers: patch.mcpServers !== undefined ? patch.mcpServers : current.mcpServers
        };

        const errors = this.validateSettings(next);
        if (errors.length > 0) {
            const err = new Error(errors.join('; '));
            err.status = 400;
            err.code = 'invalid_settings';
            throw err;
        }

        // Runtime-State aktualisieren
        this.serverPort = next.serverPort;
        this.verbose = next.verbose;
        this.whisperHost = next.whisperHost;
        this.whisperPort = next.whisperPort;
        this.whisper = { ...next.whisper };
        this.llm = { ...next.llm };
        this.badwords = next.badwords.map((w) => String(w)).filter(Boolean);
        this.mcpServers = (next.mcpServers || []).map((s) => ({ ...s }));

        // Persistieren (config.json)
        this.persist();

        const changed = Object.keys(patch).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
        return {
            applied: changed.filter((k) => Config.runtimeKeys.includes(k)),
            restartRequired: changed.filter((k) => Config.restartKeys.includes(k))
        };
    }

    /** Schreibt die aktuellen Settings nach config.json. */
    persist() {
        writeFileSync(
            this.configPath,
            JSON.stringify(
                {
                    serverPort: this.serverPort,
                    verbose: this.verbose,
                    whisperHost: this.whisperHost,
                    whisperPort: this.whisperPort,
                    whisper: this.whisper,
                    llm: this.llm,
                    badwords: this.badwords,
                    mcpServers: this.mcpServers
                },
                null,
                4
            ),
            'utf8'
        );
    }
}

export { Config, WHISPER_PARAMS, LLM_PARAMS, VAD_PARAM_KEYS };
