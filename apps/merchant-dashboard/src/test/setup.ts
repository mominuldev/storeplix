import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// 4.7b: a present XSRF-TOKEN cookie means writes don't need a /sanctum/csrf-cookie round trip in tests.
document.cookie = 'XSRF-TOKEN=test-xsrf';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
