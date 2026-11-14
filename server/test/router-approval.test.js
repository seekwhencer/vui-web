import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../src/Router/index.js';
import { Config } from '../src/Config.js';
import { McpManager } from '../src/McpManager.js';
import { PolicyEngine } from '../src/Security/PolicyEngine.js';
import { ApprovalService } from '../src/Security/ApprovalService.js';
import { ActionStore } from '../src/Security/ActionStore.js';
import { Audit } from '../src/Security/Audit.js';
import { ExecutionGateway } from '../src/Security/ExecutionGateway.js';

// FrontendRouter.init() startet Vite, wenn NODE_ENV=development.
// Für deterministische Tests ohne Vite (und sauberen Exit) NODE_ENV=test erzwingen.
process.env.NODE_ENV = 'test';

const silent = { log: () => { }, error: () => { } };

let dir, configPath, config, app, appHttpServer, router, appPort;
let store, audit, policy, approval, gateway, security, mcp;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vui-router-approval-'));
    configPath = join(dir, 'config.json');
    config = new Config({ CONFIG_PATH: configPath }, silent);
    // Tool-Policy: write-Tool für die Approval-Flows.
    config.security.toolPolicies = {
        'weather__set_forecast': 'write',
    };

    app = express();
    appHttpServer = createHttpServer(app);

    // Mock-MCP: liefert ein erfolgreiches Tool-Ergebnis (keine echten Server).
    mcp = {
        connectAll: async () => { },
        callTool: async () => ({ content: 'TOOL_RESULT', isError: false }),
    };
    store = new ActionStore(join(dir, 'actions.json'), silent);
    audit = new Audit(join(dir, 'audit.jsonl'), silent);
    policy = new PolicyEngine({ config, logger: silent });
    approval = new ApprovalService({ store, audit, policy, config, logger: silent });
    gateway = new ExecutionGateway({ mcp, store, audit, config, logger: silent });
    security = { policy, approval, audit, gateway, store };

    router = new Router(config, appHttpServer, silent, security, mcp);
    await router.define();
    app.use(router.router);

    // 404 + zentraler Error-Handler (wie in Server.js).
    app.use((req, res) => {
        res.status(404).json({ error: 'Not found', status: 'error', code: 'not_found' });
    });
    app.use((error, req, res, next) => {
        const status = error.status || 500;
        const code = error.code || 'internal_error';
        res.status(status).json({ error: error.message, status: 'error', code });
    });

    await new Promise((r) => appHttpServer.listen(0, '127.0.0.1', r));
    appPort = appHttpServer.address().port;
});

