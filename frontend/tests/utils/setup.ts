import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Global test setup: extends `expect` with jest-dom matchers, unmounts React
 * trees after every test, and provides jsdom polyfills the app code touches
 * (matchMedia for useMediaQuery; URL.createObjectURL for image previews).
 */
afterEach(() => {
  cleanup();
});

// jsdom has no matchMedia — useMediaQuery/usePrefersReducedMotion rely on it.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// jsdom has no object-URL API — files.ts previewUrl() uses it.
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
}

/**
 * Some jsdom configurations don't expose a working Storage; recentScans and the
 * pipeline hook depend on localStorage/sessionStorage. Install a minimal
 * in-memory Storage when absent so those tests exercise the real read/write
 * paths deterministically.
 */
function memoryStorage(): Storage {
  let map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => void (map = new Map()),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  const existing = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (!existing || typeof existing.clear !== "function") {
    Object.defineProperty(globalThis, name, {
      value: memoryStorage(),
      writable: true,
      configurable: true,
    });
  }
}
