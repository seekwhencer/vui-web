import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/Security/ActionStore.js';
import { Audit } from '../src/Security/Audit.js';
import { PolicyEngine } from '../src/Security/PolicyEngine.js';
import { ApprovalService } from '../src/Security/ApprovalService.js';

describe('ApprovalService', () => {
    let dir;
    let actionsPath;
    let auditPath;
    let store;
    let audit;
    let policy;
    let config;
    let service;
    const logger = { log: () => { }, error: () => { } };

    const policies = {
        'weather__get_forecast': 'read',
        'weather__set_forecast': 'write',
        'shell__run_command': 'execute',
        'shell__wipe_disk': 'deny',
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vui-approval-'));
        actionsPath = path.join(dir, 'actions.json');
        auditPath = path.join(dir, 'audit.jsonl');
        store = new ActionStore(actionsPath, logger);
        audit = new Audit(auditPath, logger);
        policy = new PolicyEngine({ config: { security: { toolPolicies: policies } }, logger });
        config = { security: { approvalTtlMs: 600000 } };
        service = new ApprovalService({ store, audit, policy, config, logger });
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Liest die Aktionen-Datei direkt (umgeht den In-Memory-Cache des Stores). */
    function readActionsFile() {
        return JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    }

    function writeActionsFile(actions) {
        fs.writeFileSync(actionsPath, `${JSON.stringify(actions, null, 2)}\n`, 'utf8');
    }

    /** Neue Service-Instanz, die die (ggf. manipulierte) Datei neu lädt. */
    function freshService() {
        return new ApprovalService({ store: new ActionStore(actionsPath, logger), audit, policy, config, logger });
    }

    async function proposeWrite() {
        return service.propose({
            serverId: 'weather',
            toolName: 'set_forecast',
            args: { city: 'Berlin' },
            reason: 'Vorhersage für Berlin ändern',
        });
    }

    describe('propose', () => {
        it('erzeugt eine PENDING_APPROVAL-Aktion mit Hash, TTL und Audit-Eintrag', async () => {
            const before = Date.now();
            const action = await proposeWrite();
            const after = Date.now();

            expect(action.status).toBe('PENDING_APPROVAL');
            expect(action.userId).toBe('local');
            expect(action.tenantId).toBe('local');
            expect(action.serverId).toBe('weather');
            expect(action.toolName).toBe('set_forecast');
            expect(action.arguments).toEqual({ city: 'Berlin' });
            expect(action.payloadHash).toMatch(/^[0-9a-f]{64}$/);
            expect(action.approvedBy).toBeNull();
            expect(action.approvedAt).toBeNull();
            expect(action.result).toBeNull();
            expect(action.idempotencyKey).toBeTruthy();
            expect(action.createdAt).toBeTruthy();
            expect(action.updatedAt).toBeTruthy();

            const expires = new Date(action.expiresAt).getTime();
            expect(expires).toBeGreaterThanOrEqual(before + 600000);
            expect(expires).toBeLessThanOrEqual(after + 600000);

            const entries = await audit.tail(100);
            const proposed = entries.find((e) => e.event === 'ACTION_PROPOSED' && e.actionId === action.id);
            expect(proposed).toBeTruthy();
            expect(proposed.metadata.toolName).toBe('set_forecast');
            expect(proposed.metadata.reason).toBe('Vorhersage für Berlin ändern');
        });

        it('kürzt die reason auf 1000 Zeichen', async () => {
            const action = await service.propose({
                serverId: 'weather',
                toolName: 'set_forecast',
                args: {},
                reason: 'x'.repeat(1500),
            });
            expect(action.reason).toHaveLength(1000);
        });

        it('policy-gesperrtes Tool → POLICY_DENIED, keine Aktion gespeichert', async () => {
            const err = await service.propose({ serverId: 'shell', toolName: 'wipe_disk', args: {}, reason: 'test' }).catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('POLICY_DENIED');
            expect(await store.listPending()).toHaveLength(0);
        });

        it('unbekanntes Tool (Default-Deny) → POLICY_DENIED', async () => {
            const err = await service.propose({ serverId: 'ghost', toolName: 'unknown', args: {}, reason: 'test' }).catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('POLICY_DENIED');
        });

        it('maxPendingActions: älteste PENDING-Aktion wird abgebrochen, wenn das Limit erreicht ist', async () => {
            config.security.maxPendingActions = 3;
            const actions = [];
            for (let i = 0; i < 4; i++) {
                actions.push(await service.propose({
                    serverId: 'weather',
                    toolName: 'set_forecast',
                    args: { city: `City${i}` },
                    reason: `Test ${i}`,
                }));
            }
            // Die älteste (City0) wurde abgebrochen.
            const oldest = await store.get(actions[0].id);
            expect(oldest.status).toBe('CANCELLED');
            // Die anderen 3 sind PENDING (älteste zuerst).
            const pending = await store.listPending();
            expect(pending).toHaveLength(3);
            expect(pending.map((a) => a.arguments.city)).toEqual(['City1', 'City2', 'City3']);
            // Audit-Eintrag ACTION_CANCELLED für die älteste.
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'ACTION_CANCELLED' && e.actionId === actions[0].id)).toBe(true);
        });

        it('maxPendingActions: unter dem Limit wird nichts abgebrochen', async () => {
            config.security.maxPendingActions = 5;
            for (let i = 0; i < 3; i++) {
                await service.propose({
                    serverId: 'weather',
                    toolName: 'set_forecast',
                    args: { city: `City${i}` },
                    reason: `Test ${i}`,
                });
            }
            // Alle 3 sind PENDING, keine wurde abgebrochen.
            const pending = await store.listPending();
            expect(pending).toHaveLength(3);
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'ACTION_CANCELLED')).toBe(false);
        });
    });

    describe('approve', () => {
        it('gültige Aktion → APPROVED, Audit ACTION_APPROVED', async () => {
            const action = await proposeWrite();
            const approved = await service.approve(action.id);

            expect(approved.status).toBe('APPROVED');
            expect(approved.approvedBy).toBe('local');
            expect(approved.approvedAt).toBeTruthy();

            const stored = await store.get(action.id);
            expect(stored.status).toBe('APPROVED');
            expect(stored.approvedBy).toBe('local');

            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'ACTION_APPROVED' && e.actionId === action.id)).toBe(true);
        });

        it('abgelaufene Aktion → APPROVAL_EXPIRED, Aktion wird EXPIRED', async () => {
            const action = await proposeWrite();
            const actions = readActionsFile();
            actions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
            writeActionsFile(actions);

            const err = await freshService().approve(action.id).catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('APPROVAL_EXPIRED');

            const stored = await new ActionStore(actionsPath, logger).get(action.id);
            expect(stored.status).toBe('EXPIRED');
        });

        it('falscher Status (bereits REJECTED) → INVALID_ACTION_STATE', async () => {
            const action = await proposeWrite();
            await service.reject(action.id, 'nicht nötig');

            const err = await service.approve(action.id).catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('INVALID_ACTION_STATE');
        });

        it('manipulierte Argumente → INTEGRITY_FAILURE, Aktion bleibt PENDING_APPROVAL', async () => {
            const action = await proposeWrite();
            const actions = readActionsFile();
            actions[0].arguments = { city: 'Hacker' };
            writeActionsFile(actions);

            const err = await freshService().approve(action.id).catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('INTEGRITY_FAILURE');

            const stored = await new ActionStore(actionsPath, logger).get(action.id);
            expect(stored.status).toBe('PENDING_APPROVAL');
        });

        it('unbekannte id → ACTION_NOT_FOUND', async () => {
            const err = await service.approve('ghost-id').catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('ACTION_NOT_FOUND');
        });

        it('Doppel-Approve: zweiter Versuch → INVALID_ACTION_STATE', async () => {
            const action = await proposeWrite();
            await service.approve(action.id);

            const err = await service.approve(action.id).catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('INVALID_ACTION_STATE');

            const stored = await store.get(action.id);
            expect(stored.status).toBe('APPROVED');
        });
    });

    describe('reject', () => {
        it('PENDING_APPROVAL → REJECTED, Audit ACTION_REJECTED mit reason', async () => {
            const action = await proposeWrite();
            const rejected = await service.reject(action.id, 'zu riskant');

            expect(rejected.status).toBe('REJECTED');
            const stored = await store.get(action.id);
            expect(stored.status).toBe('REJECTED');

            const entries = await audit.tail(100);
            const entry = entries.find((e) => e.event === 'ACTION_REJECTED' && e.actionId === action.id);
            expect(entry).toBeTruthy();
            expect(entry.metadata.reason).toBe('zu riskant');
        });

        it('unbekannte id → ACTION_NOT_FOUND', async () => {
            const err = await service.reject('ghost-id', 'x').catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('ACTION_NOT_FOUND');
        });

        it('falscher Status (bereits APPROVED) → INVALID_ACTION_STATE', async () => {
            const action = await proposeWrite();
            await service.approve(action.id);

            const err = await service.reject(action.id, 'x').catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('INVALID_ACTION_STATE');
        });
    });

    describe('cancel', () => {
        it('PENDING_APPROVAL → CANCELLED, Audit ACTION_CANCELLED', async () => {
            const action = await proposeWrite();
            const cancelled = await service.cancel(action.id);

            expect(cancelled.status).toBe('CANCELLED');
            const stored = await store.get(action.id);
            expect(stored.status).toBe('CANCELLED');

            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'ACTION_CANCELLED' && e.actionId === action.id)).toBe(true);
        });

        it('unbekannte id → ACTION_NOT_FOUND', async () => {
            const err = await service.cancel('ghost-id').catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('ACTION_NOT_FOUND');
        });
    });
});
