import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Brand type, bundled (no font CDN: local-first, and the CSP is font-src 'self').
// Each stylesheet declares every subset with a unicode-range, so the browser
// only fetches the files for scripts actually on screen.
import '@fontsource-variable/inter/wght.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@prisms/ui/theme.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
