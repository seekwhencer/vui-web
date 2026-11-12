import crypto from 'node:crypto';

/**
 * Kanonische Serialisierung: sortierte Keys, rekursiv.
 * Ablehnt: undefined, NaN, Infinity, Funktionen, Symbol, Map, Set, toJSON.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return JSON.stringify(value);
    if (t === 'number') {
        if (!Number.isFinite(value)) throw new Error('canonicalize: nicht-endliche Zahl');
        return String(value);
    }
    if (t === 'undefined') throw new Error('canonicalize: undefined');
    if (t !== 'object') throw new Error(`canonicalize: Typ ${t}`);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (value instanceof Map || value instanceof Set) throw new Error('canonicalize: Map/Set');
    const obj = value;
    if (typeof obj.toJSON === 'function') throw new Error('canonicalize: toJSON');
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * Payload-Hash: bindet Freigabe an den vollständigen Auftrag.
 * @param {string} userId
 * @param {string} tenantId
 * @param {string} toolName
 * @param {object} args
 * @returns {string} hex-SHA-256
 */
export function createPayloadHash(userId, tenantId, toolName, args) {
    const payload = canonicalize({ userId, tenantId, toolName, args });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Timing-sicherer Hex-Vergleich.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqualHex(a, b) {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
