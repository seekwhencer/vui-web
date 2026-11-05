import { Navigate, Route, Routes } from 'react-router-dom';
import TranscriptionPage from './pages/TranscriptionPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import TopNav from './components/TopNav.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import LanguageSwitcher from './components/LanguageSwitcher.jsx';

export default function App() {
  return (
    <>
      <header className="topbar">
        <span className="topbar__brand">VUI</span>
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
