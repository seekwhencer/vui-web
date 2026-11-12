import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { approveAction, getAction, rejectAction } from '../api/actions.js';

const PENDING = 'PENDING_APPROVAL';

// Server-Status → i18n-Key unter `approval.result.*`
const STATUS_RESULT = {
  APPROVED: 'approved',
  COMPLETED: 'completed',
  EXECUTING: 'executing',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

/**
 * Ist eine Freigabe abgelaufen (expiresAt in der Vergangenheit)?
 * @param {{expiresAt?: string}} action
 * @param {number} [now] - Zeitstempel (ms), default: jetzt
 * @returns {boolean}
 */
export function isApprovalExpired(action, now = Date.now()) {
  if (!action || !action.expiresAt) return false;
  const ts = Date.parse(action.expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= now;
}

/**
 * Führt die Entscheidung aus: approve → POST /approve, reject → POST /reject.
 * @param {{id: string}} action
 * @param {'approve'|'reject'} decision
 * @returns {Promise<object>} die serverseitige Aktion nach dem Übergang
 */
export async function resolveApproval(action, decision) {
  if (decision === 'approve') return approveAction(action.id);
  return rejectAction(action.id);
}

function formatExpiry(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/**
 * Approval-Dialog (Zero-Trust): zeigt eine vorgeschlagene Aktion mit den
 * VOLLSTÄNDIGEN serverseitig gespeicherten Parametern (nicht einer
 * LLM-Darstellung) und lässt sie genehmigen oder ablehnen.
 *
 * Die Freigabe bindet sich serverseitig an den Hash der gespeicherten
 * Parameter — daher lädt der Dialog die kanonische Aktion vom Server
 * (GET /api/actions/:id) und fällt bei Fehlern auf die Payload-Daten zurück.
 *
 * Props:
 * - action  → { id, toolName, arguments, reason, expiresAt, status? }
 * - onClose → (id) => void, entfernt die Aktion aus dem Store
 */
export default function ApprovalDialog({ action, onClose }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState(action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Kanonische Aktion vom Server laden (gespeicherte Parameter + Status).
  useEffect(() => {
    let cancelled = false;
    getAction(action.id)
      .then((data) => {
        if (!cancelled && data && data.id) setStored(data);
      })
      .catch(() => {
        // Server nicht erreichbar → Payload-Daten behalten
      });
    return () => {
      cancelled = true;
    };
  }, [action.id]);

  const expired = isApprovalExpired(stored);
  const isPending = !stored.status || stored.status === PENDING;
  const resultKey = result ? result.key : (isPending ? null : STATUS_RESULT[stored.status] || null);

  const handleDecision = async (decision) => {
    setBusy(true);
    setError(null);
    try {
      const data = await resolveApproval(stored, decision);
      setResult({ key: decision === 'approve' ? 'approved' : 'rejected' });
      if (data && data.status) setStored((prev) => ({ ...prev, status: data.status }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval" role="dialog" aria-modal="true" aria-labelledby="approval-dialog-title">
      <div className="approval__backdrop" aria-hidden="true" />
      <div className="approval__card">
        <h3 id="approval-dialog-title" className="approval__title">{t('approval.title')}</h3>

        <dl className="approval__meta">
          <div className="approval__row">
            <dt className="approval__label">{t('approval.tool')}</dt>
            <dd className="approval__value approval__tool">{stored.toolName || '—'}</dd>
          </div>
          <div className="approval__row">
            <dt className="approval__label">{t('approval.reason')}</dt>
            <dd className="approval__value">{stored.reason || '—'}</dd>
          </div>
          <div className="approval__row">
            <dt className="approval__label">{t('approval.expires')}</dt>
            <dd className={`approval__value${expired ? ' approval__value--expired' : ''}`}>
              {expired ? t('approval.expired') : formatExpiry(stored.expiresAt)}
            </dd>
          </div>
        </dl>

        <div className="approval__params">
          <span className="approval__label">{t('approval.parameters')}</span>
          <pre className="approval__params-code">{JSON.stringify(stored.arguments ?? {}, null, 2)}</pre>
        </div>

        {error && (
          <p className="approval__error" role="alert">
            {error.message || String(error)}
          </p>
        )}
        {resultKey && (
          <p className={`approval__result approval__result--${resultKey}`} role="status">
            {t(`approval.result.${resultKey}`, { tool: stored.toolName || '' })}
          </p>
        )}

        <div className="approval__actions">
          {isPending ? (
            <>
              <button
                type="button"
                className="approval__btn approval__btn--reject"
                disabled={busy || expired}
                onClick={() => handleDecision('reject')}
              >
                {t('approval.reject')}
              </button>
              <button
                type="button"
                className="approval__btn approval__btn--approve"
                disabled={busy || expired}
                onClick={() => handleDecision('approve')}
              >
                {t('approval.approve')}
              </button>
            </>
          ) : (
            <button type="button" className="approval__btn approval__btn--close" onClick={() => onClose(action.id)}>
              {t('approval.close')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
