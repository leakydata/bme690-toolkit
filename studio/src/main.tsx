import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'uplot/dist/uPlot.min.css';
import './ui/styles.css';
import './plugins/index.ts';
import { App } from './app/App.tsx';
import { StudioProvider } from './app/state.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StudioProvider>
      <App />
    </StudioProvider>
  </StrictMode>,
);
