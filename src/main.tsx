import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Safety handler for network drops and harmless third-party script rejections
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const msg = String(event.reason?.message || event.reason || '');
    if (msg.includes('offline') || msg.includes('Could not reach Cloud Firestore') || msg.includes('network')) {
      event.preventDefault();
      console.warn('[NetworkGuard] Harmless offline event intercepted:', msg);
    }
  });
}

createRoot(document.getElementById('root')!).render(<App />);
