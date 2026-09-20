/**
 * Theme model tests (docs/product-design.md, "Theming"): preference storage,
 * system resolution, and the two writers (the `data-theme` attribute and the
 * browser-chrome meta tag).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyTheme,
  initTheme,
  isThemePreference,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  systemTheme,
  THEME_STORAGE_KEY,
} from "../shared/theme";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** jsdom evaluates no media queries, so the system preference is stubbed. */
function stubSystemTheme(light: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === LIGHT_QUERY && light,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("theme preference", () => {
  it("recognises exactly system, light, and dark", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("Light")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });

  it("reads system when nothing is stored or the stored value is not a preference", () => {
    expect(readThemePreference()).toBe("system");
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemePreference()).toBe("system");
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readThemePreference()).toBe("light");
  });

  it("stores explicit choices and clears the key for system", () => {
    storeThemePreference("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    storeThemePreference("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("falls back to system when storage throws", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(readThemePreference()).toBe("system");
    } finally {
      getItem.mockRestore();
    }
  });
});

describe("theme resolution", () => {
  it("follows the system theme for the system preference", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
  });

  it("keeps an explicit preference regardless of the system", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("defaults to dark when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(systemTheme()).toBe("dark");
  });

  it("reads the light media query when the OS asks for light", () => {
    stubSystemTheme(true);
    expect(systemTheme()).toBe("light");
    stubSystemTheme(false);
    expect(systemTheme()).toBe("dark");
  });

  it("initTheme paints the system theme for a first visit", () => {
    stubSystemTheme(true);
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("initTheme honours a stored preference over the system", () => {
    stubSystemTheme(true);
    storeThemePreference("dark");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("writes data-theme and keeps the theme-color meta in step", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.append(meta);

    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.getAttribute("content")).toBe("#f4f7fb");

    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.getAttribute("content")).toBe("#07111f");
  });
});
