import { describe, it, expect } from 'vitest';
import { SECURITY_PROMPT, getSecurityPrompt } from '../src/Security/SystemPrompt.js';

describe('SECURITY_PROMPT', () => {
    it('enthält den Header und alle 10 Regeln', () => {
        expect(SECURITY_PROMPT).toContain('SECURITY RULES (non-negotiable):');
        for (let i = 1; i <= 10; i++) {
            expect(SECURITY_PROMPT).toContain(`${i}. `);
        }
    });

    it('enthält die Kernregeln (UNTRUSTED DATA, AWAITING_APPROVAL)', () => {
        expect(SECURITY_PROMPT).toContain('UNTRUSTED DATA');
        expect(SECURITY_PROMPT).toContain('AWAITING_APPROVAL');
        expect(SECURITY_PROMPT).toContain('Never approve your own proposed actions.');
        expect(SECURITY_PROMPT).toContain('Never attempt to bypass policy enforcement.');
    });

    it('endet mit der Hinweiszeile zur externen Policy', () => {
        expect(SECURITY_PROMPT).toContain('The security policy is enforced outside this model.');
    });
});

describe('getSecurityPrompt', () => {
    it('liefert den Default, wenn config undefined ist', () => {
        expect(getSecurityPrompt(undefined)).toBe(SECURITY_PROMPT);
    });

    it('liefert den Default, wenn config leer ist', () => {
        expect(getSecurityPrompt({})).toBe(SECURITY_PROMPT);
    });

    it('liefert den Default, wenn config.security fehlt', () => {
        expect(getSecurityPrompt({ llm: { systemPrompt: 'SYS' } })).toBe(SECURITY_PROMPT);
    });

    it('liefert den Default, wenn systemPrompt leer ist', () => {
        expect(getSecurityPrompt({ security: { systemPrompt: '' } })).toBe(SECURITY_PROMPT);
    });

    it('liefert den Default, wenn systemPrompt nur Leerzeichen ist', () => {
        expect(getSecurityPrompt({ security: { systemPrompt: '   ' } })).toBe(SECURITY_PROMPT);
    });

    it('liefert den Default, wenn systemPrompt kein String ist', () => {
        expect(getSecurityPrompt({ security: { systemPrompt: 123 } })).toBe(SECURITY_PROMPT);
        expect(getSecurityPrompt({ security: { systemPrompt: null } })).toBe(SECURITY_PROMPT);
    });

    it('liefert den Override, wenn config.security.systemPrompt gesetzt ist', () => {
        const override = 'CUSTOM SECURITY RULES';
        expect(getSecurityPrompt({ security: { systemPrompt: override } })).toBe(override);
    });
});
