import { randomUUID } from 'node:crypto';
import { createPayloadHash, safeEqualHex } from './Integrity.js';

/**
 * Approval-Service (Zero-Trust, Phase 2).
 *
 * Zustandsmaschine + Freigabe-Logik:
 *   PENDING_APPROVAL → APPROVED → (ExecutionGateway) → COMPLETED
 *   PENDING_APPROVAL → REJECTED | CANCELLED | EXPIRED
 *
 * Jede Freigabe ist einmalig, hash-gebunden und ablaufend (Replay-Schutz).
 * Fehler tragen einen maschinenlesbaren `code` (z. B. 'APPROVAL_EXPIRED'),
 * den die Router-Schicht auf HTTP-Status mappen kann.
 */

const USER_ID = 'local';
const TENANT_ID = 'local';
const MAX_REASON_LENGTH = 1000;

/**
 * Erzeugt einen Fehler mit maschinenlesbarem Code.
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function createError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

class ApprovalService {
    /**
     * @param {object} params
     * @param {ActionStore} params.store
     * @param {Audit} params.audit
     * @param {PolicyEngine} params.policy
     * @param {object} params.config - Config (liest config.security.approvalTtlMs)
     * @param {import('../Logger.js')} [params.logger]
     */
    constructor({ store, audit, policy, config, logger } = {}) {
        this.store = store;
        this.audit = audit;
        this.policy = policy;
        this.config = config;
        this.label = '[ApprovalService]';
        this.logger = logger || { log: () => { }, error: () => { } };
    }

    /** Liest die Approval-TTL aus der Config (Default 10 Minuten). */
    #ttlMs() {
        const ttl = this.config?.security?.approvalTtlMs;
        return Number.isFinite(ttl) && ttl > 0 ? ttl : 600000;
    }

    /** Liest das Pending-Aktions-Limit aus der Config (Default 20). */
    #maxPendingActions() {
        const m = this.config?.security?.maxPendingActions;
        return Number.isFinite(m) && m > 0 ? m : 20;
    }

    /**
     * Erzeugt eine PENDING_APPROVAL-Aktion (aus einem Tool-Call des LLM).
     * @param {{serverId: string, toolName: string, args?: object, reason?: string}} params
     * @returns {Promise<object>} die Aktion
     * @throws {Error} POLICY_DENIED
     */
    async propose({ serverId, toolName, args = {}, reason = '' }) {
        const policyResult = this.policy.evaluate(serverId, toolName, args);
        if (!policyResult.allowed) {
            this.logger.error(`${this.label} propose: durch Policy abgelehnt`, { serverId, toolName, reason: policyResult.reason });
            throw createError('POLICY_DENIED', policyResult.reason);
        }

        // Budget: maxPendingActions — wenn das Limit erreicht ist, wird die
        // älteste PENDING-Aktion abgebrochen (CANCELLED + Audit), bevor die
        // neue Aktion angelegt wird. Ein Eviction-Fehler darf den Propose
        // nicht blockieren (best-effort), wird aber geloggt.
        const maxPending = this.#maxPendingActions();
        const pending = await this.store.listPending();
        if (pending.length >= maxPending) {
            const oldest = pending[0];
            const cancelled = await this.store.transition(oldest.id, 'PENDING_APPROVAL', 'CANCELLED', {});
            if (cancelled !== null) {
                await this.#auditSafe('ACTION_CANCELLED', { reason: 'maxPendingActions limit erreicht' }, oldest.id);
                this.logger.log(`${this.label} propose: älteste PENDING-Aktion abgebrochen (Limit)`, { actionId: oldest.id, toolName: oldest.toolName });
            } else {
                this.logger.error(`${this.label} propose: Eviction fehlgeschlagen (Status-Wechsel abgelehnt)`, { actionId: oldest.id });
            }
        }

        const now = new Date();
        const action = {
            id: randomUUID(),
            userId: USER_ID,
            tenantId: TENANT_ID,
            toolName,
            serverId,
            arguments: args,
            payloadHash: createPayloadHash(USER_ID, TENANT_ID, toolName, args),
            status: 'PENDING_APPROVAL',
            reason: typeof reason === 'string' ? reason.slice(0, MAX_REASON_LENGTH) : '',
            expiresAt: new Date(now.getTime() + this.#ttlMs()).toISOString(),
            approvedBy: null,
            approvedAt: null,
            result: null,
            idempotencyKey: randomUUID(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
        };

        let created;
        try {
            created = await this.store.create(action);
        } catch (err) {
            this.logger.error(`${this.label} propose: store.create fehlgeschlagen`, { serverId, toolName, error: err.message });
            throw err;
        }
        try {
            await this.audit.log('ACTION_PROPOSED', { toolName, reason: created.reason }, created.id);
        } catch (err) {
            this.logger.error(`${this.label} propose: Audit-Eintrag fehlgeschlagen`, { actionId: created.id, error: err.message });
            throw err;
        }
        this.logger.log(`${this.label} propose: Aktion erstellt`, { actionId: created.id, toolName });
        return created;
    }

    /**
     * Genehmigt eine Aktion. Prüft: Existenz, Status, Ablauf, Hash-Integrität.
     * @param {string} actionId
     * @returns {Promise<object>} die APPROVED-Aktion
     * @throws {Error} ACTION_NOT_FOUND | INVALID_ACTION_STATE | APPROVAL_EXPIRED | INTEGRITY_FAILURE
     */
    async approve(actionId) {
        const action = await this.#getOrThrow(actionId);

        if (action.status !== 'PENDING_APPROVAL') {
            this.logger.error(`${this.label} approve: falscher Status`, { actionId, status: action.status });
            throw createError('INVALID_ACTION_STATE', `Aktion ${actionId} ist im Status ${action.status}, erwartet PENDING_APPROVAL`);
        }

        const now = new Date();
        if (new Date(action.expiresAt).getTime() < now.getTime()) {
            const expired = await this.#transitionOrThrow(actionId, 'PENDING_APPROVAL', 'EXPIRED', {});
            await this.#auditSafe('ACTION_EXPIRED', {}, actionId);
            this.logger.error(`${this.label} approve: Freigabe abgelaufen`, { actionId, expiresAt: expired.expiresAt });
            throw createError('APPROVAL_EXPIRED', `Freigabe für Aktion ${actionId} ist abgelaufen`);
        }

        const expectedHash = createPayloadHash(USER_ID, TENANT_ID, action.toolName, action.arguments);
        if (!safeEqualHex(expectedHash, action.payloadHash)) {
            await this.#auditSafe('INTEGRITY_FAILURE', { toolName: action.toolName }, actionId);
            this.logger.error(`${this.label} approve: Integritätsprüfung fehlgeschlagen`, { actionId, toolName: action.toolName });
            throw createError('INTEGRITY_FAILURE', `Payload-Hash von Aktion ${actionId} stimmt nicht mit den gespeicherten Parametern überein`);
        }

        const approved = await this.#transitionOrThrow(actionId, 'PENDING_APPROVAL', 'APPROVED', {
            approvedBy: USER_ID,
            approvedAt: now.toISOString(),
        });
        await this.audit.log('ACTION_APPROVED', {}, actionId);
        this.logger.log(`${this.label} approve: Aktion freigegeben`, { actionId });
        return approved;
    }

    /**
     * Lehnt eine Aktion ab.
     * @param {string} actionId
     * @param {string} [reason]
     * @returns {Promise<object>} die REJECTED-Aktion
     * @throws {Error} ACTION_NOT_FOUND | INVALID_ACTION_STATE
     */
    async reject(actionId, reason = '') {
        const action = await this.#getOrThrow(actionId);
        if (action.status !== 'PENDING_APPROVAL') {
            this.logger.error(`${this.label} reject: falscher Status`, { actionId, status: action.status });
            throw createError('INVALID_ACTION_STATE', `Aktion ${actionId} ist im Status ${action.status}, erwartet PENDING_APPROVAL`);
        }
        const rejected = await this.#transitionOrThrow(actionId, 'PENDING_APPROVAL', 'REJECTED', {});
        await this.audit.log('ACTION_REJECTED', { reason: typeof reason === 'string' ? reason.slice(0, MAX_REASON_LENGTH) : '' }, actionId);
        this.logger.log(`${this.label} reject: Aktion abgelehnt`, { actionId });
        return rejected;
    }

    /**
     * Bricht eine Aktion ab.
     * @param {string} actionId
     * @returns {Promise<object>} die CANCELLED-Aktion
     * @throws {Error} ACTION_NOT_FOUND | INVALID_ACTION_STATE
     */
    async cancel(actionId) {
        const action = await this.#getOrThrow(actionId);
        if (action.status !== 'PENDING_APPROVAL') {
            this.logger.error(`${this.label} cancel: falscher Status`, { actionId, status: action.status });
            throw createError('INVALID_ACTION_STATE', `Aktion ${actionId} ist im Status ${action.status}, erwartet PENDING_APPROVAL`);
        }
        const cancelled = await this.#transitionOrThrow(actionId, 'PENDING_APPROVAL', 'CANCELLED', {});
        await this.audit.log('ACTION_CANCELLED', {}, actionId);
        this.logger.log(`${this.label} cancel: Aktion abgebrochen`, { actionId });
        return cancelled;
    }

    /**
     * Lädt eine Aktion oder wirft ACTION_NOT_FOUND.
     * @param {string} actionId
     * @returns {Promise<object>}
     */
    async #getOrThrow(actionId) {
        const action = await this.store.get(actionId);
        if (action === null) {
            this.logger.error(`${this.label} Aktion nicht gefunden`, { actionId });
            throw createError('ACTION_NOT_FOUND', `Aktion ${actionId} nicht gefunden`);
        }
        return action;
    }

    /**
     * Führt einen Zustandsübergang aus oder wirft INVALID_ACTION_STATE.
     * @param {string} actionId
     * @param {string} fromStatus
     * @param {string} toStatus
     * @param {object} patch
     * @returns {Promise<object>}
     */
    async #transitionOrThrow(actionId, fromStatus, toStatus, patch) {
        const updated = await this.store.transition(actionId, fromStatus, toStatus, patch);
        if (updated === null) {
            this.logger.error(`${this.label} transition abgelehnt`, { actionId, fromStatus, toStatus });
            throw createError('INVALID_ACTION_STATE', `Zustandsübergang ${fromStatus} → ${toStatus} für Aktion ${actionId} abgelehnt`);
        }
        return updated;
    }

    /**
     * Audit-Eintrag schreiben; ein Audit-Fehler darf den Hauptfehler nicht verdecken.
     * @param {string} event
     * @param {object} metadata
     * @param {string} actionId
     */
    async #auditSafe(event, metadata, actionId) {
        try {
            await this.audit.log(event, metadata, actionId);
        } catch (err) {
            this.logger.error(`${this.label} Audit-Eintrag fehlgeschlagen`, { event, actionId, error: err.message });
        }
    }
}

export { ApprovalService };
