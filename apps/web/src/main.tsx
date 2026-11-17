import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

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
