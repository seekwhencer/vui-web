import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../src/Security/PolicyEngine.js';

describe('PolicyEngine', () => {
    const logger = { log: () => { }, error: () => { } };

    function makeConfig(policies) {
        return { security: { toolPolicies: policies } };
    }

    const basePolicies = {
        'weather__get_forecast': 'read',
        'weather__set_forecast': 'write',
        'files__read_file': 'read',
        'files__write_file': 'write',
        'shell__run_command': 'execute',
        'shell__wipe_disk': 'deny',
    };

    describe('classify', () => {
        it('liefert die konfigurierte Klasse für read/write/execute/deny', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            expect(engine.classify('weather', 'get_forecast')).toBe('read');
            expect(engine.classify('weather', 'set_forecast')).toBe('write');
            expect(engine.classify('files', 'read_file')).toBe('read');
            expect(engine.classify('files', 'write_file')).toBe('write');
            expect(engine.classify('shell', 'run_command')).toBe('execute');
            expect(engine.classify('shell', 'wipe_disk')).toBe('deny');
        });

        it('Default-Deny: unbekanntes Tool → deny', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            expect(engine.classify('weather', 'unknown_tool')).toBe('deny');
            expect(engine.classify('ghost', 'any_tool')).toBe('deny');
        });

        it('Default-Deny: leerer toolPolicies-Map → alles deny', () => {
            const engine = new PolicyEngine({ config: makeConfig({}), logger });
            expect(engine.classify('weather', 'get_forecast')).toBe('deny');
        });

        it('Default-Deny: config.security undefined → alles deny', () => {
            const engine = new PolicyEngine({ config: {}, logger });
            expect(engine.classify('weather', 'get_forecast')).toBe('deny');
        });

        it('Default-Deny: config undefined → alles deny', () => {
            const engine = new PolicyEngine({ logger });
            expect(engine.classify('weather', 'get_forecast')).toBe('deny');
        });

        it('ungültiger Klassenwert im Map → deny (deny-by-default)', () => {
            const engine = new PolicyEngine({
                config: makeConfig({ 'weather__get_forecast': 'READ', 'shell__run_command': 'hacker' }),
                logger,
            });
            expect(engine.classify('weather', 'get_forecast')).toBe('deny');
            expect(engine.classify('shell', 'run_command')).toBe('deny');
        });

        it('toolPolicies nicht-Objekt → alles deny', () => {
            const engine = new PolicyEngine({ config: { security: { toolPolicies: 'read' } }, logger });
            expect(engine.classify('weather', 'get_forecast')).toBe('deny');
        });
    });

    describe('evaluate', () => {
        it('read → allowed, keine Freigabe', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            const result = engine.evaluate('weather', 'get_forecast', { city: 'Berlin' });
            expect(result.allowed).toBe(true);
            expect(result.requiresApproval).toBe(false);
            expect(result.risk).toBe('low');
            expect(result.reason).toBeTruthy();
        });

        it('write → allowed, Freigabe erforderlich', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            const result = engine.evaluate('weather', 'set_forecast', { city: 'Berlin' });
            expect(result.allowed).toBe(true);
            expect(result.requiresApproval).toBe(true);
            expect(result.risk).toBe('medium');
            expect(result.reason).toBeTruthy();
        });

        it('execute → allowed, Freigabe erforderlich', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            const result = engine.evaluate('shell', 'run_command', { cmd: 'ls' });
            expect(result.allowed).toBe(true);
            expect(result.requiresApproval).toBe(true);
            expect(result.risk).toBe('high');
            expect(result.reason).toBeTruthy();
        });

        it('deny → nicht allowed, keine Freigabe', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            const result = engine.evaluate('shell', 'wipe_disk', {});
            expect(result.allowed).toBe(false);
            expect(result.requiresApproval).toBe(false);
            expect(result.risk).toBe('blocked');
            expect(result.reason).toContain('shell__wipe_disk');
        });

        it('unbekanntes Tool → nicht allowed (Default-Deny)', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            const result = engine.evaluate('weather', 'unknown_tool', {});
            expect(result.allowed).toBe(false);
            expect(result.requiresApproval).toBe(false);
        });

        it('config.security undefined → deny', () => {
            const engine = new PolicyEngine({ config: {}, logger });
            const result = engine.evaluate('weather', 'get_forecast', {});
            expect(result.allowed).toBe(false);
            expect(result.requiresApproval).toBe(false);
        });

        it('config undefined → deny', () => {
            const engine = new PolicyEngine({ logger });
            const result = engine.evaluate('weather', 'get_forecast', {});
            expect(result.allowed).toBe(false);
            expect(result.requiresApproval).toBe(false);
        });

        it('PolicyResult hat immer alle vier Felder', () => {
            const engine = new PolicyEngine({ config: makeConfig(basePolicies), logger });
            for (const [serverId, toolName] of [
                ['weather', 'get_forecast'],
                ['weather', 'set_forecast'],
                ['shell', 'run_command'],
                ['shell', 'wipe_disk'],
                ['ghost', 'unknown'],
            ]) {
                const result = engine.evaluate(serverId, toolName, {});
                expect(result).toHaveProperty('allowed');
                expect(result).toHaveProperty('requiresApproval');
                expect(result).toHaveProperty('risk');
                expect(result).toHaveProperty('reason');
                expect(typeof result.allowed).toBe('boolean');
                expect(typeof result.requiresApproval).toBe('boolean');
                expect(typeof result.risk).toBe('string');
                expect(typeof result.reason).toBe('string');
            }
        });
    });
});
