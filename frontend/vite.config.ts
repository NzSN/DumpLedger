import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Development and build tooling only. Production serves the built assets from
// the same Fastify process; Vite is never a second production server.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4080",
      "/health": "http://127.0.0.1:4080"
    }
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false
  }
});
