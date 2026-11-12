import { describe, it, expect } from 'vitest';
import { assertSafeUrl } from '../src/Security/NetworkGuard.js';

/**
 * SSRF-Tests (Zero-Trust, Phase 5 — Plan §Test-Szenarien).
 *
 * Fokussierte Angriffs-Szenarien gegen NetworkGuard.assertSafeUrl.
 * DNS wird per injizierbarer options.lookup gemockt (deterministisch,
 * offline). Ergänzt security-networkguard.test.js, ohne dessen Suite zu
 * duplizieren.
 */

/** Mock-DNS: öffentliche IP (deterministisch, offline). */
const publicLookup = async () => ['93.184.216.34'];
/** Mock-DNS: Domain → private IP (DNS-Rebinding). */
const rebindingLookup = async () => ['10.0.0.5'];
/** Mock-DNS: Mix aus öffentlicher + privater IP (eine private reicht). */
const mixedLookup = async () => ['93.184.216.34', '10.0.0.5'];
/** Mock-DNS: localhost → Loopback. */
const localhostLookup = async () => ['127.0.0.1'];

describe('SSRF Protection', () => {
    it('blockiert Loopback (127.0.0.1)', async () => {
        const result = await assertSafeUrl('http://127.0.0.1/...');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('loopback');
    });

    it('blockiert localhost, wenn er auf 127.0.0.1 auflöst', async () => {
        const result = await assertSafeUrl('http://localhost/...', { lookup: localhostLookup });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('loopback');
    });

    it('blockiert Private (10.0.0.1)', async () => {
        const result = await assertSafeUrl('http://10.0.0.1/...');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('private');
    });

    it('blockiert Private (192.168.1.1)', async () => {
        const result = await assertSafeUrl('http://192.168.1.1/...');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('private');
    });

    it('blockiert Link-Local / Cloud-Metadaten (169.254.169.254)', async () => {
        const result = await assertSafeUrl('http://169.254.169.254/latest/meta-data/');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('link-local');
    });

    it('blockiert DNS-Rebinding (evil.example → private IP 10.0.0.5)', async () => {
        const result = await assertSafeUrl('http://evil.example/...', { lookup: rebindingLookup });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('private');
    });

    it('blockiert DNS-Rebinding (Mix öffentl. + private IP — eine private reicht)', async () => {
        const result = await assertSafeUrl('http://evil.example/...', { lookup: mixedLookup });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('private');
    });

    it('erlaubt öffentliche URLs (example.com → 93.184.216.34)', async () => {
        const result = await assertSafeUrl('http://example.com/...', { lookup: publicLookup });
        expect(result.ok).toBe(true);
    });

    it('blockiert nicht-http(s)-Protokolle (file:///etc/passwd)', async () => {
        const result = await assertSafeUrl('file:///etc/passwd');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('protocol-not-allowed');
    });
});
