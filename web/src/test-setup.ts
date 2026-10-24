import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Lazy routes import on first use; under a full parallel run that can exceed the 1 s default.
configure({ asyncUtilTimeout: 4000 });
afterEach(() => { cleanup(); try { globalThis.localStorage?.clear?.(); } catch { /* no storage in this jsdom origin */ } });
