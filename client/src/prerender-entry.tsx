import { renderToString } from "react-dom/server";
import { Router, Switch, Route } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import LandingPage from "@/pages/LandingPage";
import PrivacyPolicy from "@/pages/PrivacyPolicy";
import TermsOfService from "@/pages/TermsOfService";
import OpenSourceLicenses from "@/pages/OpenSourceLicenses";
import PublicBooking from "@/pages/PublicBooking";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster } from "@/components/ui/toaster";
import { PRERENDERED_ROUTE_PATHS } from "@shared/prerendered-routes.mjs";

export const PRERENDER_PATHS = PRERENDERED_ROUTE_PATHS;

export function render(path: string): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router ssrPath={path}>
          <Switch>
            <Route path="/" component={LandingPage} />
            <Route path="/privacy" component={PrivacyPolicy} />
            <Route path="/terms" component={TermsOfService} />
            <Route path="/licenses" component={OpenSourceLicenses} />
          </Switch>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export interface BookingContractor {
  name: string;
  bookingSlug: string;
  bookingRedirectUrl: string | null;
  logoUrl: string | null;
}

/**
 * Render the public booking page server-side per tenant. Pre-populates the
 * react-query cache with the contractor info so the SSR'd output already shows
 * the tenant name (no skeleton shimmer on first paint). The same data is
 * shipped to the client via window.__BOOKING_DATA__ so hydration matches.
 */
export function renderBooking(opts: {
  slug: string;
  contractor: BookingContractor;
  search?: string;
}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["/api/public/book", opts.slug], {
    contractor: opts.contractor,
  });
  // Mirror the client's PublicBookingShell tree exactly (providers, error
  // boundary, toaster) so hydration sees an identical DOM.
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <Router ssrPath={`/book/${opts.slug}`} ssrSearch={opts.search ?? ""}>
            <Switch>
              <Route path="/book/:slug" component={PublicBooking} />
            </Switch>
          </Router>
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
