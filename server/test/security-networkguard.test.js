import { describe, it, expect } from 'vitest';
import { assertSafeUrl } from '../src/Security/NetworkGuard.js';

/** Mock-DNS: löst auf eine öffentliche IP auf (deterministisch, offline). */
const publicLookup = async () => ['93.184.216.34'];
/** Mock-DNS: löst auf eine private IP auf (simuliert DNS-Rebinding). */
const privateLookup = async () => ['10.0.0.5'];

describe('NetworkGuard.assertSafeUrl', () => {
    describe('blockiert private/interne Ziele (IP-Literal)', () => {
        it('blockiert Loopback (127.0.0.1)', async () => {
            const result = await assertSafeUrl('http://127.0.0.1/...');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('loopback');
        });

        it('blockiert Link-Local / Cloud-Metadaten (169.254.169.254)', async () => {
            const result = await assertSafeUrl('http://169.254.169.254/latest/meta-data/');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('link-local');
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

        it('blockiert Private (172.16.0.1)', async () => {
            const result = await assertSafeUrl('http://172.16.0.1/...');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('private');
        });

        it('blockiert Unspecified (0.0.0.0)', async () => {
            const result = await assertSafeUrl('http://0.0.0.0/...');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('unspecified');
        });

        it('blockiert IPv6-Loopback ([::1])', async () => {
            const result = await assertSafeUrl('http://[::1]/...');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('loopback');
        });
    });

    describe('erlaubt öffentliche Ziele', () => {
        it('erlaubt example.com (öffentliche IP via Mock-DNS)', async () => {
            const result = await assertSafeUrl('http://example.com/...', { lookup: publicLookup });
            expect(result.ok).toBe(true);
        });
    });

    describe('DNS-Rebinding', () => {
        it('blockiert Domain, die auf private IP auflöst (10.0.0.5)', async () => {
            const result = await assertSafeUrl('http://example.com/...', { lookup: privateLookup });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('private');
        });

        it('blockiert, wenn JEDER aufgelöste IP geprüft wird (eine private reicht)', async () => {
            const mixedLookup = async () => ['93.184.216.34', '192.168.0.9'];
            const result = await assertSafeUrl('http://example.com/...', { lookup: mixedLookup });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('private');
        });
    });

    describe('Protokoll', () => {
        it('blockiert nicht-http(s)-Protokolle (file://)', async () => {
            const result = await assertSafeUrl('file:///etc/passwd');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('protocol-not-allowed');
        });

        it('blockiert ftp://', async () => {
            const result = await assertSafeUrl('ftp://example.com/file');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('protocol-not-allowed');
        });
    });

    describe('Port-Whitelist', () => {
        it('blockiert http://example.com:80 bei allowedPorts [443]', async () => {
            const result = await assertSafeUrl('http://example.com:80/...', {
                lookup: publicLookup,
                allowedPorts: [443],
            });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('port-not-allowed');
        });

        it('erlaubt https://example.com (Default-Port 443) bei allowedPorts [443]', async () => {
            const result = await assertSafeUrl('https://example.com/...', {
                lookup: publicLookup,
                allowedPorts: [443],
            });
            expect(result.ok).toBe(true);
        });

        it('erlaubt explizit erlaubten Port (allowedPorts [8080] mit :8080)', async () => {
            const result = await assertSafeUrl('http://example.com:8080/...', {
                lookup: publicLookup,
                allowedPorts: [8080],
            });
            expect(result.ok).toBe(true);
        });
    });

    describe('Host-Whitelist (allowedHosts)', () => {
        it('erlaubt einen explizit erlaubten Host, der auf private IP auflöst', async () => {
            const result = await assertSafeUrl('http://sync.gitea.home/mcp', {
                lookup: privateLookup,
                allowedHosts: ['sync.gitea.home'],
            });
            expect(result.ok).toBe(true);
        });

        it('erlaubt einen explizit erlaubten IP-Literal-Host (127.0.0.1)', async () => {
            const result = await assertSafeUrl('http://127.0.0.1:8080/mcp', {
                allowedHosts: ['127.0.0.1'],
            });
            expect(result.ok).toBe(true);
        });

        it('ist case-insensitiv und trimmt Einträge', async () => {
            const result = await assertSafeUrl('http://Sync.Gitea.Home/mcp', {
                lookup: privateLookup,
                allowedHosts: ['  sync.gitea.home  '],
            });
            expect(result.ok).toBe(true);
        });

        it('blockiert weiterhin Hosts, die NICHT in der Whitelist stehen', async () => {
            const result = await assertSafeUrl('http://other.lan/mcp', {
                lookup: privateLookup,
                allowedHosts: ['sync.gitea.home'],
            });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('private');
        });

        it('blockiert weiterhin ohne Whitelist (fail closed)', async () => {
            const result = await assertSafeUrl('http://sync.gitea.home/mcp', {
                lookup: privateLookup,
            });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('private');
        });

        it('blockiert nicht-http(s)-Protokolle auch für erlaubte Hosts', async () => {
            const result = await assertSafeUrl('file:///etc/passwd', {
                allowedHosts: ['example.com'],
            });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('protocol-not-allowed');
        });
    });

    describe('zusätzliche Edge-Cases', () => {
        it('blockiert ungültige URLs', async () => {
            const result = await assertSafeUrl('not a url');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('invalid-url');
        });

        it('blockiert IPv4-mapped IPv6-Loopback ([::ffff:127.0.0.1])', async () => {
            const result = await assertSafeUrl('http://[::ffff:127.0.0.1]/...');
            expect(result.ok).toBe(false);
        });

        it('blockiert, wenn die DNS-Auflösung fehlschlägt (fail closed)', async () => {
            const failingLookup = async () => { throw new Error('ENOTFOUND'); };
            const result = await assertSafeUrl('http://example.com/...', { lookup: failingLookup });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('dns-resolution-failed');
        });

        it('blockiert, wenn die DNS-Auflösung keine Adressen liefert', async () => {
            const emptyLookup = async () => [];
            const result = await assertSafeUrl('http://example.com/...', { lookup: emptyLookup });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('dns-resolution-failed');
        });
    });
});
