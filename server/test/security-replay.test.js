import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/Security/ActionStore.js';
import { Audit } from '../src/Security/Audit.js';
import { PolicyEngine } from '../src/Security/PolicyEngine.js';
import { ApprovalService } from '../src/Security/ApprovalService.js';
import { ExecutionGateway } from '../src/Security/ExecutionGateway.js';

const silent = { log: () => { }, error: () => { } };

/**
 * Replay-Schutz (Zero-Trust, Phase 5).
 *
 * Verifiziert, dass eine Freigabe genau EINMAL ausgeführt werden kann:
 *  1. Doppelte Ausführung (Replay) → INVALID_ACTION_STATE, MCP nur 1x.
 *  2. Abgelaufene Freigabe → APPROVAL_EXPIRED, Ausführung unmöglich.
 *  3. Manipulierte Parameter → INTEGRITY_FAILURE, Aktion NICHT freigegeben.
 *
 * Die Replay-Garantie ist der atomare Zustandsübergang APPROVED → EXECUTING
 * im ActionStore (COMPLETED → EXECUTING ist unmöglich) plus die
 * Hash-Integritätsprüfung bei der Freigabe.
 */
describe('Replay Protection', () => {
    let dir, actionsPath, auditPath, store, audit, policy, config, service, gateway, mockMcp, callCount;

    const policies = {
        'weather__get_forecast': 'read',
        'weather__set_forecast': 'write',
        'shell__run_command': 'execute',
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vui-replay-'));
        actionsPath = path.join(dir, 'actions.json');
        auditPath = path.join(dir, 'audit.jsonl');
        store = new ActionStore(actionsPath, silent);
        audit = new Audit(auditPath, silent);
        config = {
            security: {
                approvalTtlMs: 600000,
                toolTimeoutMs: 30000,
                maxToolResultBytes: 65536,
                toolPolicies: policies,
            },
        };
        policy = new PolicyEngine({ config, logger: silent });
        callCount = 0;
        mockMcp = {
            callTool: async () => { callCount++; return { content: 'TOOL_RESULT', isError: false }; },
        };
        service = new ApprovalService({ store, audit, policy, config, logger: silent });
        gateway = new ExecutionGateway({ mcp: mockMcp, store, audit, config, logger: silent });
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
        return new ApprovalService({ store: new ActionStore(actionsPath, silent), audit, policy, config, logger: silent });
    }

    /** Neues Gateway, das die (ggf. manipulierte) Datei neu lädt. */
    function freshGateway() {
        return new ExecutionGateway({ mcp: mockMcp, store: new ActionStore(actionsPath, silent), audit, config, logger: silent });
    }

    async function proposeWrite() {
        return service.propose({
            serverId: 'weather',
            toolName: 'set_forecast',
            args: { city: 'Berlin' },
            reason: 'Vorhersage für Berlin ändern',
        });
    }

    it('blockiert doppelte Ausführung (Replay)', async () => {
        const action = await proposeWrite();
        await service.approve(action.id);
        const completed = await gateway.executeApproved(action.id);

        expect(completed.status).toBe('COMPLETED');
        expect(callCount).toBe(1);

        // Zweiter Aufruf für dieselbe actionId → INVALID_ACTION_STATE
        // (die Aktion ist nicht mehr APPROVED, sondern COMPLETED).
        const err = await gateway.executeApproved(action.id).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('INVALID_ACTION_STATE');

        // MCP wurde genau EINMAL aufgerufen (keine Doppel-Ausführung).
        expect(callCount).toBe(1);

        const stored = await store.get(action.id);
        expect(stored.status).toBe('COMPLETED');

        // Audit: genau ein EXECUTION_COMPLETED für diese Aktion.
        const entries = await audit.tail(100);
        expect(entries.filter((e) => e.event === 'EXECUTION_COMPLETED' && e.actionId === action.id)).toHaveLength(1);
    });

    it('blockiert abgelaufene Freigaben', async () => {
        const action = await proposeWrite();
        const actions = readActionsFile();
        actions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
        writeActionsFile(actions);

        const err = await freshService().approve(action.id).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('APPROVAL_EXPIRED');

        const stored = await new ActionStore(actionsPath, silent).get(action.id);
        expect(stored.status).toBe('EXPIRED');

        // Eine abgelaufene Freigabe kann NICHT ausgeführt werden.
        const execErr = await freshGateway().executeApproved(action.id).catch((e) => e);
        expect(execErr).toBeInstanceOf(Error);
        expect(execErr.code).toBe('INVALID_ACTION_STATE');
        expect(callCount).toBe(0);
    });

    it('blockiert manipulierte Parameter', async () => {
        const action = await proposeWrite();
        const actions = readActionsFile();
        actions[0].arguments = { city: 'Hacker' };
        writeActionsFile(actions);

        const err = await freshService().approve(action.id).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('INTEGRITY_FAILURE');

        // Die Aktion ist NICHT freigegeben (bleibt PENDING_APPROVAL).
        const stored = await new ActionStore(actionsPath, silent).get(action.id);
        expect(stored.status).toBe('PENDING_APPROVAL');
        expect(stored.approvedBy).toBeNull();
        expect(stored.approvedAt).toBeNull();
    });
});
