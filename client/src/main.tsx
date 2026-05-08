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
void (async () => {
  try {
    const { ensureBootRecovery } = await import("./lib/auth-token-storage");
    const recovered = await ensureBootRecovery();
    const cookieVisible = typeof document !== "undefined"
      && document.cookie.split(";").some((c) => c.trim().startsWith("auth_token="));
    if (!recovered && !cookieVisible) {
      void fetch("/api/auth/storage-probe", {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
    }
  } catch {
    // Probe is purely diagnostic; never block boot on its failure.
  }
})();

const rootEl = document.getElementById("root")!;
const tree = (
  <TopLevelErrorBoundary>
    <App />
  </TopLevelErrorBoundary>
);

// If the server sent a pre-rendered marketing page, hydrate the existing DOM
// in place so the user doesn't see a flash. Otherwise mount the SPA fresh.
if (rootEl.hasChildNodes()) {
  hydrateRoot(rootEl, tree);
} else {
  createRoot(rootEl).render(tree);
}
