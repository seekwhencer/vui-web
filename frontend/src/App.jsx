import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import TranscriptionPage from './pages/TranscriptionPage.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import LanguageSwitcher from './components/LanguageSwitcher.jsx';
import SettingsToggle from './components/SettingsToggle.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import useSettings from './hooks/useSettings.js';

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, saving, error, reload, save } = useSettings();

  return (
    <>
      <div className="topbar">
        <SettingsToggle onClick={() => setSettingsOpen((v) => !v)} active={settingsOpen} />
        <ThemeToggle />
        <LanguageSwitcher />
      </div>

      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true">
          <div className="settings-overlay__backdrop" onClick={() => setSettingsOpen(false)} />
          <SettingsPanel
            settings={settings}
            saving={saving}
            error={error}
            onSave={save}
            onClose={() => setSettingsOpen(false)}
          />
        </div>
      )}

      <Routes>
        <Route path="/" element={<TranscriptionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
