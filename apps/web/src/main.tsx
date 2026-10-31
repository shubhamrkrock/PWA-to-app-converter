import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { configured } from './env.ts';
import { AppProvider } from './session.tsx';
import { App } from './App.tsx';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    {configured ? (
      <AppProvider>
        <App />
      </AppProvider>
    ) : (
      <main className="signin">
        <h1>Git2App</h1>
        <p className="note note-error">
          This copy of the dashboard is not set up yet. It needs VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_API_ORIGIN at build time (see docs/SETUP.md).
        </p>
      </main>
    )}
  </StrictMode>,
);
