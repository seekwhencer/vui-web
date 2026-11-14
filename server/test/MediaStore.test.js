import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore } from '../src/MediaStore.js';

const silent = { log: () => { }, error: () => { } };

/**
 * MediaStore mit isoliertem Media-Verzeichnis (tmpdir), damit Tests die
 * echte server/data/media nicht anfassen.
 */
function makeStore(media = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'vui-media-'));
    const config = { media: { dir, ...media } };
    return { store: new MediaStore({ config, logger: silent }), dir, config };
}

describe('MediaStore', () => {
    let store, dir;

    beforeEach(() => {
        ({ store, dir } = makeStore());
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('save()', () => {
        it('schreibt die Datei auf Disk und liefert { id, mimeType, url, size }', () => {
            const payload = 'hello image';
            const data = Buffer.from(payload).toString('base64');
            const result = store.save('image/png', data);

            expect(result.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
            expect(result.mimeType).toBe('image/png');
            expect(result.url).toBe(`/api/media/${result.id}`);
            expect(result.size).toBe(Buffer.byteLength(payload));

            const filePath = join(dir, 'images', `${result.id}.png`);
            expect(existsSync(filePath)).toBe(true);
            expect(readFileSync(filePath).toString()).toBe(payload);
        });

        it('nutzt .bin für unbekannte Mime-Typen', () => {
            const result = store.save('application/pdf', Buffer.from('x').toString('base64'));
            expect(existsSync(join(dir, 'images', `${result.id}.bin`))).toBe(true);
        });
    });

    describe('get()', () => {
        it('liefert Metadaten für eine gespeicherte Datei', () => {
            const saved = store.save('image/png', Buffer.from('abc').toString('base64'));
            const meta = store.get(saved.id);

            expect(meta).not.toBeNull();
            expect(meta.mimeType).toBe('image/png');
            expect(meta.size).toBe(3);
            expect(meta.filePath).toBe(join(dir, 'images', `${saved.id}.png`));
        });

        it('liefert null für unbekannte UUIDs', () => {
            expect(store.get('123e4567-e89b-42d3-a456-426614174000')).toBeNull();
        });

        it('blockt Path-Traversal (ungültige IDs → null)', () => {
            expect(store.get('../config')).toBeNull();
            expect(store.get('..%2f..%2fetc%2fpasswd')).toBeNull();
            expect(store.get('not-a-uuid')).toBeNull();
            expect(store.get('123e4567-e89b-42d3-a456-426614174000.png')).toBeNull();
            expect(store.get(null)).toBeNull();
            expect(store.get(42)).toBeNull();
        });
    });

    describe('delete()', () => {
        it('löscht eine gespeicherte Datei', () => {
            const saved = store.save('image/png', Buffer.from('abc').toString('base64'));
            const filePath = join(dir, 'images', `${saved.id}.png`);

            expect(store.delete(saved.id)).toBe(true);
            expect(existsSync(filePath)).toBe(false);
        });

        it('liefert false für unbekannte/ungültige IDs', () => {
            expect(store.delete('123e4567-e89b-42d3-a456-426614174000')).toBe(false);
            expect(store.delete('../config')).toBe(false);
        });
    });

    describe('cleanup()', () => {
        it('löscht Dateien älter als die TTL (älteste zuerst)', () => {
            const a = store.save('image/png', Buffer.from('aaa').toString('base64'));
            const b = store.save('image/png', Buffer.from('bbb').toString('base64'));
            // a ist 2 Tage alt, b ist frisch
            const past = new Date(Date.now() - 2 * 86400000);
            utimesSync(join(dir, 'images', `${a.id}.png`), past, past);

            // Default (imageTtlDays=0) → keine TTL → nichts gelöscht
            expect(store.cleanup().deleted).toBe(0);

            store.config.media.imageTtlDays = 1;
            const result = store.cleanup();
            expect(result.deleted).toBe(1);
            expect(existsSync(join(dir, 'images', `${a.id}.png`))).toBe(false);
            expect(existsSync(join(dir, 'images', `${b.id}.png`))).toBe(true);
        });

        it('hält maxImages ein (älteste zuerst)', () => {
            const a = store.save('image/png', Buffer.from('aaa').toString('base64'));
            const b = store.save('image/png', Buffer.from('bbb').toString('base64'));
            const c = store.save('image/png', Buffer.from('ccc').toString('base64'));
            const past = new Date(Date.now() - 3 * 86400000);
            utimesSync(join(dir, 'images', `${a.id}.png`), past, past);
            const mid = new Date(Date.now() - 2 * 86400000);
            utimesSync(join(dir, 'images', `${b.id}.png`), mid, mid);

            store.config.media.imageTtlDays = 0; // TTL aus
            store.config.media.maxImages = 2;

            const result = store.cleanup();
            expect(result.deleted).toBe(1);
            expect(existsSync(join(dir, 'images', `${a.id}.png`))).toBe(false);
            expect(existsSync(join(dir, 'images', `${b.id}.png`))).toBe(true);
            expect(existsSync(join(dir, 'images', `${c.id}.png`))).toBe(true);
        });

        it('hält maxBytes ein (älteste zuerst)', () => {
            const a = store.save('image/png', Buffer.from('aaaa').toString('base64'));
            const b = store.save('image/png', Buffer.from('bbbb').toString('base64'));
            const past = new Date(Date.now() - 3 * 86400000);
            utimesSync(join(dir, 'images', `${a.id}.png`), past, past);

            store.config.media.imageTtlDays = 0;
            store.config.media.maxImages = 0; // Cap aus
            store.config.media.maxBytes = 4; // nur 4 Bytes erlaubt

            const result = store.cleanup();
            expect(result.deleted).toBe(1);
            expect(result.freedBytes).toBe(4);
            expect(existsSync(join(dir, 'images', `${a.id}.png`))).toBe(false);
            expect(existsSync(join(dir, 'images', `${b.id}.png`))).toBe(true);
        });

        it('meldet gelöschte Dateien und freigegebene Bytes', () => {
            const a = store.save('image/png', Buffer.from('12345').toString('base64'));
            const past = new Date(Date.now() - 2 * 86400000);
            utimesSync(join(dir, 'images', `${a.id}.png`), past, past);

            store.config.media.imageTtlDays = 1;
            const result = store.cleanup();
            expect(result.deleted).toBe(1);
            expect(result.freedBytes).toBe(5);
        });
    });

    describe('list()', () => {
        it('listet alle Bilder (neueste zuerst) mit Metadaten', () => {
            const a = store.save('image/png', Buffer.from('aaa').toString('base64'));
            const b = store.save('image/webp', Buffer.from('bbbb').toString('base64'));
            const past = new Date(Date.now() - 86400000);
            utimesSync(join(dir, 'images', `${a.id}.png`), past, past);

            const list = store.list();
            expect(list).toHaveLength(2);
            expect(list[0].id).toBe(b.id); // neueste zuerst
            expect(list[0].mimeType).toBe('image/webp');
            expect(list[0].size).toBe(4);
            expect(list[1].id).toBe(a.id);
            expect(list[1].mimeType).toBe('image/png');
            expect(list[1].size).toBe(3);
        });

        it('ignoriert verwaiste .tmp-Dateien', () => {
            store.save('image/png', Buffer.from('abc').toString('base64'));
            writeFileSync(join(dir, 'images', 'orphan.tmp'), 'x');

            const list = store.list();
            expect(list).toHaveLength(1);
            expect(list[0].id).not.toContain('.tmp');
        });
    });
});
