import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initTheme } from "./shared/theme";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/responsive.css";

// Resolve light/dark before React paints anything (no inline script: the
// production CSP allows same-origin modules only).
initTheme();

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("DumpLedger web: missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
