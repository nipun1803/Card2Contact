import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isFeatureEnabled } from "@/shared/lib/featureFlags";

type Theme = "light" | "dark";
const DEFAULT_STORAGE_KEY = "c2c.theme";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  canToggle: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getInitialTheme(storageKey: string): Theme {
  if (!isFeatureEnabled("darkMode")) return "light";
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface ThemeProviderProps {
  children: ReactNode;
  /**
   * localStorage key for this provider's preference. A nested ThemeProvider
   * (e.g. the admin shell, mounted inside the user-facing one) uses its own
   * key so admin and user each remember their own light/dark choice —
   * whichever provider is mounted for the active route is the one that
   * stamps the shared `.dark` class on <html>.
   */
  storageKey?: string;
}

/**
 * Light/dark theme, stamped as a `.dark` class on <html> (matching Tailwind's
 * darkMode: "class"). When the darkMode flag is off, it locks to light.
 */
export function ThemeProvider({ children, storageKey = DEFAULT_STORAGE_KEY }: ThemeProviderProps) {
  const canToggle = isFeatureEnabled("darkMode");
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme(storageKey));

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      /* ignore */
    }

    // A nested provider (e.g. the admin shell) stamps the same shared <html>
    // class while mounted. On unmount, hand the DOM back to whichever theme
    // the default (outer) provider owns, so navigating out of that subtree
    // doesn't leave its preference stuck on the page.
    if (storageKey === DEFAULT_STORAGE_KEY) return;
    return () => {
      const outer = getInitialTheme(DEFAULT_STORAGE_KEY);
      root.classList.toggle("dark", outer === "dark");
      root.style.colorScheme = outer;
    };
  }, [theme, storageKey]);

  function toggleTheme() {
    if (!canToggle) return;
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, canToggle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
