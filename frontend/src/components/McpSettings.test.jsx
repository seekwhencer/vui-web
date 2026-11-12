import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('../api/settings.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../api/mcp.js', () => ({
  listMcpServers: vi.fn(),
  addMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  reconnectMcpServer: vi.fn(),
  listMcpTools: vi.fn(),
  getMcpCapability: vi.fn().mockResolvedValue({ toolSupport: true }),
}));

import i18n from '../i18n.js';
import McpSettings, {
  POLICY_OPTIONS,
  policyKey,
  parseHosts,
  matchesToolFilter,
} from './McpSettings.jsx';

const SERVERS = [
  { id: 'weather', name: 'Weather', status: 'connected', enabled: true, url: 'http://weather/mcp', toolCount: 2 },
  { id: 'shell', name: 'Shell', status: 'connected', enabled: true, url: 'http://shell/mcp', toolCount: 1 },
];
const TOOLS = {
  weather: [{ name: 'get_forecast' }, { name: 'set_forecast' }],
  shell: [{ name: 'run_command' }],
};
// weather__set_forecast ist bewusst NICHT gesetzt → deny-by-default.
const POLICIES = {
  'weather__get_forecast': 'read',
  'shell__run_command': 'execute',
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

describe('policyKey', () => {
  it('nutzt den Server-Namespace `${serverId}__${toolName}` (doppelter Unterstrich)', () => {
    expect(policyKey('weather', 'get_forecast')).toBe('weather__get_forecast');
    expect(policyKey('shell', 'run_command')).toBe('shell__run_command');
  });
});

describe('POLICY_OPTIONS', () => {
  it('enthält genau read|write|execute|deny', () => {
    expect(POLICY_OPTIONS).toEqual(['read', 'write', 'execute', 'deny']);
  });
});

describe('parseHosts (SSRF-Whitelist)', () => {
  it('zerlegt eine Komma-Liste in Hostnamen', () => {
    expect(parseHosts('a.home, b.home')).toEqual(['a.home', 'b.home']);
  });

  it('filtert leere Einträge', () => {
    expect(parseHosts('a.home, , b.home,')).toEqual(['a.home', 'b.home']);
  });

  it('liefert [] für leere/ungültige Eingabe', () => {
    expect(parseHosts('')).toEqual([]);
    expect(parseHosts(null)).toEqual([]);
    expect(parseHosts(undefined)).toEqual([]);
  });
});

describe('matchesToolFilter (Tool-Filter)', () => {
  const NO_FILTER = { policy: null, keyword: '' };
  const TOOL = { name: 'get_forecast', description: 'Fetch weather forecast' };

  it('lässt ohne Filter alles durch', () => {
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, NO_FILTER)).toBe(true);
  });

  it('filtert nach gesetzter Policy', () => {
    // weather__get_forecast = read → matcht read, nicht write.
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, { policy: 'read', keyword: '' })).toBe(true);
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, { policy: 'write', keyword: '' })).toBe(false);
  });

  it('nutzt deny-by-default für nicht gesetzte Tools', () => {
    // weather__set_forecast nicht gesetzt → effective deny.
    const t2 = { name: 'set_forecast' };
    expect(matchesToolFilter(t2, 'weather', POLICIES, { policy: 'deny', keyword: '' })).toBe(true);
    expect(matchesToolFilter(t2, 'weather', POLICIES, { policy: 'read', keyword: '' })).toBe(false);
  });

  it('matcht Stichwort case-insensitiv auf Name + Beschreibung', () => {
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, { policy: null, keyword: 'FORECAST' })).toBe(true);
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, { policy: null, keyword: 'weather' })).toBe(true);
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, { policy: null, keyword: 'xyz' })).toBe(false);
  });

  it('kombiniert Policy + Stichwort (UND)', () => {
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, { policy: 'read', keyword: 'forecast' })).toBe(true);
    expect(matchesToolFilter(TOOL, 'weather', POLICIES, { policy: 'write', keyword: 'forecast' })).toBe(false);
  });
});

