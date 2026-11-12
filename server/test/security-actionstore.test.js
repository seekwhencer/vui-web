import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/Security/ActionStore.js';

describe('ActionStore', () => {
    let dir;
    let filePath;
    let store;
    const logger = { log: () => { }, error: () => { } };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vui-actionstore-'));
        filePath = path.join(dir, 'actions.json');
        store = new ActionStore(filePath, logger);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function makeAction(overrides = {}) {
        return {
            userId: 'local',
            tenantId: 'local',
            toolName: 'weather__set_forecast',
            serverId: 'weather',
            arguments: { city: 'Berlin' },
            payloadHash: 'ab'.repeat(32),
            status: 'PENDING_APPROVAL',
            reason: 'Test',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            approvedBy: null,
            approvedAt: null,
            result: null,
            idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
            ...overrides,
        };
    }

    it('create + get: Round-Trip', async () => {
        const created = await store.create(makeAction({ id: 'act-1' }));
        expect(created.id).toBe('act-1');
        expect(created.status).toBe('PENDING_APPROVAL');
        expect(created.createdAt).toBeTruthy();
        expect(created.updatedAt).toBeTruthy();

        const fetched = await store.get('act-1');
        expect(fetched).toEqual(created);
    });

    it('create: setzt createdAt/updatedAt, wenn nicht vorhanden', async () => {
        const created = await store.create(makeAction({ id: 'act-2' }));
        expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
        expect(new Date(created.updatedAt).toISOString()).toBe(created.updatedAt);
    });

    it('create: generiert eine id, wenn keine vorhanden', async () => {
        const created = await store.create(makeAction());
        expect(created.id).toBeTruthy();
        expect(typeof created.id).toBe('string');
    });

    it('create: doppelte id → Fehler', async () => {
        await store.create(makeAction({ id: 'dup-1' }));
        await expect(store.create(makeAction({ id: 'dup-1' }))).rejects.toThrow();
    });

    it('get: unbekannte id → null', async () => {
        expect(await store.get('nope')).toBeNull();
    });

    it('listPending: nur PENDING_APPROVAL-Aktionen', async () => {
        await store.create(makeAction({ id: 'p-1', status: 'PENDING_APPROVAL' }));
        await store.create(makeAction({ id: 'p-2', status: 'APPROVED' }));
        await store.create(makeAction({ id: 'p-3', status: 'PENDING_APPROVAL' }));
        await store.create(makeAction({ id: 'p-4', status: 'COMPLETED' }));

        const pending = await store.listPending();
        expect(pending).toHaveLength(2);
        expect(pending.map((a) => a.id).sort()).toEqual(['p-1', 'p-3']);
        expect(pending.every((a) => a.status === 'PENDING_APPROVAL')).toBe(true);
    });

    it('transition gültig: PENDING_APPROVAL → APPROVED', async () => {
        await store.create(makeAction({ id: 't-1', status: 'PENDING_APPROVAL' }));
        const approvedAt = new Date().toISOString();
        const updated = await store.transition('t-1', 'PENDING_APPROVAL', 'APPROVED', { approvedBy: 'local', approvedAt });
        expect(updated).not.toBeNull();
        expect(updated.status).toBe('APPROVED');
        expect(updated.approvedBy).toBe('local');
        expect(updated.approvedAt).toBe(approvedAt);

        const fetched = await store.get('t-1');
        expect(fetched.status).toBe('APPROVED');
        expect(fetched.approvedBy).toBe('local');
    });

    it('transition ungültig: fromStatus ≠ current (APPROVED → APPROVED) → null, Aktion unverändert', async () => {
        await store.create(makeAction({ id: 't-2', status: 'PENDING_APPROVAL' }));
        const before = await store.get('t-2');
        const result = await store.transition('t-2', 'APPROVED', 'APPROVED', { approvedBy: 'hacker' });
        expect(result).toBeNull();
        const after = await store.get('t-2');
        expect(after).toEqual(before);
        expect(after.status).toBe('PENDING_APPROVAL');
    });

    it('transition ungültig: fromStatus ≠ current (COMPLETED → EXECUTING) → null, Aktion unverändert', async () => {
        await store.create(makeAction({ id: 't-3', status: 'APPROVED' }));
        const before = await store.get('t-3');
        const result = await store.transition('t-3', 'COMPLETED', 'EXECUTING', {});
        expect(result).toBeNull();
        const after = await store.get('t-3');
        expect(after).toEqual(before);
        expect(after.status).toBe('APPROVED');
    });

    it('Replay-Schutz: COMPLETED-Aktion kann nicht erneut nach EXECUTING', async () => {
        await store.create(makeAction({ id: 'rp-1', status: 'PENDING_APPROVAL' }));
        await store.transition('rp-1', 'PENDING_APPROVAL', 'APPROVED', {});
        await store.transition('rp-1', 'APPROVED', 'EXECUTING', {});
        await store.transition('rp-1', 'EXECUTING', 'COMPLETED', { result: { content: 'ok', isError: false } });
        const before = await store.get('rp-1');
        expect(before.status).toBe('COMPLETED');

        // Replay: Gateway versucht erneut APPROVED → EXECUTING
        const result = await store.transition('rp-1', 'APPROVED', 'EXECUTING', {});
        expect(result).toBeNull();
        const after = await store.get('rp-1');
        expect(after).toEqual(before);
        expect(after.status).toBe('COMPLETED');
    });

    it('transition: unbekannte id → null', async () => {
        const result = await store.transition('ghost', 'PENDING_APPROVAL', 'APPROVED', {});
        expect(result).toBeNull();
    });

    it('Concurrent-Transitions: zwei parallele transition() → genau eine gewinnt', async () => {
        await store.create(makeAction({ id: 'c-1', status: 'PENDING_APPROVAL' }));
        const [r1, r2] = await Promise.all([
            store.transition('c-1', 'PENDING_APPROVAL', 'APPROVED', { approvedBy: 'a' }),
            store.transition('c-1', 'PENDING_APPROVAL', 'REJECTED', { reason: 'b' }),
        ]);
        const winners = [r1, r2].filter((r) => r !== null);
        const losers = [r1, r2].filter((r) => r === null);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        const final = await store.get('c-1');
        expect(['APPROVED', 'REJECTED']).toContain(final.status);
    });

    it('listRecent: letzte N Aktionen nach updatedAt absteigend', async () => {
        for (let i = 1; i <= 5; i++) {
            await store.create(makeAction({ id: `r-${i}`, updatedAt: new Date(Date.now() + i * 1000).toISOString() }));
        }
        const recent = await store.listRecent(3);
        expect(recent).toHaveLength(3);
        expect(recent.map((a) => a.id)).toEqual(['r-5', 'r-4', 'r-3']);
    });

    it('listRecent: limit größer als Anzahl → alle', async () => {
        await store.create(makeAction({ id: 'r-1' }));
        await store.create(makeAction({ id: 'r-2' }));
        const recent = await store.listRecent(50);
        expect(recent).toHaveLength(2);
    });

    it('persistiert atomar: Datei enthält alle Aktionen', async () => {
        await store.create(makeAction({ id: 'f-1' }));
        await store.create(makeAction({ id: 'f-2' }));
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed).toHaveLength(2);
        expect(parsed.map((a) => a.id).sort()).toEqual(['f-1', 'f-2']);
    });

    it('lädt bestehende Datei (neue Instanz)', async () => {
        await store.create(makeAction({ id: 'l-1' }));
        const store2 = new ActionStore(filePath, logger);
        const fetched = await store2.get('l-1');
        expect(fetched).not.toBeNull();
        expect(fetched.id).toBe('l-1');
    });

    it('erstellt das Elternverzeichnis, wenn es fehlt', async () => {
        const nested = new ActionStore(path.join(dir, 'nested', 'deep', 'actions.json'), logger);
        await nested.create(makeAction({ id: 'n-1' }));
        const raw = fs.readFileSync(path.join(dir, 'nested', 'deep', 'actions.json'), 'utf8');
        expect(JSON.parse(raw)).toHaveLength(1);
    });
});
