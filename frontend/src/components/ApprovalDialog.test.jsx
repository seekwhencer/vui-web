import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('../api/actions.js', () => ({
  getPendingActions: vi.fn(),
  getAction: vi.fn(),
  approveAction: vi.fn(),
  rejectAction: vi.fn(),
  cancelAction: vi.fn(),
}));

import i18n from '../i18n.js';
import * as actionsApi from '../api/actions.js';
import ApprovalDialog, { isApprovalExpired, resolveApproval } from './ApprovalDialog.jsx';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function makeAction(overrides = {}) {
  return {
    id: 'act-1',
    toolName: 'shell__run_command',
    arguments: { command: 'rm -rf /tmp/x' },
    reason: 'Aufräumen',
    expiresAt: FUTURE,
    status: 'PENDING_APPROVAL',
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('de');
  actionsApi.getAction.mockResolvedValue(makeAction());
});

describe('isApprovalExpired', () => {
  it('vergangenes expiresAt → true', () => {
    expect(isApprovalExpired({ expiresAt: PAST })).toBe(true);
  });

  it('zukünftiges expiresAt → false', () => {
    expect(isApprovalExpired({ expiresAt: FUTURE })).toBe(false);
  });

  it('fehlendes oder ungültiges expiresAt → false', () => {
    expect(isApprovalExpired({})).toBe(false);
    expect(isApprovalExpired(null)).toBe(false);
    expect(isApprovalExpired({ expiresAt: 'kein-datum' })).toBe(false);
  });
});

describe('ApprovalDialog (Rendering)', () => {
  it('zeigt Tool, vollständige Parameter, Begründung und Ablaufzeit', () => {
    const html = renderToString(<ApprovalDialog action={makeAction()} onClose={() => {}} />);

    expect(html).toContain('shell__run_command');
    expect(html).toContain('rm -rf /tmp/x');
    expect(html).toContain('Aufräumen');
    expect(html).toContain('approval__params-code');
  });

  it('zeigt die Buttons "Ablehnen" und "Genehmigen" (aktiv)', () => {
    const html = renderToString(<ApprovalDialog action={makeAction()} onClose={() => {}} />);

    expect(html).toContain('Ablehnen');
    expect(html).toContain('Genehmigen');
    expect(html).toContain('approval__btn--reject');
    expect(html).toContain('approval__btn--approve');
    expect(html).not.toContain('disabled');
  });

  it('abgelaufene Aktion: "Abgelaufen" anzeigen + Buttons deaktiviert', () => {
    const html = renderToString(
      <ApprovalDialog action={makeAction({ expiresAt: PAST })} onClose={() => {}} />
    );

    expect(html).toContain('Abgelaufen');
    expect(html).toContain('approval__value--expired');
    expect(html).toContain('approval__btn--reject');
    expect(html).toContain('approval__btn--approve');
    expect(html).toContain('disabled');
  });

  it('bereits genehmigte Aktion: Ergebnis + Schließen, keine Decision-Buttons', () => {
    const html = renderToString(
      <ApprovalDialog action={makeAction({ status: 'APPROVED' })} onClose={() => {}} />
    );

    expect(html).toContain('Aktion genehmigt');
    expect(html).toContain('approval__btn--close');
    expect(html).not.toContain('approval__btn--approve');
    expect(html).not.toContain('approval__btn--reject');
  });

  it('abgelehnte Aktion: Ergebnis "Aktion abgelehnt"', () => {
    const html = renderToString(
      <ApprovalDialog action={makeAction({ status: 'REJECTED' })} onClose={() => {}} />
    );

    expect(html).toContain('Aktion abgelehnt');
  });

  it('leere Parameter → "{}"', () => {
    const html = renderToString(
      <ApprovalDialog action={makeAction({ arguments: undefined })} onClose={() => {}} />
    );

    expect(html).toContain('{}');
  });

  it('hat Dialog-Semantik (role=dialog, aria-modal)', () => {
    const html = renderToString(<ApprovalDialog action={makeAction()} onClose={() => {}} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });
});

describe('resolveApproval (Button-Wiring)', () => {
  it('approve → approveAction(id) aufrufen', async () => {
    actionsApi.approveAction.mockResolvedValue({ id: 'act-1', status: 'APPROVED' });

    const result = await resolveApproval({ id: 'act-1' }, 'approve');

    expect(actionsApi.approveAction).toHaveBeenCalledTimes(1);
    expect(actionsApi.approveAction).toHaveBeenCalledWith('act-1');
    expect(actionsApi.rejectAction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'act-1', status: 'APPROVED' });
  });

  it('reject → rejectAction(id) aufrufen', async () => {
    actionsApi.rejectAction.mockResolvedValue({ id: 'act-1', status: 'REJECTED' });

    const result = await resolveApproval({ id: 'act-1' }, 'reject');

    expect(actionsApi.rejectAction).toHaveBeenCalledTimes(1);
    expect(actionsApi.rejectAction).toHaveBeenCalledWith('act-1');
    expect(actionsApi.approveAction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'act-1', status: 'REJECTED' });
  });

  it('API-Fehler → Fehler weiterwerfen (Dialog bleibt offen)', async () => {
    actionsApi.approveAction.mockRejectedValue(Object.assign(new Error('APPROVAL_EXPIRED'), { status: 410 }));

    await expect(resolveApproval({ id: 'act-1' }, 'approve')).rejects.toThrow('APPROVAL_EXPIRED');
  });
});
