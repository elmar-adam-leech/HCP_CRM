import { renderToString } from "react-dom/server";
import { Router, Switch, Route } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import LandingPage from "@/pages/LandingPage";
import PrivacyPolicy from "@/pages/PrivacyPolicy";
import TermsOfService from "@/pages/TermsOfService";
import OpenSourceLicenses from "@/pages/OpenSourceLicenses";
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
