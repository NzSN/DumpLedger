import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest runs the same Vite transform pipeline. Tests replace the HTTP client
// with a fake adapter; global fetch is never mocked in feature tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    clearMocks: true,
    restoreMocks: true
  }
});
