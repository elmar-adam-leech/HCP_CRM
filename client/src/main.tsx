import { createRoot, hydrateRoot } from "react-dom/client";
import { Component, type ErrorInfo, type ReactNode } from "react";
import App from "./App";
import { queryClient } from "./lib/queryClient";
import "./index.css";

// The server SSRs the public booking page (/book/:slug) per tenant and ships
// the contractor data via window.__BOOKING_DATA__. Pre-populate react-query's
// cache here, BEFORE hydration, so the client's first render matches the
// server-rendered DOM (otherwise hydration would mismatch the contractor name
// vs the loading skeleton).
type BookingBootstrap = {
  slug: string;
  contractor: {
    name: string;
    bookingSlug: string;
    bookingRedirectUrl: string | null;
    logoUrl: string | null;
    brandColor: string | null;
  };
};
const bookingBootstrap = (window as unknown as {
  __BOOKING_DATA__?: BookingBootstrap;
}).__BOOKING_DATA__;
if (bookingBootstrap?.slug && bookingBootstrap.contractor) {
  queryClient.setQueryData(
    ["/api/public/book", bookingBootstrap.slug],
    { contractor: bookingBootstrap.contractor },
  );
}

// Top-level error boundary — catches any crash that escapes the router-level
// boundary inside App.tsx (e.g. a broken context provider or sidebar crash).
// Renders a minimal fallback so users never see a blank white screen.
class TopLevelErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  state = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[TopLevelErrorBoundary] Uncaught error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8 bg-background text-foreground">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="text-muted-foreground text-sm max-w-md text-center">
            An unexpected error occurred. Please refresh the page. If the problem
            persists, contact support.
          </p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm"
            onClick={() => window.location.reload()}
          >
            Refresh page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// task #737 step 7 (literal spec): "The SPA hits this on first boot if both
// cookie and storage are empty, purely so we can log a `bearer_probe`
// outcome." Fire-and-forget telemetry — never blocks boot. The auth_token
// cookie is httpOnly, so `document.cookie` cannot see it; per the spec's
// gating model that's treated as "cookie not visible" and the probe is
// allowed to fire alongside an empty storage mirror. The server-side
// rate limit (10/min/IP, `AuthStorageProbe`) bounds the resulting volume.
/**
 * task #738 — pre-render boot auth gate.
 *
 * Resolves cookie → bearer (with silent refresh) → conditional passkey
 * BEFORE mounting React, then invalidates the /api/auth/me query so the
 * SPA's first render sees the fresh session. Bounded by a 3-second
 * overall budget so a misbehaving network or hung passkey prompt cannot
 * delay app mount indefinitely.
 */
async function bootAuth(): Promise<void> {
  const { apiRequest } = await import("./lib/queryClient");
  const {
    reportBootResolution,
    attemptBootSilentPasskey,
    determineBootSource,
  } = await import("./lib/boot-auth");

  let probedAuth = false;
  try {
    const meRes = await apiRequest("GET", "/api/auth/me");
    probedAuth = meRes.ok;
  } catch {
    probedAuth = false;
  }

  if (probedAuth) {
    const source = determineBootSource();
    reportBootResolution(source === "none" ? "cookie" : source);
    return;
  }

  const silent = await attemptBootSilentPasskey();
  if (silent.ok) {
    // Make sure the SPA's first render sees the fresh session — without
    // this, useCurrentUser() may have already cached an unauthenticated
    // result before the passkey assertion completed.
    queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    reportBootResolution(silent.source);
  } else {
    reportBootResolution("none");
  }
}

const rootEl = document.getElementById("root")!;
const tree = (
  <TopLevelErrorBoundary>
    <App />
  </TopLevelErrorBoundary>
);

function mount() {
  if (rootEl.hasChildNodes()) {
    hydrateRoot(rootEl, tree);
  } else {
    createRoot(rootEl).render(tree);
  }
}

// Race the boot gate against a 3-second budget. Whichever finishes first
// triggers React mount. Telemetry inside bootAuth still completes in the
// background even if the budget expired first.
void (async () => {
  try {
    await Promise.race([
      bootAuth(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    // Boot gate is purely diagnostic for mount; never block on its failure.
  } finally {
    mount();
  }
})();
