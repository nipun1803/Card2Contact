import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isFeatureEnabled } from "@/shared/lib/featureFlags";

type Theme = "light" | "dark";
const STORAGE_KEY = "c2c.theme";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  canToggle: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getInitialTheme(): Theme {
  if (!isFeatureEnabled("darkMode")) return "light";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Light/dark theme, stamped as a `.dark` class on <html> (matching Tailwind's
 * darkMode: "class"). When the darkMode flag is off, it locks to light.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const canToggle = isFeatureEnabled("darkMode");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

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
