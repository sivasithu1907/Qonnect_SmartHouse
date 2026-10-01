import {createRoot} from 'react-dom/client';
import App from './App';
import './index.css';
import { captureInstallPrompt, registerServiceWorker } from './lib/pwa';

// drop the ?retry=… marker added by the offline page's "Try again" link (keeps the #section link)
if (new URLSearchParams(window.location.search).has('retry')) {
  const u = new URL(window.location.href);
  u.searchParams.delete('retry');
  window.history.replaceState(null, '', u.pathname + u.search + u.hash);
}
captureInstallPrompt();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);
