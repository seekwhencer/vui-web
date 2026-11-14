import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, MEDIA_PARAMS } from '../src/Config.js';

const silent = { log: () => { }, error: () => { } };

/**
 * Config mit isolierter config.json (CONFIG_PATH), damit Tests die echte
 * server/config.json nicht anfassen.
 */
function makeConfig(configPath) {
    return new Config({ CONFIG_PATH: configPath }, silent);
}

describe('Config – media-Block', () => {
    let dir, configPath, config;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'vui-config-media-'));
        configPath = join(dir, 'config.json');
        config = makeConfig(configPath);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('Defaults', () => {
        it('exponiert die Media-Defaults', () => {
            const s = config.getSettings();
            expect(s.media.dir).toBe('');
            expect(s.media.imageTtlDays).toBe(30);
            expect(s.media.maxImages).toBe(500);
            expect(s.media.maxBytes).toBe(524288000);
            expect(s.media.cleanupIntervalMs).toBe(3600000);
        });

        it('media ist ein runtimeKey (kein Neustart nötig)', () => {
            expect(Config.runtimeKeys).toContain('media');
            expect(Config.restartKeys).not.toContain('media');
        });

        it('MEDIA_PARAMS ist exportiert', () => {
            expect(Object.keys(MEDIA_PARAMS)).toEqual(['dir', 'imageTtlDays', 'maxImages', 'maxBytes', 'cleanupIntervalMs']);
        });
    });

    describe('Validierung', () => {
        it('akzeptiert einen gültigen media-Patch', () => {
            const result = config.updateSettings({
                media: { dir: '/tmp/media', imageTtlDays: 7, maxImages: 100, maxBytes: 1048576, cleanupIntervalMs: 120000 }
            });

            expect(result.applied).toContain('media');
            expect(config.media.dir).toBe('/tmp/media');
            expect(config.media.imageTtlDays).toBe(7);
            expect(config.media.maxImages).toBe(100);
            expect(config.media.maxBytes).toBe(1048576);
            expect(config.media.cleanupIntervalMs).toBe(120000);
        });

        it('akzeptiert 0 für TTL/Caps (ewig/unbegrenzt)', () => {
            config.updateSettings({ media: { imageTtlDays: 0, maxImages: 0, maxBytes: 0 } });
            expect(config.media.imageTtlDays).toBe(0);
            expect(config.media.maxImages).toBe(0);
            expect(config.media.maxBytes).toBe(0);
        });

        it('lehnt falsche Typen und zu kleine Werte ab', () => {
            expect(() => config.updateSettings({ media: { dir: 123 } })).toThrow();
            expect(() => config.updateSettings({ media: { imageTtlDays: 'abc' } })).toThrow();
            expect(() => config.updateSettings({ media: { imageTtlDays: 1.5 } })).toThrow();
            expect(() => config.updateSettings({ media: { maxImages: -1 } })).toThrow();
            expect(() => config.updateSettings({ media: { cleanupIntervalMs: 1000 } })).toThrow();
        });

        it('validateMediaParams() liefert eine Fehlerliste', () => {
            expect(config.validateMediaParams({
                dir: '', imageTtlDays: 30, maxImages: 500, maxBytes: 524288000, cleanupIntervalMs: 3600000
            })).toEqual([]);

            const errors = config.validateMediaParams({ dir: 1, imageTtlDays: -5 });
            expect(errors.some((e) => e.includes('media.dir'))).toBe(true);
            expect(errors.some((e) => e.includes('media.imageTtlDays'))).toBe(true);
        });
    });

    describe('Runtime-Update', () => {
        it('aktualisiert media-Werte zur Runtime (kein Neustart)', () => {
            const result = config.updateSettings({ media: { imageTtlDays: 14, maxBytes: 209715200 } });

            // Runtime-State aktualisiert
            expect(config.media.imageTtlDays).toBe(14);
            expect(config.media.maxBytes).toBe(209715200);

            // Als "applied" klassifiziert, kein Neustart nötig
            expect(result.applied).toContain('media');
            expect(result.restartRequired).not.toContain('media');

            // getSettings spiegelt die neuen Werte
            const s = config.getSettings();
            expect(s.media.imageTtlDays).toBe(14);
            expect(s.media.maxBytes).toBe(209715200);

            // Persistiert in config.json
            const saved = JSON.parse(readFileSync(configPath, 'utf8'));
            expect(saved.media.imageTtlDays).toBe(14);
            expect(saved.media.maxBytes).toBe(209715200);
        });

        it('beibehält nicht gepatchte media-Werte (Partial-Merge)', () => {
            config.updateSettings({ media: { imageTtlDays: 7 } });

            expect(config.media.imageTtlDays).toBe(7);
            expect(config.media.dir).toBe('');
            expect(config.media.maxImages).toBe(500);
            expect(config.media.maxBytes).toBe(524288000);
            expect(config.media.cleanupIntervalMs).toBe(3600000);
        });
    });

    describe('saveDefaults()', () => {
        it('schreibt den media-Block mit Defaults', () => {
            config.saveDefaults();
            const saved = JSON.parse(readFileSync(configPath, 'utf8'));
            expect(saved.media).toEqual({
                dir: '',
                imageTtlDays: 30,
                maxImages: 500,
                maxBytes: 524288000,
                cleanupIntervalMs: 3600000
            });
        });
    });
});
