import {createRoot} from 'react-dom/client';
import App from './App';
import './index.css';
import { captureInstallPrompt, registerServiceWorker } from './lib/pwa';

captureInstallPrompt();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);
