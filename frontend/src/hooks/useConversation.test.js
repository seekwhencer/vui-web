import { describe, expect, it, vi, beforeEach } from 'vitest';

// Node-Testumgebung hat kein localStorage → Mock (persist() schreibt dorthin).
const storage = new Map();
vi.stubGlobal('localStorage', {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => {
    storage.set(key, String(value));
  },
  removeItem: (key) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
});

import {
  addTurn,
  updateTurn,
  removeConversation,
  getSnapshot,
} from './useConversation.js';

const STORAGE_KEY = 'vui:conversations';

function reset() {
  for (const c of getSnapshot().conversations) removeConversation(c.id);
  storage.clear();
}

beforeEach(() => {
  reset();
});

describe('updateTurn (images)', () => {
  it('updateTurn mit images → images im State', () => {
    const turnId = addTurn({ question: 'frage' });
    const images = [{ mimeType: 'image/png', data: 'aW1hZ2U=' }];

    updateTurn(turnId, { images });

    const turn = getSnapshot().conversations[0].turns.find((t) => t.id === turnId);
    expect(turn.images).toEqual(images);
  });
});

describe('persist (Bilder)', () => {
  it('localStorage-String enthält images (serverseitig persistiert, nicht gestrippt)', () => {
    const turnId = addTurn({ question: 'frage' });
    const images = [
      { id: 'abc-123', mimeType: 'image/png', url: '/api/media/abc-123', size: 123 },
    ];
    updateTurn(turnId, { images });

    const raw = storage.get(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(raw).toContain('images');

    const parsed = JSON.parse(raw);
    expect(parsed.conversations[0].turns[0].images).toEqual(images);
  });

  it('In-Memory-State behält images (Live-Anzeige bleibt)', () => {
    const turnId = addTurn({ question: 'frage' });
    const images = [{ mimeType: 'image/png', data: 'aW1hZ2U=' }];

    updateTurn(turnId, { images });

    const turn = getSnapshot().conversations[0].turns.find((t) => t.id === turnId);
    expect(turn.images).toEqual(images);
  });
});
