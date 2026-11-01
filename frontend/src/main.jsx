import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import './i18n.js';
import './style/index.css';

// Kein StrictMode: Die WebSocket-Verbindung in useTranscription ist ein Side-Effect.
// StrictMode (Dev) mountet zweimal und rückt den Cleanup zwischen die
// Verbindungen — die erste WS wird vor dem Establish geschlossen
// ("WebSocket is closed before the connection is established").
createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
