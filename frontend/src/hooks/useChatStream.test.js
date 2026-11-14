import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api/chat.js', () => ({
  chat: vi.fn(),
  chatStream: vi.fn(),
}));

import { chatStream } from '../api/chat.js';
import {
  run,
  addPendingApproval,
  clearPendingApproval,
  getPendingApprovals,
} from './useChatStream.js';

function sse(events) {
  return async function* () {
    for (const e of events) yield e;
  };
}

const APPROVAL_EVENT = {
  event: 'approval_required',
  data: {
    actionId: 'act-1',
    toolName: 'shell__run_command',
    arguments: { command: 'ls' },
    reason: 'Aufräumen',
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const a of getPendingApprovals()) clearPendingApproval(a.id);
});

describe('approval_required-Event (Store)', () => {
  it('legt eine pending Approval-Aktion im Store ab', async () => {
    chatStream.mockImplementation(sse([
      { event: 'thinking', data: 'denke nach' },
      { event: 'answer', data: 'AWAITING_APPROVAL' },
      APPROVAL_EVENT,
      { event: 'done', data: { tokens: null, model: null } },
    ]));

    const result = await run('frage', []);

    expect(result.error).toBeNull();
    const pending = getPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'act-1',
      toolName: 'shell__run_command',
      arguments: { command: 'ls' },
      reason: 'Aufräumen',
      expiresAt: '2099-01-01T00:00:00.000Z',
      status: 'PENDING_APPROVAL',
    });
  });

  it('approval_resolved entfernt die Aktion aus dem Store', async () => {
    addPendingApproval({
      id: 'act-2',
      toolName: 'files__write_file',
      arguments: {},
      reason: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
      status: 'PENDING_APPROVAL',
    });
    chatStream.mockImplementation(sse([
      { event: 'approval_resolved', data: { actionId: 'act-2' } },
      { event: 'done', data: {} },
    ]));

    await run('frage', []);

    expect(getPendingApprovals()).toHaveLength(0);
  });

  it('bestehende Event-Behandlung bleibt intakt (thinking/answer/done)', async () => {
    chatStream.mockImplementation(sse([
      { event: 'thinking', data: 'gedanken' },
      { event: 'answer', data: 'antwort' },
      { event: 'done', data: { tokens: { total: 5 }, model: 'm' } },
    ]));

    const result = await run('frage', []);

    expect(result.thinking).toBe('gedanken');
    expect(result.answer).toBe('antwort');
    expect(result.error).toBeNull();
    expect(getPendingApprovals()).toHaveLength(0);
  });
});

describe('tool_result-Event (images)', () => {
  it('tool_result mit images → result.images gefüllt', async () => {
    chatStream.mockImplementation(sse([
      {
        event: 'tool_result',
        data: {
          id: 'call-1',
          content: 'ok',
          isError: false,
          images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
        },
      },
      { event: 'answer', data: 'antwort' },
      { event: 'done', data: { tokens: null, model: null } },
    ]));

    const result = await run('frage', []);

    expect(result.error).toBeNull();
    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'aW1hZ2U=' }]);
  });

  it('tool_result ohne images → images bleibt []', async () => {
    chatStream.mockImplementation(sse([
      { event: 'tool_result', data: { id: 'call-1', content: 'ok', isError: false } },
      { event: 'answer', data: 'antwort' },
      { event: 'done', data: {} },
    ]));

    const result = await run('frage', []);

    expect(result.error).toBeNull();
    expect(result.images).toEqual([]);
  });

  it('mehrere tool_result-Events → images akkumulieren', async () => {
    chatStream.mockImplementation(sse([
      { event: 'tool_result', data: { id: 'call-1', content: 'a', images: [{ mimeType: 'image/png', data: 'x' }] } },
      { event: 'tool_result', data: { id: 'call-2', content: 'b', images: [{ mimeType: 'image/jpeg', data: 'y' }] } },
      { event: 'answer', data: 'antwort' },
      { event: 'done', data: {} },
    ]));

    const result = await run('frage', []);

    expect(result.images).toEqual([
      { mimeType: 'image/png', data: 'x' },
      { mimeType: 'image/jpeg', data: 'y' },
    ]);
  });

  it('doppelte Bilder (gleicher base64-Data) → nur einmal gesammelt (Dedup)', async () => {
    chatStream.mockImplementation(sse([
      { event: 'tool_result', data: { id: 'call-1', content: 'a', images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }] } },
      { event: 'tool_result', data: { id: 'call-2', content: 'b', images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }] } },
      { event: 'answer', data: 'antwort' },
      { event: 'done', data: {} },
    ]));

    const result = await run('frage', []);

    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'aW1hZ2U=' }]);
  });

  it('Tool-Loop: 4× dasselbe Bild → nur 1 Bild im Ergebnis', async () => {
    chatStream.mockImplementation(sse([
      { event: 'tool_result', data: { id: 'c1', content: 'a', images: [{ mimeType: 'image/png', data: 'SCREENSHOT' }] } },
      { event: 'tool_result', data: { id: 'c2', content: 'b', images: [{ mimeType: 'image/png', data: 'SCREENSHOT' }] } },
      { event: 'tool_result', data: { id: 'c3', content: 'c', images: [{ mimeType: 'image/png', data: 'SCREENSHOT' }] } },
      { event: 'tool_result', data: { id: 'c4', content: 'd', images: [{ mimeType: 'image/png', data: 'SCREENSHOT' }] } },
      { event: 'answer', data: 'fertig' },
      { event: 'done', data: {} },
    ]));

    const result = await run('frage', []);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toEqual({ mimeType: 'image/png', data: 'SCREENSHOT' });
  });
});

describe('Store-API', () => {
  it('addPendingApproval dedupliziert nach id (neueste Daten gewinnen)', () => {
    addPendingApproval({ id: 'a', toolName: 't1' });
    addPendingApproval({ id: 'a', toolName: 't2' });
    addPendingApproval({ id: 'b', toolName: 't3' });

    expect(getPendingApprovals()).toHaveLength(2);
    expect(getPendingApprovals().map((x) => x.id)).toEqual(['a', 'b']);
    expect(getPendingApprovals()[0].toolName).toBe('t2');
  });

  it('clearPendingApproval entfernt nur die gegebene id', () => {
    addPendingApproval({ id: 'a' });
    addPendingApproval({ id: 'b' });

    clearPendingApproval('a');

    expect(getPendingApprovals().map((x) => x.id)).toEqual(['b']);
  });

  it('clearPendingApproval mit unbekannter id ist ein No-op', () => {
    addPendingApproval({ id: 'a' });

    clearPendingApproval('unknown');

    expect(getPendingApprovals()).toHaveLength(1);
  });
});
