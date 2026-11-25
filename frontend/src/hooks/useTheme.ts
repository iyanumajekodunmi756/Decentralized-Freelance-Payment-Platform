/**
 * useTheme.ts
 *
 * Theme management hook supporting light and dark modes with localStorage persistence
 * and system preference fallback. Prevents flash of wrong theme by synchronizing
 * with document.documentElement's data-theme attribute.
 */

import { useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {
    // localStorage may be inaccessible in restricted iframe/incognito
  }

  const existingAttr = document.documentElement.getAttribute("data-theme");
  if (existingAttr === "light" || existingAttr === "dark") {
    return existingAttr;
  }

  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }

  return "light";
}

export function useTheme() {
  const [theme, setCurrentTheme] = useState<Theme>(getInitialTheme);
  const explicitChoice = useRef(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Listen to system theme changes if no explicit user preference was saved in localStorage
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const listener = (e: MediaQueryListEvent) => {
      if (explicitChoice.current) return;
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        // Follow system changes when storage is unavailable.
      }
      if (saved !== "dark" && saved !== "light") setCurrentTheme(e.matches ? "dark" : "light");
    };

    if (media.addEventListener) {
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    } else if (media.addListener) {
      media.addListener(listener);
      return () => media.removeListener(listener);
    }
  }, []);

  const setTheme = (mode: Theme) => {
    explicitChoice.current = true;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // An explicit choice still works for this session.
    }
    setCurrentTheme(mode);
  };

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  return { theme, setTheme, toggleTheme };
}
