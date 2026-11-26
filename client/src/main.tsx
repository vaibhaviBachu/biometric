// First: some browsers throw on any read of localStorage. Swap in a fallback
// before any module below gets a chance to touch it during render.
import './lib/storage-fallback';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { AuthProvider } from './context/AuthContext';
import { warmBackend } from './lib/auth';
import { watchForNewBuild } from './lib/new-build-check';
import { DnaBackdrop } from './components/dna/DnaBackdrop';
import './index.css';
import './styles/theme.css';
import './styles/floating-glass.css';
import './styles/premium-motion.css';
import './styles/dashboard-frame.css';
import './styles/sidebar-glass.css';
// Last on purpose: Forest Glass — colours, backgrounds, borders and fonts over everything above (both themes).
import './styles/forest-glass.css';
// PINITHUB palette: Warm Sand (chosen 2026-11-18), on top of the Forest base structure. <html data-palette="warm-sand"> in index.html.
import './styles/warm-sand.css';
// Trial palette (2026-11-19): Navy & Copper. Default while on trial; Warm Sand via ?palette=warm-sand (index.html).
import './styles/navy-copper.css';
import './styles/arctic-harbor.css';

// The browser talks only to the PINIT-DNA backend API. There used to be a Supabase connectivity
// ping here; it did nothing for the app and printed the project URL to the console.

// A deploy replaces the hashed files that a page which is already open still asks for, and the next lazy load of
// one fails with "Failed to fetch dynamically imported module". The first miss reloads onto the new build; the
// one-minute guard stops a reload loop if a file is genuinely missing.
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('pinit_chunk_reload') ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('pinit_chunk_reload', String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// Wake the Render free-tier backend as early as possible (it sleeps when idle),
// so it's ready by the time the registration/login flow finishes.
warmBackend();

// Open tabs move onto a new deploy at the next page change or when the tab is shown again.
watchForNewBuild(router);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DnaBackdrop router={router} />
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>
);
