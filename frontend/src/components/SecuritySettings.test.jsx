import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('../api/settings.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import i18n from '../i18n.js';
import SecuritySettings, {
  SECURITY_FIELDS,
  buildSecurityPatch,
  extractSecurity,
  saveSecurityField,
} from './SecuritySettings.jsx';

const SECURITY = {
  maxToolTurns: 10,
  maxToolResultBytes: 65536,
  maxToolImageBytes: 2097152,
  toolTimeoutMs: 30000,
  maxPendingActions: 20,
  approvalTtlMs: 600000,
  systemPrompt: 'Be safe.',
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

describe('SECURITY_FIELDS', () => {
  it('enthält alle security.*-Felder inkl. maxToolImageBytes', () => {
    const keys = SECURITY_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      'maxToolTurns',
      'maxToolResultBytes',
      'maxToolImageBytes',
      'toolTimeoutMs',
      'maxPendingActions',
      'approvalTtlMs',
      'systemPrompt',
    ]);
  });
});

describe('buildSecurityPatch', () => {
  it('baut den Patch { security: { <feld>: value } }', () => {
    expect(buildSecurityPatch('maxToolImageBytes', 4194304)).toEqual({
      security: { maxToolImageBytes: 4194304 },
    });
    expect(buildSecurityPatch('systemPrompt', 'Be safe.')).toEqual({
      security: { systemPrompt: 'Be safe.' },
    });
  });
});

describe('extractSecurity', () => {
  it('liest die security.*-Werte aus der Settings-Antwort', () => {
    expect(extractSecurity({ security: SECURITY })).toEqual(SECURITY);
  });

  it('liefert {} bei fehlender/leerer security', () => {
    expect(extractSecurity({})).toEqual({});
    expect(extractSecurity(null)).toEqual({});
    expect(extractSecurity(undefined)).toEqual({});
  });
});

describe('saveSecurityField', () => {
  it('triggert updateSettings mit dem security-Patch', async () => {
    const save = vi.fn().mockResolvedValue({});
    await saveSecurityField('maxToolImageBytes', 4194304, save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ security: { maxToolImageBytes: 4194304 } });
  });

  it('gibt das Ergebnis des Savers weiter', async () => {
    const result = { ok: true };
    const save = vi.fn().mockResolvedValue(result);
    await expect(saveSecurityField('toolTimeoutMs', 60000, save)).resolves.toBe(result);
  });
});

describe('SecuritySettings (Rendering)', () => {
  it('zeigt alle Security-Felder mit ihren Werten', () => {
    const html = renderToString(<SecuritySettings security={SECURITY} />);

    expect(html).toContain('settings__grid');
    // Feldwerte sind im Markup.
    expect(html).toContain('value="10"');
    expect(html).toContain('value="65536"');
    expect(html).toContain('value="2097152"');
    expect(html).toContain('value="30000"');
    expect(html).toContain('value="20"');
    expect(html).toContain('value="600000"');
    // Textarea (systemPrompt) mit Inhalt.
    expect(html).toContain('Be safe.');
  });

  it('zeigt die Überschriften und den Hinweis', () => {
    const html = renderToString(<SecuritySettings security={SECURITY} />);

    expect(html).toContain('Security');
    expect(html).toContain('Changes apply immediately');
  });

  it('zeigt bei leerer security leere Eingabefelder', () => {
    const html = renderToString(<SecuritySettings security={{}} />);

    expect(html).toContain('settings__grid');
    // Number-Felder ohne Wert.
    expect(html).toContain('value=""');
  });
});

describe('SecuritySettings (i18n)', () => {
  it('löst die Strings auf Englisch auf', () => {
    const html = renderToString(<SecuritySettings security={SECURITY} />);
    expect(html).toContain('Max. tool rounds');
    expect(html).toContain('Max. image size (bytes)');
    expect(html).toContain('Security system prompt');
  });

  it('löst die Strings auf Deutsch auf', async () => {
    await i18n.changeLanguage('de');
    const html = renderToString(<SecuritySettings security={SECURITY} />);
    expect(html).toContain('Max. Tool-Runden');
    expect(html).toContain('Max. Bildgröße (Bytes)');
    expect(html).toContain('Security-System-Prompt');
  });

  it('löst die Strings auf Italienisch auf', async () => {
    await i18n.changeLanguage('it');
    const html = renderToString(<SecuritySettings security={SECURITY} />);
    expect(html).toContain('Max. roundate tool');
    expect(html).toContain('Max. dimensione immagine (byte)');
    expect(html).toContain('Prompt di sistema sicurezza');
  });
});