afterAll(async () => {
    appHttpServer.closeAllConnections?.();
    await new Promise((r) => appHttpServer.close(r));
    rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${appPort}`;
const json = (method, path, bodyObj) => fetch(`${base()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
});

/** Erzeugt eine PENDING_APPROVAL-Aktion direkt über den ApprovalService. */
async function proposeAction() {
    return approval.propose({
        serverId: 'weather',
        toolName: 'set_forecast',
        args: { city: 'Berlin' },
        reason: 'Test-Freigabe',
    });
}

describe('Approval-Endpunkte (Phase 2)', () => {
    it('Full Flow: propose → pending → details → approve → APPROVED', async () => {
        const action = await proposeAction();
        expect(action.status).toBe('PENDING_APPROVAL');

        // GET /api/actions/pending zeigt die offene Aktion.
        const pendingRes = await fetch(`${base()}/api/actions/pending`);
        expect(pendingRes.status).toBe(200);
        const pending = await pendingRes.json();
        expect(pending.success).toBe(true);
        expect(pending.data.some((a) => a.id === action.id)).toBe(true);

        // GET /api/actions/:id liefert die Details.
        const detailRes = await fetch(`${base()}/api/actions/${action.id}`);
        expect(detailRes.status).toBe(200);
        const detail = await detailRes.json();
        expect(detail.success).toBe(true);
        expect(detail.data.id).toBe(action.id);
        expect(detail.data.toolName).toBe('set_forecast');
        expect(detail.data.arguments).toEqual({ city: 'Berlin' });
        expect(detail.data.status).toBe('PENDING_APPROVAL');

        // POST /api/actions/:id/approve → APPROVED → COMPLETED (ausgeführt).
        const approveRes = await json('POST', `/api/actions/${action.id}/approve`, {});
        expect(approveRes.status).toBe(200);
        const approved = await approveRes.json();
        expect(approved.success).toBe(true);
        expect(approved.data.status).toBe('COMPLETED');
        expect(approved.data.approvedBy).toBe('local');
        expect(approved.data.approvedAt).toBeTruthy();

        // Nicht mehr in der Pending-Liste.
        const pendingAfter = await (await fetch(`${base()}/api/actions/pending`)).json();
        expect(pendingAfter.data.some((a) => a.id === action.id)).toBe(false);
    });

    it('reject-Flow → REJECTED (mit Reason)', async () => {
        const action = await proposeAction();
        const res = await json('POST', `/api/actions/${action.id}/reject`, { reason: 'nicht gewünscht' });
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.success).toBe(true);
        expect(j.data.status).toBe('REJECTED');
    });

    it('cancel-Flow → CANCELLED', async () => {
        const action = await proposeAction();
        const res = await json('POST', `/api/actions/${action.id}/cancel`, {});
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.success).toBe(true);
        expect(j.data.status).toBe('CANCELLED');
    });

    it('approve nicht existierende Aktion → 404 ACTION_NOT_FOUND', async () => {
        const res = await json('POST', '/api/actions/does-not-exist/approve', {});
        expect(res.status).toBe(404);
        const j = await res.json();
        expect(j.success).toBe(false);
        expect(j.error.code).toBe('ACTION_NOT_FOUND');
        expect(j.error.message).toBeTruthy();
    });

    it('GET /api/actions/:id nicht existierend → 404 ACTION_NOT_FOUND', async () => {
        const res = await fetch(`${base()}/api/actions/does-not-exist`);
        expect(res.status).toBe(404);
        const j = await res.json();
        expect(j.success).toBe(false);
        expect(j.error.code).toBe('ACTION_NOT_FOUND');
    });

    it('approve bereits APPROVED-Aktion → 409 INVALID_ACTION_STATE', async () => {
        const action = await proposeAction();
        await approval.approve(action.id);
        const res = await json('POST', `/api/actions/${action.id}/approve`, {});
        expect(res.status).toBe(409);
        const j = await res.json();
        expect(j.success).toBe(false);
        expect(j.error.code).toBe('INVALID_ACTION_STATE');
    });

    it('approve abgelaufene Aktion → 410 APPROVAL_EXPIRED', async () => {
        const originalTtl = config.security.approvalTtlMs;
        config.security.approvalTtlMs = 50;
        try {
            const action = await proposeAction();
            await new Promise((r) => setTimeout(r, 150));
            const res = await json('POST', `/api/actions/${action.id}/approve`, {});
            expect(res.status).toBe(410);
            const j = await res.json();
            expect(j.success).toBe(false);
            expect(j.error.code).toBe('APPROVAL_EXPIRED');
        } finally {
            config.security.approvalTtlMs = originalTtl;
        }
    });

    it('GET /api/audit liefert Audit-Einträge (inkl. Flow-Ereignisse)', async () => {
        const res = await fetch(`${base()}/api/audit?limit=50`);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.success).toBe(true);
        expect(Array.isArray(j.data)).toBe(true);
        expect(j.data.length).toBeGreaterThan(0);
        const events = j.data.map((e) => e.event);
        expect(events).toContain('ACTION_PROPOSED');
        expect(events).toContain('ACTION_APPROVED');
        expect(events).toContain('ACTION_REJECTED');
        expect(events).toContain('ACTION_CANCELLED');
        // Einträge haben die erwartete Struktur.
        for (const entry of j.data) {
            expect(entry.ts).toBeTruthy();
            expect(entry.event).toBeTruthy();
        }
    });

    it('GET /api/audit?limit=1 liefert genau 1 Eintrag', async () => {
        const res = await fetch(`${base()}/api/audit?limit=1`);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.success).toBe(true);
        expect(j.data).toHaveLength(1);
    });
});
