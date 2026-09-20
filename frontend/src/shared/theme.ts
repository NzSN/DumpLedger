/**
 * Theme model (docs/product-design.md, "Theming").
 *
 * Every colour the interface paints resolves through the tokens in
 * frontend/src/styles/tokens.css; this module is the only writer of the
 * `data-theme` attribute those tokens key off. `initTheme` runs from main.tsx
 * before React's first render, so the first painted frame is already in the
 * resolved theme. That ordering is also why the boot step lives in the module
 * graph instead of an inline snippet in index.html: the production
 * Content-Security-Policy allows no inline script (src/http/server.ts).
 */

import { useCallback, useEffect, useState } from "react";

/** `localStorage` key holding the explicit choice; absent means "system". */
export const THEME_STORAGE_KEY = "dump-ledger.theme";

export type ThemeName = "light" | "dark";

/** What the operator picked: an explicit theme, or follow the OS. */
export type ThemePreference = "system" | ThemeName;

export interface ThemeController {
  readonly preference: ThemePreference;
  readonly theme: ThemeName;
  setPreference(preference: ThemePreference): void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** Stored preference, or "system" when unset, unreadable, or unrecognised. */
export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Explicit choices are stored; "system" clears the key so the OS wins again. */
export function storeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked storage (for example a locked-down private window) still gets
    // the in-memory choice for this session; there is nothing to recover.
  }
}

/** The OS preference; environments without matchMedia (older harnesses) are dark. */
export function systemTheme(): ThemeName {
  if (typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(preference: ThemePreference, system: ThemeName): ThemeName {
  return preference === "system" ? system : preference;
}

/** Writes the attribute the tokens key off, and keeps the browser chrome in step. */
export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute("content", theme === "light" ? "#f4f7fb" : "#07111f");
}

/** Boot step: resolve the preference and paint it before React renders. */
export function initTheme(): void {
  applyTheme(resolveTheme(readThemePreference(), systemTheme()));
}

function subscribeToSystemTheme(onChange: (theme: ThemeName) => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia("(prefers-color-scheme: light)");
  if (typeof query.addEventListener !== "function") return () => undefined;
  const handle = (event: MediaQueryListEvent): void => {
    onChange(event.matches ? "light" : "dark");
  };
  query.addEventListener("change", handle);
  return () => { query.removeEventListener("change", handle); };
}

/** Live controller for the header control: preference in, resolved theme out. */
export function useTheme(): ThemeController {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
  const [system, setSystem] = useState<ThemeName>(systemTheme);
  const theme = resolveTheme(preference, system);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => subscribeToSystemTheme(setSystem), []);

  const setPreference = useCallback((next: ThemePreference): void => {
    storeThemePreference(next);
    setPreferenceState(next);
  }, []);

  return { preference, theme, setPreference };
}
