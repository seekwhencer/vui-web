import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import useSettings from '../hooks/useSettings.js';
import AppSettings from '../components/settings/AppSettings.jsx';
import AsrSettings from '../components/settings/AsrSettings.jsx';
import LlmSettings from '../components/settings/LlmSettings.jsx';
import UiSettings from '../components/settings/UiSettings.jsx';
import McpSettings from '../components/settings/McpSettings.jsx';

/**
 * Top-Kategorien der Settings-Seite.
 * - `subs` leer → keine Sub-Navigation (UI).
 * - `subs` gefüllt → Level-2-Tabs (App, ASR, LLM, MCP).
 * Reihenfolge = Anzeigereihenfolge.
 */
const CATEGORIES = [
  {
    id: 'app',
    title: 'settings.categories.app',
    subs: [
      { id: 'server', title: 'settings.sub.server' },
      { id: 'media', title: 'settings.sub.media' },
    ],
  },
  {
    id: 'asr',
    title: 'settings.categories.asr',
    subs: [
      { id: 'basic', title: 'settings.sections.basic' },
      { id: 'decoding', title: 'settings.sections.decoding' },
      { id: 'thresholds', title: 'settings.sections.thresholds' },
      { id: 'context', title: 'settings.sections.context' },
      { id: 'vad', title: 'settings.sections.vad' },
      { id: 'badwords', title: 'settings.sections.badwords' },
    ],
  },
  {
    id: 'llm',
    title: 'settings.categories.llm',
    subs: [
      { id: 'connection', title: 'settings.sub.connection' },
      { id: 'prompt', title: 'settings.sub.prompt' },
      { id: 'security', title: 'settings.sections.security' },
    ],
  },
  {
    id: 'mcp',
    title: 'settings.categories.mcp',
    subs: [
      { id: 'servers', title: 'settings.sub.servers' },
      { id: 'builtin', title: 'settings.sub.builtin' },
      { id: 'ssrf', title: 'settings.sub.ssrf' },
    ],
  },
  { id: 'ui', title: 'settings.categories.ui', subs: [] },
];

const DEFAULT_CATEGORY = 'asr';

export default function SettingsPage() {
  const { t } = useTranslation();
  const { category: categoryParam, sub: subParam } = useParams();
  const navigate = useNavigate();
  const { settings, saving, error, save } = useSettings();

  // Aktive Kategorie + Sub auflösen (Default: asr / erste Sub).
  const activeCategory =
    CATEGORIES.find((c) => c.id === categoryParam) ||
    CATEGORIES.find((c) => c.id === DEFAULT_CATEGORY);
  const activeSub = activeCategory.subs.length
    ? (activeCategory.subs.find((s) => s.id === subParam) || activeCategory.subs[0])
    : null;

  const [draft, setDraft] = useState(null); // { whisper, llm, badwords, whisperHost, whisperPort }
  const [saved, setSaved] = useState(false);
  // true → die nächste Settings-Änderung stammt von unserem eigenen Save
  // (Draft NICHT zurücksetzen, sonst verschwindet der "Gespeichert"-Hinweis).
  const skipInitRef = useRef(false);

  // Draft aus den Server-Settings initialisieren (bei jedem Öffnen/Reload).
  useEffect(() => {
    if (!settings) return;
    if (skipInitRef.current) {
      skipInitRef.current = false;
      return;
    }
    setDraft({
      whisper: { ...settings.whisper },
      llm: { ...(settings.llm || {}) },
      badwords: (settings.badwords || []).join('\n'),
      whisperHost: settings.whisperHost,
      whisperPort: settings.whisperPort,
    });
    setSaved(false);
  }, [settings]);

  /** Draft aktualisieren (funktionale oder Objekt-Updater). */
  const updateDraft = (updater) => {
    setSaved(false);
    setDraft((d) => (typeof updater === 'function' ? updater(d) : { ...d, ...updater }));
  };

  const handleSave = async () => {
    if (!draft) return;
    const patch = {
      whisper: { ...draft.whisper },
      llm: { ...draft.llm },
      badwords: draft.badwords
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      whisperHost: draft.whisperHost,
      whisperPort: draft.whisperPort,
    };
    try {
      skipInitRef.current = true; // eigenes Save → Draft-Init überspringen
      await save(patch);
      setSaved(true);
    } catch {
      // Fehler wird über `error` angezeigt
    }
  };

  const handleReset = () => {
    if (!settings) return;
    setSaved(false);
    setDraft({
      whisper: { ...settings.whisper },
      llm: { ...(settings.llm || {}) },
      badwords: (settings.badwords || []).join('\n'),
      whisperHost: settings.whisperHost,
      whisperPort: settings.whisperPort,
    });
  };

  const goCategory = (id) => navigate(`/settings/${id}`);
  const goSub = (catId, subId) => navigate(`/settings/${catId}/${subId}`);

  // Aktive Kategorie-Komponente rendern (jede rendert Body + Footer selbst).
  const renderCategory = () => {
    switch (activeCategory.id) {
      case 'app':
        return <AppSettings view={activeSub?.id} />;
      case 'ui':
        return <UiSettings />;
      case 'mcp':
        return <McpSettings view={activeSub?.id} />;
      case 'llm':
        return (
          <LlmSettings
            view={activeSub?.id}
            draft={draft}
            updateDraft={updateDraft}
            onSave={handleSave}
            onReset={handleReset}
            saving={saving}
            error={error}
            saved={saved}
            envLocked={settings?.envLocked}
          />
        );
      default: // asr
        return (
          <AsrSettings
            view={activeSub?.id}
            draft={draft}
            updateDraft={updateDraft}
            onSave={handleSave}
            onReset={handleReset}
            saving={saving}
            error={error}
            saved={saved}
            envLocked={settings?.envLocked}
          />
        );
    }
  };

  return (
    <div className="settings-page">
      <div className="settings">
        {/* Level 1: Kategorien */}
        <div className="settings__tabs" role="tablist" aria-label={t('settings.title')}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={activeCategory.id === cat.id}
              className={`settings__tab${activeCategory.id === cat.id ? ' settings__tab--active' : ''}`}
              onClick={() => goCategory(cat.id)}
            >
              {t(cat.title)}
            </button>
          ))}
        </div>

        {/* Level 2: Sub-Views (nur wenn die Kategorie Sub-Views hat) */}
        {activeCategory.subs.length > 0 && (
          <div
            className="settings__tabs settings__tabs--sub"
            role="tablist"
            aria-label={t(activeCategory.title)}
          >
            {activeCategory.subs.map((sub) => (
              <button
                key={sub.id}
                type="button"
                role="tab"
                aria-selected={activeSub?.id === sub.id}
                className={`settings__tab settings__tab--sub${activeSub?.id === sub.id ? ' settings__tab--active' : ''}`}
                onClick={() => goSub(activeCategory.id, sub.id)}
              >
                {t(sub.title)}
              </button>
            ))}
          </div>
        )}

        {renderCategory()}
      </div>
    </div>
  );
}
