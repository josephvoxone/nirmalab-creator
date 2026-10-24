// glass.css first, before any component pulls in its own CSS: it declares the cascade-layer
// order (legacy page CSS sits between Tailwind's preflight and its utilities), and layer
// order is fixed by first appearance.
import './styles/glass.css';
import './styles/tokens.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
