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

describe('Config – MCP-Server-Support', () => {
    let dir, configPath, config;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'vui-config-mcp-'));
        configPath = join(dir, 'config.json');
        config = makeConfig(configPath);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('validateMcpServers() akzeptiert eine gültige Liste (keine Fehler)', () => {
        const list = [
            { id: 'weather', name: 'Weather', url: 'http://localhost:8080/mcp', headers: { Authorization: 'Bearer x' }, transport: 'auto', enabled: true },
            { id: 'news', name: 'News', url: 'http://localhost:8081/mcp' },
        ];
        expect(config.validateMcpServers(list)).toEqual([]);
    });

    it('validateMcpServers() lehnt einen leeren url ab', () => {
        const list = [{ id: 'weather', name: 'Weather', url: '' }];
        const errors = config.validateMcpServers(list);
        expect(errors.some((e) => e.includes('url'))).toBe(true);
    });

    it('validateMcpServers() lehnt eine ungültige URL ab', () => {
        const list = [{ id: 'weather', name: 'Weather', url: 'not a url' }];
        const errors = config.validateMcpServers(list);
        expect(errors.some((e) => e.includes('url'))).toBe(true);
    });

    it('validateMcpServers() lehnt eine doppelte id ab', () => {
        const list = [
            { id: 'weather', name: 'Weather', url: 'http://localhost:8080/mcp' },
            { id: 'weather', name: 'Weather2', url: 'http://localhost:8081/mcp' },
        ];
        const errors = config.validateMcpServers(list);
        expect(errors.some((e) => e.includes('doppelt'))).toBe(true);
    });

    it('validateMcpServers() lehnt falsche headers (nicht-String-Werte) ab', () => {
        const list = [{ id: 'weather', name: 'Weather', url: 'http://localhost:8080/mcp', headers: { Authorization: 123 } }];
        const errors = config.validateMcpServers(list);
        expect(errors.some((e) => e.includes('headers'))).toBe(true);
    });

    it('validateMcpServers() lehnt ein nicht-Array ab', () => {
        const errors = config.validateMcpServers('nope');
        expect(errors.some((e) => e.includes('Array'))).toBe(true);
    });

    it('updateSettings({ mcpServers }) ersetzt das Array (kein Merge)', () => {
        config.updateSettings({ mcpServers: [
            { id: 'a', name: 'A', url: 'http://localhost:1/mcp' },
            { id: 'b', name: 'B', url: 'http://localhost:2/mcp' },
        ] });
        expect(config.mcpServers).toHaveLength(2);

        config.updateSettings({ mcpServers: [
            { id: 'c', name: 'C', url: 'http://localhost:3/mcp' },
        ] });
        expect(config.mcpServers).toHaveLength(1);
        expect(config.mcpServers[0].id).toBe('c');
    });

    it('updateSettings({ mcpServers }) persistiert in config.json', () => {
        config.updateSettings({ mcpServers: [
            { id: 'weather', name: 'Weather', url: 'http://localhost:8080/mcp' },
        ] });
        const saved = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(saved.mcpServers).toHaveLength(1);
        expect(saved.mcpServers[0].id).toBe('weather');
    });

    it('getSettings() enthält mcpServers', () => {
        const s = config.getSettings();
        expect(Array.isArray(s.mcpServers)).toBe(true);
        expect(s.mcpServers).toEqual([]);
    });

    it('slugify() erzeugt -2, -3 bei Kollisionen', () => {
        expect(config.slugify('Weather', new Set())).toBe('weather');
        expect(config.slugify('Weather', new Set(['weather']))).toBe('weather-2');
        expect(config.slugify('Weather', new Set(['weather', 'weather-2']))).toBe('weather-3');
    });

    it('slugify() normalisiert Namen (Groß-/Kleinbuchstaben, Sonderzeichen)', () => {
        expect(config.slugify('  My Weather Server! ', new Set())).toBe('my-weather-server');
    });
});
