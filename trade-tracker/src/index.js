import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import LicenseGate from './license/LicenseGate';
import ErrorBoundary from './ErrorBoundary';

const container = document.getElementById('root');
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <ErrorBoundary name="Application">
      <LicenseGate>
        <App />
      </LicenseGate>
    </ErrorBoundary>
  </React.StrictMode>
);
