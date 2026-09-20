/**
 * Theme control tests: the header <select> is the only writer of the stored
 * preference, and the app shell mounts it on both the operator and the public
 * chrome.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeToggle } from "../shared/components/theme-toggle";
import { THEME_STORAGE_KEY } from "../shared/theme";
import { FakeHttpClient } from "./fake-http-client";
import { renderWeb } from "./render";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

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
});

describe("theme toggle", () => {
  it("starts on System and paints the OS theme", () => {
    stubSystemTheme(true);
    render(<ThemeToggle />);

    const select = screen.getByRole("combobox", { name: "Theme" });
    expect((select as HTMLSelectElement).value).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("stores an explicit theme and keeps it even when the OS disagrees", async () => {
    stubSystemTheme(true);
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "dark");

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("returns to the OS theme when System is picked again", async () => {
    stubSystemTheme(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const user = userEvent.setup();
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe("dark");

    await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "system");

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("is mounted in the operator header", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    renderWeb(fake, { initialEntries: ["/"] });

    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeTruthy();
  });
});
