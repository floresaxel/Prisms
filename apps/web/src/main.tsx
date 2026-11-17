// FIRST, before anything else is evaluated: start opening the remembered
// account's local database (see the module for why the order matters).
import './early-open';

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
import { reloadWhenUpdated } from './sw-update';

// The shell comes from the service worker's cache, so a rebuilt app shows its
// previous build once; this swaps to the new one as soon as it has installed.
reloadWhenUpdated();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
