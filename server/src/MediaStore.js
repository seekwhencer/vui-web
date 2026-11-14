import { randomUUID } from 'node:crypto';
import {
    mkdirSync, readdirSync, statSync, unlinkSync,
    writeFileSync, renameSync,
} from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
};

const EXT_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.bin': 'application/octet-stream',
};

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class MediaStore {
    constructor({ config, logger }) {
        this.config = config;
        this.logger = logger || { log: () => {}, error: () => {} };
        this.label = '[MediaStore]';
        this.baseDir = this.resolveDir();
        this.imagesDir = join(this.baseDir, 'images');
        mkdirSync(this.imagesDir, { recursive: true });
    }

    /** media.dir (env/config) > Default (server/data/media). */
    resolveDir() {
        const configured = this.config?.media?.dir;
        if (configured && typeof configured === 'string' && configured.trim() !== '') {
            return resolve(configured);
        }
        return join(__dirname, '..', 'data', 'media');
    }

    /**
     * Speichert ein Bild (Base64) auf Disk.
     * @returns {{ id: string, mimeType: string, url: string, size: number }}
     */
    save(mimeType, base64Data) {
        const ext = MIME_EXT[mimeType] || '.bin';
        const id = randomUUID();
        const filePath = join(this.imagesDir, `${id}${ext}`);
        const buffer = Buffer.from(base64Data, 'base64');
        // Atomares Write: Temp-Datei → Rename (verhindert korrupte Dateien bei Crash).
        const tmpPath = `${filePath}.tmp`;
        writeFileSync(tmpPath, buffer);
        renameSync(tmpPath, filePath);
        return { id, mimeType, url: `/api/media/${id}`, size: buffer.length };
    }

    /**
     * Lädt Metadaten für ein Bild (Path-Traversal-Guard).
     * @returns {{ filePath: string, mimeType: string, size: number } | null}
     */
    get(id) {
        if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
        let files;
        try { files = readdirSync(this.imagesDir); } catch { return null; }
        const match = files.find((f) => f.startsWith(id));
        if (!match) return null;
        const filePath = join(this.imagesDir, match);
        // Zweite Guard: aufgelöster Pfad muss innerhalb imagesDir liegen.
        if (!resolve(filePath).startsWith(resolve(this.imagesDir) + '/')) return null;
        let stat;
        try { stat = statSync(filePath); } catch { return null; } // Race: Datei weg (Cleanup) → 404 statt 500
        const mimeType = EXT_MIME[extname(match)] || 'application/octet-stream';
        return { filePath, mimeType, size: stat.size };
    }

    /** Löscht ein Bild. @returns {boolean} true wenn gelöscht. */
    delete(id) {
        const meta = this.get(id);
        if (!meta) return false;
        unlinkSync(meta.filePath);
        return true;
    }

    /**
     * Cleanup: TTL + maxImages + maxBytes (mtime-basiert, älteste zuerst).
     * @returns {{ deleted: number, freedBytes: number }}
     */
    cleanup() {
        const { imageTtlDays = 0, maxImages = 0, maxBytes = 0 } = this.config?.media || {};
        const now = Date.now();
        const ttlMs = imageTtlDays > 0 ? imageTtlDays * 86400000 : Infinity;
        let deleted = 0;
        let freedBytes = 0;

        const listFiles = () => {
            let names;
            try { names = readdirSync(this.imagesDir); } catch { return []; }
            return names
                .filter((f) => !f.endsWith('.tmp'))
                .map((f) => {
                    const filePath = join(this.imagesDir, f);
                    let stat;
                    try { stat = statSync(filePath); } catch { return null; } // Race: Datei weg → überspringen
                    return { filePath, mtime: stat.mtimeMs, size: stat.size };
                })
                .filter(Boolean)
                .sort((a, b) => a.mtime - b.mtime); // älteste zuerst
        };

        const remove = (file) => {
            try {
                unlinkSync(file.filePath);
                deleted++;
                freedBytes += file.size;
            } catch (err) {
                this.logger.error(this.label, 'Cleanup: Datei konnte nicht gelöscht werden', { file: file.filePath, error: err.message });
            }
        };

        // 1. TTL
        for (const file of listFiles()) {
            if (now - file.mtime > ttlMs) remove(file);
        }

        // 2. maxImages (Cap auf Anzahl)
        if (maxImages > 0) {
            const remaining = listFiles();
            if (remaining.length > maxImages) {
                for (const file of remaining.slice(0, remaining.length - maxImages)) remove(file);
            }
        }

        // 3. maxBytes (Cap auf Gesamtgröße)
        if (maxBytes > 0) {
            let total = 0;
            const current = listFiles();
            for (const file of current) total += file.size;
            if (total > maxBytes) {
                let excess = total - maxBytes;
                for (const file of current) {
                    if (excess <= 0) break;
                    remove(file);
                    excess -= file.size;
                }
            }
        }

        if (deleted > 0) {
            this.logger.log(this.label, `Cleanup: ${deleted} Dateien gelöscht, ${freedBytes} Bytes freigegeben`);
        }
        return { deleted, freedBytes };
    }

    /** Listet alle Bilder (für Admin-UI / Stats). */
    list() {
        let names;
        try { names = readdirSync(this.imagesDir); } catch { return []; }
        return names
            .filter((f) => !f.endsWith('.tmp'))
            .map((f) => {
                const filePath = join(this.imagesDir, f);
                let stat;
                try { stat = statSync(filePath); } catch { return null; } // Race: Datei weg → überspringen
                return {
                    id: f.replace(extname(f), ''),
                    mimeType: EXT_MIME[extname(f)] || 'application/octet-stream',
                    size: stat.size,
                    mtime: stat.mtimeMs,
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime); // neueste zuerst
    }
}
