import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'vui:conversations';
const LEGACY_KEY = 'vui:chat-history';
const MAX_CONVERSATIONS = 50;

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch (_) {}
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function loadInitial() {
  // Neues Format: { conversations: [...], activeId }
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.conversations)) {
          return {
            conversations: parsed.conversations.slice(0, MAX_CONVERSATIONS),
            activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
          };
        }
      }
    }
  } catch (_) {}

  // Legacy-Format: flache Turn-Liste (neueste zuerst) → eine Konversation.
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const turns = parsed.slice().reverse();
          const conversation = {
            id: makeId(),
            title: turns[0].question || '',
            ts: turns.reduce((max, t) => Math.max(max, t.ts || 0), 0),
            turns,
          };
          localStorage.removeItem(LEGACY_KEY);
          return { conversations: [conversation], activeId: conversation.id };
        }
      }
    }
  } catch (_) {}

  return { conversations: [], activeId: null };
}

// Bilder sind session-only: localStorage hat ~5 MB Quota, ein einziges
// Base64-Bild sprengt das. persist() stript `images` aus den Turns; der
// In-Memory-State behält sie (Live-Anzeige bleibt, nach Reload weg).
function stripImages(state) {
  return {
    ...state,
    conversations: state.conversations.map((c) => ({
      ...c,
      turns: c.turns.map(({ images, ...rest }) => rest),
    })),
  };
}

function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stripImages(state)));
  } catch (_) {}
}

// Zustand + Store leben auf Modulebene, NICHT im Component-State. So werden
// Updates (z. B. das Finalisieren eines Turns nach `await run(...)`) auch dann
// in `localStorage` geschrieben, wenn die ChatPage in der Zeit unmounted wurde
// (Seitenwechsel während des Streams).
let state = loadInitial();

const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

function setState(next) {
  state = next;
  persist(state);
  emit();
}

function findConversation(id) {
  return state.conversations.find((c) => c.id === id) || null;
}

// Konversation anzeigen (id) oder keine anzeigen (null → neue Konversation).
function select(id) {
  if (id === null) {
    if (state.activeId === null) return;
    setState({ ...state, activeId: null });
    return;
  }
  if (!findConversation(id) || state.activeId === id) return;
  setState({ ...state, activeId: id });
}

// Neue Konversation starten: keine aktive Konversation → die nächste
// Nachricht legt eine neue an.
function startNew() {
  select(null);
}

// Turn in die aktive Konversation legen (oder eine neue anlegen).
// Liefert die Turn-ID zurück.
function addTurn({ question, pending }) {
  let conversation = findConversation(state.activeId);
  if (!conversation) {
    conversation = { id: makeId(), title: question, ts: Date.now(), turns: [] };
  }
  const turn = {
    id: makeId(),
    question,
    answer: null,
    thinking: null,
    error: null,
    tokens: null,
    model: null,
    ts: Date.now(),
    pending: pending ?? false,
  };
  const updated = {
    ...conversation,
    title: conversation.title || question,
    ts: Date.now(),
    turns: [...conversation.turns, turn],
  };
  const conversations = [
    updated,
    ...state.conversations.filter((c) => c.id !== conversation.id),
  ].slice(0, MAX_CONVERSATIONS);
  setState({ conversations, activeId: conversation.id });
  return turn.id;
}

// Turn in seiner Konversation aktualisieren (Turn-ID ist global eindeutig).
function updateTurn(turnId, patch) {
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (!conversation.turns.some((t) => t.id === turnId)) return conversation;
    changed = true;
    return {
      ...conversation,
      ts: Date.now(),
      turns: conversation.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t)),
    };
  });
  if (!changed) return;
  setState({ ...state, conversations });
}

function removeConversation(id) {
  const conversations = state.conversations.filter((c) => c.id !== id);
  const activeId = state.activeId === id ? null : state.activeId;
  setState({ conversations, activeId });
}

// Verwaiste "pending"-Turns (z. B. nach Reload/Abbruch) als abgeschlossen
// markieren — über alle Konversationen hinweg.
function finalizePending() {
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (!conversation.turns.some((t) => t.pending)) return conversation;
    changed = true;
    return {
      ...conversation,
      turns: conversation.turns.map((t) => (t.pending ? { ...t, pending: false } : t)),
    };
  });
  if (!changed) return;
  setState({ ...state, conversations });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

/**
 * Konversations-History-Hook.
 *
 * Verwaltet die letzten `MAX_CONVERSATIONS` Konversationen in `localStorage`
 * (Key: `vui:conversations`). Jede Konversation enthält ihre Turns
 * (älteste zuerst). API: `conversations`, `activeId`, `active`, `select`,
 * `startNew`, `addTurn`, `updateTurn`, `removeConversation`, `finalizePending`.
 *
 * Der Store lebt auf Modulebene, damit Updates auch nach einem Seitenwechsel
 * (Unmount der ChatPage) zuverlässig persistiert werden.
 */
export default function useConversation() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const active = snapshot.conversations.find((c) => c.id === snapshot.activeId) || null;
  return {
    conversations: snapshot.conversations,
    activeId: snapshot.activeId,
    active,
    select,
    startNew,
    addTurn,
    updateTurn,
    removeConversation,
    finalizePending,
  };
}

// Named-Exports (für Tests + direkte Nutzung ohne Hook).
export { addTurn, updateTurn, removeConversation, finalizePending, select, startNew, getSnapshot };
