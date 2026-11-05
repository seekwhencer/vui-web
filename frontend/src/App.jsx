import { useEffect } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import TranscriptionPage from './pages/TranscriptionPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import TopNav from './components/TopNav.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import LanguageSwitcher from './components/LanguageSwitcher.jsx';
import { useAppSettings } from './services/appSettings';
import { applyPrimaryHue } from './utils/primaryColor';
import { applyRadiusFactor } from './utils/radius';

export default function App() {
  const { primaryHue, radiusFactor } = useAppSettings();

  // Primärfarbe: ersetzt :root --color-primary (Sättigung + Helligkeit fix).
  useEffect(() => {
    applyPrimaryHue(primaryHue);
  }, [primaryHue]);

  // Roundness: ersetzt :root --radius-factor (alle --radius-* folgen).
  useEffect(() => {
    applyRadiusFactor(radiusFactor);
  }, [radiusFactor]);

  return (
    <>
      <header className="topbar">
        <Link to="/about" className="topbar__brand">VUI</Link>
        <TopNav />
        <div className="topbar__actions">
          <ThemeToggle />
          <LanguageSwitcher />
        </div>
      </header>

      <Routes>
        <Route path="/" element={<TranscriptionPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
