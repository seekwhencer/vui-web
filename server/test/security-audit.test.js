import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Audit } from '../src/Security/Audit.js';

describe('Audit', () => {
    let dir;
    let filePath;
    let audit;
    const logger = { log: () => { }, error: () => { } };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vui-audit-'));
        filePath = path.join(dir, 'audit.jsonl');
        audit = new Audit(filePath, logger);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('append: mehrere log()-Aufrufe → mehrere JSONL-Zeilen', async () => {
        await audit.log('ACTION_PROPOSED', { toolName: 'weather__set_forecast' }, 'id-1');
        await audit.log('ACTION_APPROVED', {}, 'id-1');
        await audit.log('EXECUTION_COMPLETED', { toolName: 'weather__set_forecast' }, 'id-1');

        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim() !== '');
        expect(lines).toHaveLength(3);
    });

    it('append-only: neue Instanz hängt an, alte Zeilen bleiben erhalten', async () => {
        await audit.log('ACTION_PROPOSED', { n: 1 }, 'a');

        const audit2 = new Audit(filePath, logger);
        await audit2.log('ACTION_APPROVED', { n: 2 }, 'a');

        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
        expect(lines).toHaveLength(2);
        expect(lines[0].event).toBe('ACTION_PROPOSED');
        expect(lines[1].event).toBe('ACTION_APPROVED');
    });

    it('Reihenfolge: Zeilen erscheinen in der Reihenfolge der log()-Aufrufe', async () => {
        await audit.log('ACTION_PROPOSED', { n: 1 }, 'a');
        await audit.log('ACTION_APPROVED', { n: 2 }, 'b');
        await audit.log('ACTION_REJECTED', { n: 3 }, 'c');

        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
        expect(lines.map((e) => e.event)).toEqual(['ACTION_PROPOSED', 'ACTION_APPROVED', 'ACTION_REJECTED']);
        expect(lines.map((e) => e.metadata.n)).toEqual([1, 2, 3]);
    });

    it('tail(n): liefert die letzten n Einträge in korrekter Reihenfolge', async () => {
        for (let i = 1; i <= 5; i++) {
            await audit.log('EVENT', { i }, `id-${i}`);
        }

        const last2 = await audit.tail(2);
        expect(last2).toHaveLength(2);
        expect(last2.map((e) => e.metadata.i)).toEqual([4, 5]);

        const all = await audit.tail(100);
        expect(all).toHaveLength(5);
        expect(all.map((e) => e.metadata.i)).toEqual([1, 2, 3, 4, 5]);
    });

    it('tail(): fehlende Datei → leeres Array', async () => {
        expect(await audit.tail(10)).toEqual([]);
    });

    it('erstellt das Elternverzeichnis, wenn es fehlt', async () => {
        const nested = new Audit(path.join(dir, 'nested', 'deep', 'audit.jsonl'), logger);
        await nested.log('ACTION_PROPOSED', { n: 1 }, 'a');

        const raw = fs.readFileSync(path.join(dir, 'nested', 'deep', 'audit.jsonl'), 'utf8');
        expect(raw.trim().split('\n')).toHaveLength(1);
    });

    it('jede Zeile ist gültiges JSON mit ts/actionId/event/metadata', async () => {
        await audit.log('ACTION_PROPOSED', { toolName: 'x', reason: 'y' }, 'uuid-1');
        await audit.log('POLICY_DENIED', { toolName: 'z' }, null);

        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(2);

        for (const line of lines) {
            const entry = JSON.parse(line);
            expect(entry).toHaveProperty('ts');
            expect(entry).toHaveProperty('actionId');
            expect(entry).toHaveProperty('event');
            expect(entry).toHaveProperty('metadata');
            expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
        }

        const [first, second] = lines.map((l) => JSON.parse(l));
        expect(first.actionId).toBe('uuid-1');
        expect(second.actionId).toBeNull();
        expect(second.metadata).toEqual({ toolName: 'z' });
    });
});
