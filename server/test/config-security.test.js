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

describe('Config – security-Block', () => {
    let dir, configPath, config;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'vui-config-security-'));
        configPath = join(dir, 'config.json');
        config = makeConfig(configPath);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('Defaults', () => {
        it('exponiert die Security-Defaults', () => {
            const s = config.getSettings();
            expect(s.security.maxToolTurns).toBe(10);
            expect(s.security.maxToolResultBytes).toBe(65536);
            expect(s.security.toolTimeoutMs).toBe(30000);
            expect(s.security.maxPendingActions).toBe(20);
            expect(s.security.approvalTtlMs).toBe(600000);
            expect(s.security.systemPrompt).toBe('');
            expect(s.security.toolPolicies).toEqual({});
            expect(s.security.allowedHosts).toEqual([]);
        });

        it('security ist ein runtimeKey (kein Neustart nötig)', () => {
            expect(Config.runtimeKeys).toContain('security');
            expect(Config.restartKeys).not.toContain('security');
        });
    });

    describe('Validierung', () => {
        it('akzeptiert einen gültigen security-Patch', () => {
            const result = config.updateSettings({
                security: {
                    maxToolTurns: 5,
                    toolPolicies: { 'weather__get_forecast': 'read' }
                }
            });

            expect(result.applied).toContain('security');
            expect(config.security.maxToolTurns).toBe(5);
            expect(config.security.toolPolicies).toEqual({ 'weather__get_forecast': 'read' });
        });

        it('akzeptiert alle vier Tool-Klassen in toolPolicies', () => {
            config.updateSettings({
                security: {
                    toolPolicies: {
                        'a__read': 'read',
                        'b__write': 'write',
                        'c__exec': 'execute',
                        'd__deny': 'deny'
                    }
                }
            });
            expect(config.security.toolPolicies).toEqual({
                'a__read': 'read',
                'b__write': 'write',
                'c__exec': 'execute',
                'd__deny': 'deny'
            });
        });

        it('lehnt ungültige toolPolicies-Werte ab', () => {
            expect(() => config.updateSettings({
                security: { toolPolicies: { 'weather__get_forecast': 'superuser' } }
            })).toThrow();
        });

        it('lehnt falsche Typen ab', () => {
            expect(() => config.updateSettings({ security: { maxToolTurns: 'abc' } })).toThrow();
            expect(() => config.updateSettings({ security: { maxToolTurns: 1.5 } })).toThrow();
            expect(() => config.updateSettings({ security: { maxToolTurns: 0 } })).toThrow();
            expect(() => config.updateSettings({ security: { systemPrompt: 123 } })).toThrow();
            expect(() => config.updateSettings({ security: { toolPolicies: 'read' } })).toThrow();
            expect(() => config.updateSettings({ security: { toolPolicies: ['read'] } })).toThrow();
            expect(() => config.updateSettings({ security: { toolPolicies: null } })).toThrow();
        });

        it('akzeptiert allowedHosts als Array aus Strings', () => {
            config.updateSettings({
                security: { allowedHosts: ['sync.gitea.home', 'chrome.mcp.ai.home'] }
            });
            expect(config.security.allowedHosts).toEqual(['sync.gitea.home', 'chrome.mcp.ai.home']);
        });

        it('akzeptiert allowedHosts als leeres Array', () => {
            config.updateSettings({ security: { allowedHosts: [] } });
            expect(config.security.allowedHosts).toEqual([]);
        });

        it('lehnt ungültige allowedHosts-Werte ab', () => {
            expect(() => config.updateSettings({ security: { allowedHosts: 'host' } })).toThrow();
            expect(() => config.updateSettings({ security: { allowedHosts: null } })).toThrow();
            expect(() => config.updateSettings({ security: { allowedHosts: [123] } })).toThrow();
            expect(() => config.updateSettings({ security: { allowedHosts: [''] } })).toThrow();
            expect(() => config.updateSettings({ security: { allowedHosts: ['ok', '  '] } })).toThrow();
        });
    });

    describe('Runtime-Update', () => {
        it('aktualisiert security-Werte zur Runtime (kein Neustart)', () => {
            const result = config.updateSettings({ security: { maxToolTurns: 42, approvalTtlMs: 120000 } });

            // Runtime-State aktualisiert
            expect(config.security.maxToolTurns).toBe(42);
            expect(config.security.approvalTtlMs).toBe(120000);

            // Als "applied" klassifiziert, kein Neustart nötig
            expect(result.applied).toContain('security');
            expect(result.restartRequired).not.toContain('security');

            // getSettings spiegelt die neuen Werte
            const s = config.getSettings();
            expect(s.security.maxToolTurns).toBe(42);
            expect(s.security.approvalTtlMs).toBe(120000);

            // Persistiert in config.json
            const saved = JSON.parse(readFileSync(configPath, 'utf8'));
            expect(saved.security.maxToolTurns).toBe(42);
            expect(saved.security.approvalTtlMs).toBe(120000);
        });

        it('beibehält nicht gepatchte security-Werte (Partial-Merge)', () => {
            config.updateSettings({ security: { maxToolTurns: 7 } });

            expect(config.security.maxToolTurns).toBe(7);
            expect(config.security.maxToolResultBytes).toBe(65536);
            expect(config.security.toolTimeoutMs).toBe(30000);
            expect(config.security.maxPendingActions).toBe(20);
            expect(config.security.approvalTtlMs).toBe(600000);
            expect(config.security.systemPrompt).toBe('');
            expect(config.security.toolPolicies).toEqual({});
        });
    });
});
