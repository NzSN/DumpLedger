/**
 * Theme control (docs/product-design.md, "Theming"): a native <select> with
 * the three preferences. System is the default, so a first-time visitor gets
 * whatever their OS asks for; picking Light or Dark stores that choice.
 */

import type { ReactNode } from "react";
import { isThemePreference, useTheme } from "../theme";

export function ThemeToggle(): ReactNode {
  const { preference, setPreference } = useTheme();
  return (
    <select
      className="theme-select"
      aria-label="Theme"
      value={preference}
      onChange={(event) => {
        const next = event.target.value;
        if (isThemePreference(next)) setPreference(next);
      }}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
