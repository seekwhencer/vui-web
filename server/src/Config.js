import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Loads and manages server configuration from environment variables and a config.json file.
 */
class Config {
    /** @type {Record<string, string | number>} */
    static defaults = {
        serverPort: 3000,
        verbose: false
    };

    constructor(env = process.env, logger) {
        this.env = env;
        this.configPath = this.resolvePath();
        this.label = '[Config]';
        this.logger = logger || { log: () => {}, error: () => {} };

        const loadedDefaults =
            existsSync(this.configPath)
                ? JSON.parse(readFileSync(this.configPath, 'utf8'))
                : null;

        this.defaults = loadedDefaults ?? this.buildDefaults();

        this.serverPort = parseInt(env.SERVER_PORT, 10) || this.defaults.serverPort;
        this.verbose = env.VERBOSE === 'true' || this.defaults.verbose;

        // Whisper-Service (linuxserver/faster-whisper) spricht das Wyoming-Protokoll
        // (TCP), kein HTTP. Default zeigt auf den Container im Docker-Netzwerk.
        this.whisperHost = env.WHISPER_HOST || 'vui-service';
        this.whisperPort = parseInt(env.WHISPER_PORT, 10) || 10300;
        this.whisperLang = env.WHISPER_LANG || 'de';
    }

    /**
     * Resolves the path to the configuration file.
     * @returns {string}
     */
    resolvePath() {
        return this.env.CONFIG_PATH || join(__dirname, '..', 'config.json');
    }

    /**
     * Creates a defaults object from environment variables or static default values.
     * @returns {Record<string, string | number>}
     */
    buildDefaults() {
        return {
            serverPort: parseInt(this.env.SERVER_PORT, 10) || Config.defaults.serverPort,
            verbose: this.env.VERBOSE === 'true' || Config.defaults.verbose
        };
    }

    /**
     * Writes the default configuration file explicitly.
     * Intended to be invoked by a separate setup step (e.g. CLI flag --init-config).
     */
    saveDefaults() {
        writeFileSync(
            this.configPath,
            JSON.stringify(this.buildDefaults(), null, 4),
            'utf8'
        );
    }

    /**
     * Liefert die aktuellen Settings für die UI.
     * Secrets werden maskiert — der echte Token wird nie zurückgegeben.
     * @returns {Record<string, unknown>}
     */
    getSettings() {
        return {
            serverPort: this.serverPort,
            verbose: this.verbose
        };
    }

    /**
     * Maskiert ein Secret: `••••` + letzte 4 Zeichen.
     * @param {string} value
     * @returns {string}
     */
    maskSecret(value) {
        if (!value) return '';
        return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
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
        
        return errors;
    }

    /**
     * Wendet einen Partial-Patch an: validieren → mergen → persistieren → klassifizieren.
     * @param {Record<string, unknown>} patch
     * @returns {{ applied: string[], restartRequired: string[] }}
     */
    updateSettings(patch) {
        const current = {
            serverPort: this.serverPort,
            verbose: this.verbose
        };

        const next = { ...current, ...patch };

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

        // Persistieren (config.json)
        this.persist();

        const changed = Object.keys(patch).filter((k) => current[k] !== next[k]);
        return {
            applied: changed.filter((k) => Config.runtimeKeys.includes(k)),
            restartRequired: changed.filter((k) => Config.restartKeys.includes(k))
        };
    }

    /** Schreibt die aktuellen Settings nach config.json. */
    persist() {
        writeFileSync(
            this.configPath,
            JSON.stringify({
                serverPort: this.serverPort,
                verbose: this.verbose
            }, null, 4),
            'utf8'
        );
    }
}

export { Config };
