import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/Config.js';

const silent = { log: () => { }, error: () => { } };

/**
 * Config mit isolierter config.json (CONFIG_PATH), damit Tests die echte
 * server/config.json nicht anfassen.
 */
function makeConfig(configPath) {
    return new Config({ CONFIG_PATH: configPath }, silent);
}

describe('Config.updateSettings – whisperHost/whisperPort', () => {
    let dir, configPath, config;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'vui-config-'));
        configPath = join(dir, 'config.json');
        config = makeConfig(configPath);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('wendet gültige whisperHost/whisperPort zur Runtime an (kein Neustart)', () => {
        const result = config.updateSettings({ whisperHost: 'localhost', whisperPort: 9000 });

        // Runtime-State aktualisiert
        expect(config.whisperHost).toBe('localhost');
        expect(config.whisperPort).toBe(9000);

        // Als "applied" klassifiziert, kein Neustart nötig
        expect(result.applied).toContain('whisperHost');
        expect(result.applied).toContain('whisperPort');
        expect(result.restartRequired).not.toContain('whisperHost');
        expect(result.restartRequired).not.toContain('whisperPort');

        // Persistiert in config.json
        const saved = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(saved.whisperHost).toBe('localhost');
        expect(saved.whisperPort).toBe(9000);
    });

    it('getSettings liefert whisperHost/whisperPort', () => {
        const s = config.getSettings();
        expect(typeof s.whisperHost).toBe('string');
        expect(Number.isInteger(s.whisperPort)).toBe(true);
    });

    it('lehnt ungültige whisperPort ab', () => {
        expect(() => config.updateSettings({ whisperPort: 0 })).toThrow();
        expect(() => config.updateSettings({ whisperPort: 70000 })).toThrow();
        expect(() => config.updateSettings({ whisperPort: 'abc' })).toThrow();
    });

    it('lehnt leeren whisperHost ab', () => {
        expect(() => config.updateSettings({ whisperHost: '' })).toThrow();
        expect(() => config.updateSettings({ whisperHost: '   ' })).toThrow();
    });
});
