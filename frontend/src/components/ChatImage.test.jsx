import { describe, expect, it, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

import i18n from '../i18n.js';
import ChatImage, { buildDataUrl } from './ChatImage.jsx';

const IMAGE = { mimeType: 'image/png', data: 'aW1hZ2U=' };

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('buildDataUrl', () => {
  it('baut eine data:-URL aus MIME-Type und Base64-Daten', () => {
    expect(buildDataUrl('image/png', 'aW1hZ2U=')).toBe('data:image/png;base64,aW1hZ2U=');
    expect(buildDataUrl('image/jpeg', 'x')).toBe('data:image/jpeg;base64,x');
  });
});

describe('ChatImage (Rendering)', () => {
  it('rendert ein <img> mit data-URL, Alt-Text und lazy loading', () => {
    const html = renderToString(<ChatImage {...IMAGE} onOpen={() => {}} />);

    expect(html).toContain('<img');
    expect(html).toContain('class="msg__image"');
    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
    expect(html).toContain('alt="Image from tool result"');
    expect(html).toContain('loading="lazy"');
  });

  it('nutzt den mitgegebenen Alt-Text', () => {
    const html = renderToString(<ChatImage {...IMAGE} alt="custom" />);

    expect(html).toContain('alt="custom"');
  });

  it('rendert die Fehler-Fallback-Box statt <img>', () => {
    const html = renderToString(<ChatImage {...IMAGE} failed />);

    expect(html).toContain('msg__image--error');
    expect(html).toContain('Image could not be loaded.');
    expect(html).not.toContain('<img');
  });
});

describe('ChatImage (i18n)', () => {
  it('löst Alt-Text und Fehlermeldung auf Deutsch auf', async () => {
    await i18n.changeLanguage('de');

    const img = renderToString(<ChatImage {...IMAGE} />);
    expect(img).toContain('alt="Bild aus Tool-Ergebnis"');

    const failed = renderToString(<ChatImage {...IMAGE} failed />);
    expect(failed).toContain('Bild konnte nicht geladen werden.');
  });

  it('löst Alt-Text und Fehlermeldung auf Italienisch auf', async () => {
    await i18n.changeLanguage('it');

    const img = renderToString(<ChatImage {...IMAGE} />);
    expect(img).toContain('alt="Immagine dal risultato dello strumento"');

    const failed = renderToString(<ChatImage {...IMAGE} failed />);
    // React escapet Apostrophe im HTML zu &#x27; — daher Teilstring prüfen.
    expect(failed).toContain('Impossibile caricare');
    expect(failed).toContain('immagine.');
  });
});
