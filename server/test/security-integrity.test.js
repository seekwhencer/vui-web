import { describe, it, expect } from 'vitest';
import { canonicalize, createPayloadHash, safeEqualHex } from '../src/Security/Integrity.js';

describe('canonicalize', () => {
    it('ist deterministisch (gleicher Input → gleiche Ausgabe)', () => {
        const value = { b: 2, a: [1, { c: true }], d: 'x' };
        expect(canonicalize(value)).toBe(canonicalize({ b: 2, a: [1, { c: true }], d: 'x' }));
    });

    it('sortiert Keys rekursiv', () => {
        expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
        expect(canonicalize({ x: { d: 1, c: 2 } })).toBe(canonicalize({ x: { c: 2, d: 1 } }));
    });

    it('serialisiert Primitiven, Arrays und null', () => {
        expect(canonicalize(null)).toBe('null');
        expect(canonicalize('a')).toBe('"a"');
        expect(canonicalize(true)).toBe('true');
        expect(canonicalize(42)).toBe('42');
        expect(canonicalize([1, 'a', null])).toBe('[1,"a",null]');
    });

    it('wirft bei undefined', () => {
        expect(() => canonicalize(undefined)).toThrow();
        expect(() => canonicalize({ a: undefined })).toThrow();
    });

    it('wirft bei NaN und Infinity', () => {
        expect(() => canonicalize(NaN)).toThrow();
        expect(() => canonicalize(Infinity)).toThrow();
        expect(() => canonicalize(-Infinity)).toThrow();
        expect(() => canonicalize({ a: NaN })).toThrow();
    });

    it('wirft bei Map und Set', () => {
        expect(() => canonicalize(new Map([['a', 1]]))).toThrow();
        expect(() => canonicalize(new Set([1]))).toThrow();
        expect(() => canonicalize({ m: new Map() })).toThrow();
    });

    it('wirft bei Funktionen und Symbol', () => {
        expect(() => canonicalize(() => 1)).toThrow();
        expect(() => canonicalize(Symbol('x'))).toThrow();
        expect(() => canonicalize({ f: () => 1 })).toThrow();
    });

    it('wirft bei toJSON', () => {
        expect(() => canonicalize({ toJSON: () => 'x' })).toThrow();
        expect(() => canonicalize(new Date())).toThrow();
    });
});

describe('createPayloadHash', () => {
    const base = {
        userId: 'local',
        tenantId: 'local',
        toolName: 'weather__set_forecast',
        args: { city: 'Berlin', days: 3 },
    };

    it('liefert einen hex-SHA-256-Hash', () => {
        const hash = createPayloadHash(base.userId, base.tenantId, base.toolName, base.args);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ist deterministisch (gleicher Input → gleicher Hash)', () => {
        const h1 = createPayloadHash(base.userId, base.tenantId, base.toolName, base.args);
        const h2 = createPayloadHash(base.userId, base.tenantId, base.toolName, base.args);
        expect(h1).toBe(h2);
    });

    it('ist unabhängig von der Key-Reihenfolge', () => {
        const h1 = createPayloadHash(base.userId, base.tenantId, base.toolName, { city: 'Berlin', days: 3 });
        const h2 = createPayloadHash(base.userId, base.tenantId, base.toolName, { days: 3, city: 'Berlin' });
        expect(h1).toBe(h2);
    });

    it('bindet userId (Änderung → anderer Hash)', () => {
        const h1 = createPayloadHash(base.userId, base.tenantId, base.toolName, base.args);
        const h2 = createPayloadHash('other-user', base.tenantId, base.toolName, base.args);
        expect(h1).not.toBe(h2);
    });

    it('bindet tenantId (Änderung → anderer Hash)', () => {
        const h1 = createPayloadHash(base.userId, base.tenantId, base.toolName, base.args);
        const h2 = createPayloadHash(base.userId, 'other-tenant', base.toolName, base.args);
        expect(h1).not.toBe(h2);
    });

    it('bindet toolName (Änderung → anderer Hash)', () => {
        const h1 = createPayloadHash(base.userId, base.tenantId, base.toolName, base.args);
        const h2 = createPayloadHash(base.userId, base.tenantId, 'weather__get_forecast', base.args);
        expect(h1).not.toBe(h2);
    });

    it('bindet args (Änderung → anderer Hash)', () => {
        const h1 = createPayloadHash(base.userId, base.tenantId, base.toolName, base.args);
        const h2 = createPayloadHash(base.userId, base.tenantId, base.toolName, { city: 'München', days: 3 });
        expect(h1).not.toBe(h2);
    });
});

describe('safeEqualHex', () => {
    const a = 'a3f1c9d2e8b40765f1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    const b = 'a3f1c9d2e8b40765f1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    const c = 'a3f1c9d2e8b40765f1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60719';

    it('gleiche Hashes → true', () => {
        expect(safeEqualHex(a, b)).toBe(true);
    });

    it('unterschiedliche Hashes (gleiche Länge) → false', () => {
        expect(safeEqualHex(a, c)).toBe(false);
    });

    it('unterschiedliche Längen → false', () => {
        expect(safeEqualHex(a, a.slice(0, 60))).toBe(false);
        expect(safeEqualHex('ab', 'abcd')).toBe(false);
    });
});
