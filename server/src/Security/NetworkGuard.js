/**
 * Network-Guard (Zero-Trust, Phase 3).
 *
 * Prüft URLs gegen SSRF (Server-Side Request Forgery):
 * - Nur http/https-Protokolle (blockiert file:, ftp:, ...)
 * - Blockiert Loopback, Private, Link-Local (inkl. Cloud-Metadaten
 *   169.254.169.254), Unique-Local und Unspecified-Adressen
 * - Domain-Namen werden per DNS aufgelöst und JEDER aufgelöste IP
 *   geprüft (schützt vor DNS-Rebinding: Domain → private IP)
 * - Optionale Port-Whitelist
 * - Optionale Host-Whitelist (options.allowedHosts): explizit erlaubte
 *   Hostnamen sind von der IP-Prüfung ausgenommen (z. B. lokale
 *   MCP-Server im LAN). Fail closed bleibt für alle anderen Ziele.
 *
 * Die DNS-Lookup-Funktion ist injizierbar (options.lookup), damit Tests
 * deterministisch und offline laufen. Default: node:dns/promises lookup.
 *
 * Zentrale Regel: Fail closed — was nicht eindeutig öffentlich ist, wird
 * blockiert (ungültige IP, fehlgeschlagene DNS-Auflösung, ...).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

/** Blockierte IPv4-Netze (CIDR + Grund). */
const BLOCKED_V4 = [
    { cidr: '127.0.0.0/8', reason: 'loopback' },
    { cidr: '10.0.0.0/8', reason: 'private' },
    { cidr: '172.16.0.0/12', reason: 'private' },
    { cidr: '192.168.0.0/16', reason: 'private' },
    { cidr: '169.254.0.0/16', reason: 'link-local' },
    { cidr: '0.0.0.0/32', reason: 'unspecified' },
];

/** Blockierte IPv6-Netze (CIDR + Grund). */
const BLOCKED_V6 = [
    { cidr: '::1/128', reason: 'loopback' },
    { cidr: 'fe80::/10', reason: 'link-local' },
    { cidr: 'fc00::/7', reason: 'unique-local' },
    { cidr: '::/128', reason: 'unspecified' },
];

/**
 * Wandelt eine IPv4-Adresse in eine 32-Bit-Zahl um.
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToInt(ip) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Prüft, ob eine IPv4-Adresse in einem CIDR-Netz liegt.
 * @param {string} ip
 * @param {string} cidr
 * @returns {boolean}
 */
function ipv4InCidr(ip, cidr) {
    const [network, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}

/**
 * Expandiert eine IPv6-Adresse in 8 Gruppen à 16 Bit.
 * Behandelt `::`-Abkürzung und eingebettete IPv4 (z. B. ::ffff:1.2.3.4).
 * @param {string} ip
 * @returns {number[]}
 */
function ipv6ToGroups(ip) {
    let s = ip.toLowerCase();
    // Eingebettete IPv4 (dotted-quad) → zwei hex-Gruppen
    const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) {
        const o = v4[1].split('.').map((p) => parseInt(p, 10));
        const hi = ((o[0] << 8) | o[1]) & 0xffff;
        const lo = ((o[2] << 8) | o[3]) & 0xffff;
        s = s.slice(0, s.length - v4[1].length) + hi.toString(16) + ':' + lo.toString(16);
    }
    if (s.includes('::')) {
        const [left, right] = s.split('::');
        const leftParts = left ? left.split(':') : [];
        const rightParts = right ? right.split(':') : [];
        const missing = 8 - leftParts.length - rightParts.length;
        s = [...leftParts, ...Array(missing).fill('0'), ...rightParts].join(':');
    }
    return s.split(':').map((p) => parseInt(p, 16));
}

/**
 * Prüft, ob eine IPv6-Adresse in einem CIDR-Netz liegt.
 * @param {string} ip
 * @param {string} cidr
 * @returns {boolean}
 */
