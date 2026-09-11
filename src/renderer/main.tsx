import { createRoot } from 'react-dom/client';
import '@/styles/global.css';
import { App } from '@/App';
import { useApp } from '@/state/store';

// Exposed for the screenshot harness and DevTools. The preload bridge is still the only way to main.
Object.assign(window, { __xiptv: useApp });

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from index.html');

createRoot(host).render(<App />);
