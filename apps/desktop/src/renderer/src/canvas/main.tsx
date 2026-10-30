import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/style.css';
import { ErrorBoundary } from '../error-boundary';
import { CanvasApp } from './CanvasApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <CanvasApp />
    </ErrorBoundary>
  </StrictMode>,
);
