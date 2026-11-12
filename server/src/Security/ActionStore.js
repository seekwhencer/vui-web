import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Action-Store (Phase 1: JSON-Datei, Phase 2: Postgres).
 *
 * Speichert Aktionen + Zustandsübergänge. Alle Mutationen sind atomar
 * (Write-to-Temp + Rename) und werden pro Instanz serialisiert.
 * Replay-Schutz: COMPLETED → EXECUTING ist unmöglich (transition → null).
 */
class ActionStore {
    #actions = [];
    #loaded = false;
    #mutex = Promise.resolve();

    /**
     * @param {string} filePath - z. B. server/data/actions.json
     * @param {Logger} [logger]
     */
    constructor(filePath, logger) {
        this.filePath = filePath;
        this.label = '[ActionStore]';
        this.logger = logger || { log: () => { }, error: () => { } };
    }

    /** Serialisiert eine Read-Modify-Write-Operation pro Instanz. */
    #withLock(fn) {
        const run = this.#mutex.then(fn);
        this.#mutex = run.catch(() => { });
        return run;
    }

    /** Lädt die Datei einmalig (leere Liste, wenn sie fehlt). */
    async #ensureLoaded() {
        if (this.#loaded) return;
        await mkdir(dirname(this.filePath), { recursive: true });
        let raw = null;
        try {
            raw = await readFile(this.filePath, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                this.#loaded = true;
                return;
            }
            this.logger.error(`${this.label} load: Lesen fehlgeschlagen`, { filePath: this.filePath, error: err.message });
            throw err;
        }
        if (raw.trim() === '') {
            this.#loaded = true;
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            this.logger.error(`${this.label} load: ungültiges JSON`, { filePath: this.filePath, error: err.message });
            throw err;
        }
        if (!Array.isArray(parsed)) {
            this.logger.error(`${this.label} load: erwartet Array`, { filePath: this.filePath, type: typeof parsed });
            throw new Error('ActionStore: ungültiges Dateiformat (erwartet: Array)');
        }
        this.#actions = parsed;
        this.#loaded = true;
    }

    /** Atomares Write: Temp-Datei im selben Verzeichnis + Rename. */
    async #persist() {
        const dir = dirname(this.filePath);
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
        try {
            await writeFile(tmp, `${JSON.stringify(this.#actions, null, 2)}\n`, 'utf8');
            await rename(tmp, this.filePath);
        } catch (err) {
            try { await unlink(tmp); } catch { /* Temp-Datei evtl. nie angelegt */ }
            this.logger.error(`${this.label} persist: Schreiben fehlgeschlagen`, { filePath: this.filePath, error: err.message });
            throw err;
        }
    }

    /**
     * Speichert eine neue Aktion. Setzt createdAt/updatedAt, wenn nicht vorhanden.
     * @param {object} action
     * @returns {Promise<object>} die gespeicherte Aktion
     */
    async create(action) {
        if (action === null || typeof action !== 'object' || Array.isArray(action)) {
            throw new TypeError('ActionStore.create: action muss ein Objekt sein');
        }
        return this.#withLock(async () => {
            await this.#ensureLoaded();
            const now = new Date().toISOString();
            const record = { ...action };
            if (record.id === undefined || record.id === null) record.id = randomUUID();
            if (this.#actions.some((a) => a.id === record.id)) {
                this.logger.error(`${this.label} create: doppelte id`, { id: record.id });
                throw new Error(`ActionStore: Aktion mit id ${record.id} existiert bereits`);
            }
            record.createdAt = record.createdAt ?? now;
            record.updatedAt = record.updatedAt ?? now;
            this.#actions.push(record);
            await this.#persist();
            return structuredClone(record);
        });
    }

    /**
     * @param {string} id
     * @returns {Promise<object|null>} die Aktion oder null
     */
    async get(id) {
        return this.#withLock(async () => {
            await this.#ensureLoaded();
            const found = this.#actions.find((a) => a.id === id);
            return found ? structuredClone(found) : null;
        });
    }

    /**
     * @returns {Promise<Array<object>>} alle Aktionen mit status PENDING_APPROVAL
     */
    async listPending() {
        return this.#withLock(async () => {
            await this.#ensureLoaded();
            return this.#actions
                .filter((a) => a.status === 'PENDING_APPROVAL')
                .map((a) => structuredClone(a));
        });
    }

    /**
     * Atomarer Zustandsübergang: prüft fromStatus, setzt toStatus.
     * Bei falschem Ausgangszustand → null (kein Update).
     * Das ist der Replay-Schutz: COMPLETED → EXECUTING ist unmöglich.
     * @param {string} id
     * @param {string} fromStatus
     * @param {string} toStatus
     * @param {object} [patch]
     * @returns {Promise<object|null>} die aktualisierte Aktion
     */
    async transition(id, fromStatus, toStatus, patch = {}) {
        return this.#withLock(async () => {
            await this.#ensureLoaded();
            const action = this.#actions.find((a) => a.id === id);
            if (!action || action.status !== fromStatus) {
                this.logger.log(`${this.label} transition: abgelehnt`, { id, fromStatus, toStatus, current: action ? action.status : null });
                return null;
            }
            Object.assign(action, patch);
            action.status = toStatus;
            action.updatedAt = new Date().toISOString();
            await this.#persist();
            return structuredClone(action);
        });
    }

    /**
     * @param {number} [limit=50]
     * @returns {Promise<Array<object>>} letzte N Aktionen nach updatedAt absteigend
     */
    async listRecent(limit = 50) {
        return this.#withLock(async () => {
            await this.#ensureLoaded();
            return [...this.#actions]
                .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
                .slice(0, limit)
                .map((a) => structuredClone(a));
        });
    }
}

export { ActionStore };
