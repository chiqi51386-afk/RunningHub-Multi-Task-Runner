import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppBoundary } from "./AppBoundary";
import "./styles.css";
import "./themes.css";
import { validTheme } from "./themes";

try { document.documentElement.dataset.theme = validTheme(JSON.parse(localStorage.getItem("rh-runner.ui-preferences.v1") ?? "{}").theme); }
catch { document.documentElement.dataset.theme = "dark"; }

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppBoundary><App /></AppBoundary>
  </StrictMode>,
);
