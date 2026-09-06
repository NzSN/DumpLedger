import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/responsive.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("DumpLedger web: missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