describe('McpSettings (Rendering: Tool-Filter)', () => {
  it('zeigt Policy-Buttons, Stichwort-Feld und Reset-Button', () => {
    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    expect(html).toContain('mcp__tool-filter');
    expect(html).toContain('mcp__tool-filter-policies');
    expect(html).toContain('mcp__tool-filter-input');
    // Vier Policy-Buttons (aria-pressed) + Reset-Button.
    expect((html.match(/aria-pressed=/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('Reset filter');
  });
});

describe('McpSettings (Rendering: Tool-Policies)', () => {
  it('listet die Tools der MCP-Server mit Policy-Dropdowns', () => {
    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    expect(html).toContain('mcp__tools');
    expect(html).toContain('mcp__tool');
    expect(html).toContain('get_forecast');
    expect(html).toContain('set_forecast');
    expect(html).toContain('run_command');
    // Pro Tool ein <select> mit den vier Optionen.
    expect(html).toContain('<select');
    expect(html).toContain('value="read"');
    expect(html).toContain('value="write"');
    expect(html).toContain('value="execute"');
    expect(html).toContain('value="deny"');
  });

  it('zeigt gesetzte Policies als ausgewählten Wert', () => {
    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    // weather__get_forecast → read, shell__run_command → execute.
    expect(html).toContain('value="read"');
    expect(html).toContain('value="execute"');
  });

  it('markiert nicht gesetzte Tools als "deny (Default)"', () => {
    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    // weather__set_forecast ist nicht gesetzt → Default-Marker + Wert deny.
    expect(html).toContain('mcp__policy-default');
    expect(html).toContain('deny (Default)');
    expect(html).toContain('value="deny"');
  });

  it('zeigt bei leeren Policies alle Tools als Default', () => {
    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={{}} />
    );

    // 3 Tools → 3 Default-Marker.
    const count = (html.match(/mcp__policy-default/g) || []).length;
    expect(count).toBe(3);
  });

  it('zeigt den deny-by-default-Hinweis', () => {
    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    expect(html).toContain('mcp__policy-hint');
    expect(html).toContain('Unset tools are denied by default (deny-by-default).');
  });
});

describe('McpSettings (Rendering: SSRF-Allowlist)', () => {
  it('zeigt die SSRF-Whitelist-Sektion mit Eingabefeld', () => {
    const html = renderToString(
      <McpSettings
        servers={SERVERS}
        tools={TOOLS}
        policies={POLICIES}
        allowedHosts={['sync.gitea.home']}
      />
    );

    expect(html).toContain('mcp__ssrf');
    expect(html).toContain('SSRF Allowlist');
    expect(html).toContain('Allowed hosts');
    // Der übergebene Host ist im Eingabefeld.
    expect(html).toContain('sync.gitea.home');
  });
});

describe('McpSettings (i18n)', () => {
  it('löst die Strings auf Englisch auf', () => {
    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    expect(html).toContain('Policy');
    expect(html).toContain('Read');
    expect(html).toContain('Write');
    expect(html).toContain('Execute');
    expect(html).toContain('Deny');
    expect(html).toContain('deny (Default)');
  });

  it('löst die Strings auf Deutsch auf', async () => {
    await i18n.changeLanguage('de');

    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    expect(html).toContain('Lesen');
    expect(html).toContain('Schreiben');
    expect(html).toContain('Ausführen');
    expect(html).toContain('Verweigern');
    expect(html).toContain('deny (Standard)');
  });

  it('löst die Strings auf Italienisch auf', async () => {
    await i18n.changeLanguage('it');

    const html = renderToString(
      <McpSettings servers={SERVERS} tools={TOOLS} policies={POLICIES} />
    );

    expect(html).toContain('Lettura');
    expect(html).toContain('Scrittura');
    expect(html).toContain('Esegui');
    expect(html).toContain('Nega');
    expect(html).toContain('deny (Predefinito)');
  });
});
