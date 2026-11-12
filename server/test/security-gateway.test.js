import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/Security/ActionStore.js';
import { Audit } from '../src/Security/Audit.js';
import { ExecutionGateway } from '../src/Security/ExecutionGateway.js';

const silent = { log: () => { }, error: () => { } };

describe('ExecutionGateway', () => {
    let dir, actionsPath, auditPath, store, audit, config, gateway, mockMcp;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vui-gateway-'));
        actionsPath = path.join(dir, 'actions.json');
        auditPath = path.join(dir, 'audit.jsonl');
        store = new ActionStore(actionsPath, silent);
        audit = new Audit(auditPath, silent);
        config = { security: { toolTimeoutMs: 30000, maxToolResultBytes: 65536 } };
        mockMcp = {
            callTool: async () => ({ content: 'TOOL_RESULT', isError: false }),
        };
        gateway = new ExecutionGateway({ mcp: mockMcp, store, audit, config, logger: silent });
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('executeRead', () => {
        it('liefert content + isError vom MCP-Manager', async () => {
            const result = await gateway.executeRead('weather', 'get_weather', { city: 'Berlin' });
            expect(result.content).toBe('TOOL_RESULT');
            expect(result.isError).toBe(false);
        });

        it('audit EXECUTION_COMPLETED bei Erfolg', async () => {
            await gateway.executeRead('weather', 'get_weather', {});
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'EXECUTION_COMPLETED' && e.metadata.toolName === 'get_weather')).toBe(true);
        });

        it('audit EXECUTION_FAILED bei isError-Ergebnis', async () => {
            mockMcp.callTool = async () => ({ content: 'boom', isError: true });
            const result = await gateway.executeRead('weather', 'get_weather', {});
            expect(result.isError).toBe(true);
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'EXECUTION_FAILED' && e.metadata.toolName === 'get_weather')).toBe(true);
        });

        it('audit EXECUTION_FAILED, wenn der MCP-Manager wirft', async () => {
            mockMcp.callTool = async () => { throw new Error('tool exploded'); };
            const result = await gateway.executeRead('weather', 'get_weather', {});
            expect(result.isError).toBe(true);
            expect(result.content).toBe('tool exploded');
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'EXECUTION_FAILED')).toBe(true);
        });

        it('Timeout → isError: true + EXECUTION_FAILED', async () => {
            config.security.toolTimeoutMs = 50;
            mockMcp.callTool = () => new Promise((resolve) => setTimeout(() => resolve({ content: 'late', isError: false }), 200));
            const result = await gateway.executeRead('weather', 'get_weather', {});
            expect(result.isError).toBe(true);
            expect(result.content).toMatch(/timeout/i);
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'EXECUTION_FAILED')).toBe(true);
        });

        it('kürzt große Ergebnisse auf maxToolResultBytes + Hinweis', async () => {
            config.security.maxToolResultBytes = 100;
            mockMcp.callTool = async () => ({ content: 'x'.repeat(1000), isError: false });
            const result = await gateway.executeRead('weather', 'get_weather', {});
            expect(result.content).toContain('[TRUNCATED');
            expect(result.content).not.toBe('x'.repeat(1000));
            expect(result.content.length).toBeLessThan(1000 + 100);
        });

        it('kürzt nicht, wenn das Ergebnis unter dem Limit liegt', async () => {
            config.security.maxToolResultBytes = 1000;
            mockMcp.callTool = async () => ({ content: 'small', isError: false });
            const result = await gateway.executeRead('weather', 'get_weather', {});
            expect(result.content).toBe('small');
            expect(result.content).not.toContain('[TRUNCATED');
        });

        it('nutzt Defaults, wenn config.security fehlt', async () => {
            const g = new ExecutionGateway({ mcp: mockMcp, store, audit, config: {}, logger: silent });
            const result = await g.executeRead('weather', 'get_weather', {});
            expect(result.content).toBe('TOOL_RESULT');
            expect(result.isError).toBe(false);
        });
    });

    describe('executeApproved', () => {
        /** Legt eine APPROVED-Aktion direkt im Store an (Approval umgangen). */
        async function createApproved({ serverId = 'weather', toolName = 'set_weather', args = {} } = {}) {
            return store.create({
                userId: 'local',
                tenantId: 'local',
                serverId,
                toolName,
                arguments: args,
                status: 'APPROVED',
                approvedBy: 'local',
                approvedAt: new Date().toISOString(),
                result: null,
            });
        }

        it('führt APPROVED-Aktion aus → COMPLETED + result + Audit EXECUTION_COMPLETED', async () => {
            const action = await createApproved();
            const result = await gateway.executeApproved(action.id);
            expect(result.status).toBe('COMPLETED');
            expect(result.result).toEqual({ content: 'TOOL_RESULT', isError: false });
            const stored = await store.get(action.id);
            expect(stored.status).toBe('COMPLETED');
            expect(stored.result).toEqual({ content: 'TOOL_RESULT', isError: false });
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'EXECUTION_COMPLETED' && e.actionId === action.id && e.metadata.toolName === 'set_weather')).toBe(true);
        });

        it('Replay: zweiter Aufruf für dieselbe actionId wirft INVALID_ACTION_STATE', async () => {
            const action = await createApproved();
            await gateway.executeApproved(action.id);
            await expect(gateway.executeApproved(action.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
            const stored = await store.get(action.id);
            expect(stored.status).toBe('COMPLETED');
        });

        it('konkurrente Aufrufe: nur einer führt aus (atomarer Übergang)', async () => {
            const action = await createApproved();
            let calls = 0;
            mockMcp.callTool = async () => { calls++; return { content: 'TOOL_RESULT', isError: false }; };
            const results = await Promise.allSettled([
                gateway.executeApproved(action.id),
                gateway.executeApproved(action.id),
            ]);
            const fulfilled = results.filter((r) => r.status === 'fulfilled');
            const rejected = results.filter((r) => r.status === 'rejected');
            expect(fulfilled.length).toBe(1);
            expect(rejected.length).toBe(1);
            expect(rejected[0].reason.code).toBe('INVALID_ACTION_STATE');
            expect(calls).toBe(1);
            const stored = await store.get(action.id);
            expect(stored.status).toBe('COMPLETED');
        });

        it('wirft INVALID_ACTION_STATE bei PENDING_APPROVAL', async () => {
            const action = await store.create({
                userId: 'local',
                tenantId: 'local',
                serverId: 'weather',
                toolName: 'set_weather',
                arguments: {},
                status: 'PENDING_APPROVAL',
                result: null,
            });
            await expect(gateway.executeApproved(action.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
            const stored = await store.get(action.id);
            expect(stored.status).toBe('PENDING_APPROVAL');
        });

        it('wirft ACTION_NOT_FOUND bei unbekannter actionId', async () => {
            await expect(gateway.executeApproved('does-not-exist')).rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' });
        });

        it('Fehlerpfad: mcp.callTool wirft → FAILED + Audit EXECUTION_FAILED', async () => {
            mockMcp.callTool = async () => { throw new Error('tool exploded'); };
            const action = await createApproved();
            const result = await gateway.executeApproved(action.id);
            expect(result.status).toBe('FAILED');
            expect(result.result).toEqual({ content: 'tool exploded', isError: true });
            const stored = await store.get(action.id);
            expect(stored.status).toBe('FAILED');
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'EXECUTION_FAILED' && e.actionId === action.id && e.metadata.toolName === 'set_weather')).toBe(true);
        });

        it('NetworkGuard blockiert URL-Argument → FAILED + Audit EXECUTION_FAILED', async () => {
            const action = await createApproved({ args: { url: 'http://127.0.0.1:8080/admin' } });
            const result = await gateway.executeApproved(action.id);
            expect(result.status).toBe('FAILED');
            expect(result.result.isError).toBe(true);
            expect(result.result.content).toMatch(/BLOCKED/i);
            const stored = await store.get(action.id);
            expect(stored.status).toBe('FAILED');
            const entries = await audit.tail(100);
            expect(entries.some((e) => e.event === 'EXECUTION_FAILED' && e.actionId === action.id)).toBe(true);
        });
    });
});
