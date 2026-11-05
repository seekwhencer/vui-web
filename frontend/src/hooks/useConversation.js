import { useCallback, useState } from 'react';

const STORAGE_KEY = 'vui:chat-history';
const MAX_ITEMS = 20;

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch (_) {}
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function loadInitial() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

/**
 * Chat-History-Hook.
 *
 * Verwaltet die letzten `MAX_ITEMS` Konversationen in `localStorage`
 * (Key: `vui:chat-history`). API: `items`, `add`, `update`, `remove`, `clear`.
 */
export default function useConversation() {
  const [items, setItems] = useState(loadInitial);

  const add = useCallback(({ question, answer, thinking, error, ts, pending }) => {
    const id = makeId();
    setItems((prev) => {
      const next = [
        {
          id,
          question,
          answer: answer ?? null,
          thinking: thinking ?? null,
          error: error ?? null,
          ts: ts ?? Date.now(),
          pending: pending ?? false,
        },
        ...prev,
      ].slice(0, MAX_ITEMS);

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (_) {}

      return next;
    });

    return id;
  }, []);

  const update = useCallback((id, patch) => {
    setItems((prev) => {
      const next = prev.map((item) => (item.id === id ? { ...item, ...patch } : item));

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (_) {}

      return next;
    });
  }, []);

  const remove = useCallback((id) => {
    setItems((prev) => {
      const next = prev.filter((item) => item.id !== id);

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (_) {}

      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }, []);

  return { items, add, update, remove, clear };
}
