import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

// useChatStream ist ein modulebener Store mit useSyncExternalStore —
// für SSR-Tests (renderToString) wird er gemockt. Das echte Store-Verhalten
// (images-Akkumulation) ist in useChatStream.test.js abgedeckt.
const { mockStream } = vi.hoisted(() => ({
  mockStream: {
    pendingApprovals: [],
    clearPendingApproval: () => {},
    images: [],
  },
}));

vi.mock('../hooks/useChatStream.js', () => ({
  default: () => mockStream,
}));

vi.mock('../api/actions.js', () => ({
  getPendingActions: vi.fn(),
  getAction: vi.fn(),
  approveAction: vi.fn(),
  rejectAction: vi.fn(),
  cancelAction: vi.fn(),
}));

import i18n from '../i18n.js';
import ChatView from './ChatView.jsx';
import ImageLightbox, { isEscapeKey } from './ImageLightbox.jsx';

const IMAGE = { mimeType: 'image/png', data: 'aW1hZ2U=' };

beforeEach(async () => {
  mockStream.pendingApprovals = [];
  mockStream.images = [];
  await i18n.changeLanguage('en');
});

describe('ChatView (Bilder)', () => {
  it('rendert <img> für einen gespeicherten Turn mit images', () => {
    const items = [{ id: 't1', question: 'q', answer: 'a', images: [IMAGE] }];
    const html = renderToString(
      <ChatView items={items} thinking="" answer="" error={null} conversationId="c1" />
    );

    expect(html).toContain('msg__images');
    expect(html).toContain('<img');
    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
  });

  it('rendert <img> für den Live-Turn aus dem Stream-Store', () => {
    mockStream.images = [IMAGE];
    const items = [{ id: 't1', question: 'q', pending: true }];
    const html = renderToString(
      <ChatView items={items} thinking="" answer="a" error={null} conversationId="c1" />
    );

    expect(html).toContain('msg__images');
    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
  });

  it('rendert mehrere Bilder eines Turns', () => {
    const items = [
      {
        id: 't1',
        question: 'q',
        answer: 'a',
        images: [IMAGE, { mimeType: 'image/jpeg', data: 'eA==' }],
      },
    ];
    const html = renderToString(
      <ChatView items={items} thinking="" answer="" error={null} conversationId="c1" />
    );

    const count = (html.match(/class="msg__image"/g) || []).length;
    expect(count).toBe(2);
  });

  it('rendert ohne images keinen Bild-Block', () => {
    const items = [{ id: 't1', question: 'q', answer: 'a' }];
    const html = renderToString(
      <ChatView items={items} thinking="" answer="" error={null} conversationId="c1" />
    );

    expect(html).not.toContain('msg__images');
    expect(html).not.toContain('<img');
  });

  it('zeigt Bilder auch ohne Antwort-Text (nur Tool-Ergebnis)', () => {
    const items = [{ id: 't1', question: 'q', images: [IMAGE] }];
    const html = renderToString(
      <ChatView items={items} thinking="" answer="" error={null} conversationId="c1" />
    );

    expect(html).toContain('msg__images');
    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
  });

  it('leerer Chat bleibt intakt (Regression)', () => {
    const html = renderToString(
      <ChatView items={[]} thinking="" answer="" error={null} conversationId="c1" />
    );

    expect(html).toContain('chat-view__empty');
    expect(html).toContain('No messages yet');
  });
});

describe('ImageLightbox (Rendering)', () => {
  it('rendert Overlay, Bild und Close-Button bei aktivem Bild', () => {
    const html = renderToString(<ImageLightbox image={IMAGE} onClose={() => {}} />);

    expect(html).toContain('class="lightbox"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('<img');
    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
    expect(html).toContain('lightbox__close');
    expect(html).toContain('aria-label="Close"');
  });

  it('löst den Close-Button-Label auf Deutsch auf', async () => {
    await i18n.changeLanguage('de');
    const html = renderToString(<ImageLightbox image={IMAGE} onClose={() => {}} />);

    expect(html).toContain('aria-label="Schließen"');
  });

  it('rendert nichts, wenn kein Bild aktiv ist', () => {
    const html = renderToString(<ImageLightbox image={null} onClose={() => {}} />);

    expect(html).toBe('');
  });
});

describe('isEscapeKey', () => {
  it('erkennt nur die Escape-Taste', () => {
    expect(isEscapeKey({ key: 'Escape' })).toBe(true);
    expect(isEscapeKey({ key: 'Enter' })).toBe(false);
    expect(isEscapeKey({ key: 'e' })).toBe(false);
    expect(isEscapeKey(null)).toBe(false);
    expect(isEscapeKey(undefined)).toBe(false);
  });
});
