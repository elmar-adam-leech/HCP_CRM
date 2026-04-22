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
