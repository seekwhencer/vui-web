import { Navigate, Route, Routes } from 'react-router-dom';
import TranscriptionPage from './pages/TranscriptionPage.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import LanguageSwitcher from './components/LanguageSwitcher.jsx';

export default function App() {
  return (
    <>
      <div className="topbar">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
      <Routes>
        <Route path="/" element={<TranscriptionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