function ipv6InCidr(ip, cidr) {
    const [network, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    const ipGroups = ipv6ToGroups(ip);
    const netGroups = ipv6ToGroups(network);
    const fullGroups = Math.floor(bits / 16);
    const remBits = bits % 16;
    for (let i = 0; i < fullGroups; i++) {
        if (ipGroups[i] !== netGroups[i]) return false;
    }
    if (remBits > 0) {
        const mask = 0xffff << (16 - remBits);
        if ((ipGroups[fullGroups] & mask) !== (netGroups[fullGroups] & mask)) return false;
    }
    return true;
}

/**
 * Extrahiert die eingebettete IPv4 aus einer IPv4-mapped/compatible
 * IPv6-Adresse (z. B. ::ffff:127.0.0.1 → 127.0.0.1).
 * @param {string} ip
 * @returns {string|null}
 */
function extractMappedV4(ip) {
    const dotted = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return dotted[1];
    const groups = ipv6ToGroups(ip);
    if (groups.length === 8 && groups[5] === 0xffff &&
        groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
        groups[3] === 0 && groups[4] === 0) {
        return `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
    }
    return null;
}

/**
 * Prüft eine einzelne IP-Adresse gegen die blockierten Netze.
 * @param {string} ip
 * @returns {{blocked: boolean, reason?: string}}
 */
function checkIp(ip) {
    const family = net.isIP(ip);
    if (family === 4) {
        for (const { cidr, reason } of BLOCKED_V4) {
            if (ipv4InCidr(ip, cidr)) return { blocked: true, reason };
        }
        return { blocked: false };
    }
    if (family === 6) {
        // IPv4-mapped/compatible (z. B. ::ffff:127.0.0.1) → eingebettete IPv4 prüfen
        const mapped = extractMappedV4(ip);
        if (mapped) return checkIp(mapped);
        for (const { cidr, reason } of BLOCKED_V6) {
            if (ipv6InCidr(ip, cidr)) return { blocked: true, reason };
        }
        return { blocked: false };
    }
    // Keine gültige IP → fail closed
    return { blocked: true, reason: 'invalid-ip' };
}

/**
 * Standard-DNS-Lookup: liefert alle aufgelösten IP-Adressen.
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
async function defaultLookup(hostname) {
    const results = await dnsLookup(hostname, { all: true });
    return results.map((r) => r.address);
}

/**
 * Prüft eine URL gegen SSRF.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number[]} [options.allowedPorts] - Port-Whitelist (leer/undefined = keine Einschränkung)
 * @param {string[]} [options.allowedHosts] - Host-Whitelist: erlaubte Hostnamen (case-insensitiv),
 *   ausgenommen von der privaten-IP-Prüfung (z. B. lokale MCP-Server im LAN)
 * @param {(hostname: string) => Promise<string[]|string>} [options.lookup] - injizierbare DNS-Lookup-Funktion
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function assertSafeUrl(url, options = {}) {
    // 1. Syntaktisch gültig?
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, reason: 'invalid-url' };
    }

    // 2. Nur http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'protocol-not-allowed' };
    }

    // Hostname normalisieren (einige URL-Implementierungen behalten IPv6-Klammern bei).
    let hostname = parsed.hostname;
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
    }
    if (!hostname) {
        return { ok: false, reason: 'invalid-url' };
    }

    // 2b. Host-Whitelist: explizit erlaubter Hostname → IP-Prüfung überspringen.
    // (Port-Whitelist bleibt wirksam — sie ist eine separate Einschränkung.)
    if (Array.isArray(options.allowedHosts) && options.allowedHosts.length > 0) {
        const allowed = new Set(options.allowedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean));
        if (allowed.has(hostname.toLowerCase())) {
            return { ok: true, allowedHost: true };
        }
    }

    // 3. IP-Literal → direkt prüfen; Domain → DNS + alle IPs prüfen
    let ips;
    if (net.isIP(hostname)) {
        ips = [hostname];
    } else {
        const lookup = typeof options.lookup === 'function' ? options.lookup : defaultLookup;
        let addresses;
        try {
            addresses = await lookup(hostname);
        } catch {
            return { ok: false, reason: 'dns-resolution-failed' };
        }
        if (typeof addresses === 'string') addresses = [addresses];
        if (!Array.isArray(addresses) || addresses.length === 0) {
            return { ok: false, reason: 'dns-resolution-failed' };
        }
        ips = addresses;
    }

    for (const ip of ips) {
        const result = checkIp(ip);
        if (result.blocked) {
            return { ok: false, reason: result.reason };
        }
    }

    // 4. Port-Whitelist (optional)
    if (Array.isArray(options.allowedPorts) && options.allowedPorts.length > 0) {
        const port = parsed.port
            ? parseInt(parsed.port, 10)
            : (parsed.protocol === 'https:' ? 443 : 80);
        if (!options.allowedPorts.includes(port)) {
            return { ok: false, reason: 'port-not-allowed' };
        }
    }

    return { ok: true };
}
