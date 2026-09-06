/**
 * Vitest setup (frontend/src/test/setup.ts).
 *
 * React Testing Library auto-cleanup only registers when a global `afterEach`
 * exists; Vitest runs without `globals: true` in this project, so we register
 * cleanup explicitly here.
 */

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
