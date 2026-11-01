import { Navigate, Route, Routes } from 'react-router-dom';
import TranscriptionPage from './pages/TranscriptionPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<TranscriptionPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
