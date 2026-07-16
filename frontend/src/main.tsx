import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import "@/styles/globals.css";

/**
 * Force a full reload when the browser restores this tab from the
 * back-forward cache (bfcache), rather than replaying whatever route was
 * rendered before the tab navigated away.
 *
 * Without this: a user who visits /admin/login, then navigates to /login and
 * signs in with Google, can hit the browser's Back button (or a mobile
 * back-swipe) after the post-OAuth redirect and have the browser restore the
 * *frozen* /admin/login render straight from bfcache — no guard, no auth
 * check runs, because the page was never re-fetched. `event.persisted` is
 * exactly the signal that this render is stale rather than a fresh load, and
 * reloading re-runs every route guard against the browser's current cookies.
 */
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
