import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// admin.{APP_HOSTNAME} is the platform console ('admin' is a reserved
// subdomain no tenant can claim — migration 002). Lazy so the console
// never ships in a tenant's bundle. Locally: admin.localhost:5173.
const isPlatformConsole = window.location.hostname.startsWith('admin.');
// The console isn't a tenant and isn't installable: drop the tenant
// manifest link so the browser doesn't fetch (and 404) it.
if (isPlatformConsole) {
  document.querySelector('link[rel="manifest"]')?.remove();
}
const PlatformApp = lazy(() => import('./platform/PlatformApp.jsx'));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isPlatformConsole ? (
      <Suspense fallback={null}>
        <PlatformApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
