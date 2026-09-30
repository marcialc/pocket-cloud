import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline play: sw.js keeps the app on this device (built by vite.config.ts; not in dev).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Could not set up offline play", err));
    // ROMs and saves may exist only here: ask the browser not to clear them to free space.
    navigator.storage?.persist?.().catch(() => {});
  });
}
