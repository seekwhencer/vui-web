import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Append-only JSONL-Audit-Log.
 *
 * Jede Zeile ist ein JSON-Objekt: { ts, actionId, event, metadata }.
 * Bestehende Zeilen werden nie umgeschrieben oder gelöscht.
 */
class Audit {
    /**
     * @param {string} filePath - z. B. server/data/audit.jsonl
     * @param {Logger} [logger]
     */
    constructor(filePath, logger) {
        this.filePath = filePath;
        this.label = '[Audit]';
        this.logger = logger || { log: () => { }, error: () => { } };
    }

    /**
     * Schreibt ein Audit-Ereignis (append-only, kein Löschen/Ändern).
     * @param {string} event
     * @param {object} [metadata]
     * @param {string|null} [actionId]
     */
    async log(event, metadata = {}, actionId = null) {
        const entry = {
            ts: new Date().toISOString(),
            actionId,
            event,
            metadata,
        };
        let line;
        try {
            line = JSON.stringify(entry);
        } catch (err) {
            this.logger.error(`${this.label} log: Serialisierung fehlgeschlagen`, { event, actionId, error: err.message });
            throw err;
        }
        try {
            await mkdir(dirname(this.filePath), { recursive: true });
            await appendFile(this.filePath, `${line}\n`, 'utf8');
        } catch (err) {
            this.logger.error(`${this.label} log: Append fehlgeschlagen`, { event, actionId, error: err.message });
            throw err;
        }
    }

    /**
     * Liest die letzten N Einträge (für UI + Tests).
     * @param {number} [n=100]
     * @returns {Promise<Array<object>>} älteste → neueste
     */
    async tail(n = 100) {
        let raw;
        try {
            raw = await readFile(this.filePath, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            this.logger.error(`${this.label} tail: Lesen fehlgeschlagen`, { error: err.message });
            throw err;
        }
        const entries = [];
        for (const line of raw.split('\n')) {
            if (line.trim() === '') continue;
            try {
                entries.push(JSON.parse(line));
            } catch (err) {
                this.logger.error(`${this.label} tail: ungültige Zeile übersprungen`, { line, error: err.message });
            }
        }
        return entries.slice(-n);
    }
}

export { Audit };
