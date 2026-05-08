import { Switch, Route, useLocation } from "wouter";
import { queryClient, persistRefreshTokenFromResponse } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoginForm } from "@/components/LoginForm";

// Public pages are eagerly imported — they make up the marketing-site shell
// and must paint quickly without waiting for any other chunk.
import PublicBooking from "@/pages/PublicBooking";
import LandingPage from "@/pages/LandingPage";
import PrivacyPolicy from "@/pages/PrivacyPolicy";
import TermsOfService from "@/pages/TermsOfService";
import OpenSourceLicenses from "@/pages/OpenSourceLicenses";

// Auth-adjacent public pages remain lazy — only loaded when actually visited.
const SignUp = lazy(() => import("@/pages/SignUp"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));

// The entire dashboard tree is gated behind a dynamic import so marketing-site
// visitors never download it. See AppInner.tsx for the full provider stack
// (WebSocket, sync status, terminology, bulk selection, DashboardLayout, etc.).
const AppInner = lazy(() => import("./AppInner"));

const PageFallback = (
  <div className="min-h-screen bg-background flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

/**
 * Set of exact-match paths that the PublicShell handles. Wildcard public
 * paths (e.g. /privacy/:slug, /book/:slug) are matched separately below.
 */
const PUBLIC_PATHS = new Set<string>([
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/privacy",
  "/terms",
  "/licenses",
]);

function isPublicPath(path: string): boolean {
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (PUBLIC_PATHS.has(normalized)) return true;
  if (/^\/privacy\//.test(normalized)) return true;
  return false;
}

/**
 * Strips a single trailing slash from the current pathname (for any path
 * longer than "/") via a `replace` navigation, so wouter's exact-match
 * `<Switch>` resolves the route. Used by both PublicShell and
 * PublicBookingShell so that `/licenses/`, `/book/foo/`, etc. don't 404.
 */
function useStripTrailingSlash() {
  const [location, setLocation] = useLocation();
  useEffect(() => {
    if (location.length > 1 && location.endsWith("/")) {
      setLocation(location.slice(0, -1), { replace: true });
    }
  }, [location, setLocation]);
}

/**
 * PublicLoginPage — minimal login form used by PublicShell.
 *
 * Critically, on success we do a HARD navigation to /dashboard rather than a
 * client-side route change. This is a deliberate trade-off: the user pays one
 * extra page load on first login, in exchange for every marketing-site
 * visitor never downloading the dashboard JS. MFA-required accounts lazy-load
 * the MFA step component on demand so the public bundle stays small.
 */
function PublicLoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [mfaPendingToken, setMfaPendingToken] = useState<string | null>(null);

  const handleLogin = async (credentials: { email: string; password: string }) => {
    setIsLoading(true);
    setLoginError("");
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: credentials.email, password: credentials.password }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.status === 'mfa_required' && data.pendingToken) {
          setMfaPendingToken(data.pendingToken);
        } else {
          await persistRefreshTokenFromResponse(data);
          // task #737: persist auth JWT into LS+IDB (bearer fallback).
          const { persistAuthTokenFromResponse } = await import("@/lib/queryClient");
          await persistAuthTokenFromResponse(data);
          window.location.href = "/dashboard";
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setLoginError(errorData.message || "Login failed");
      }
    } catch (error) {
      console.error("Login error:", error);
      setLoginError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setLoginError("");
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");

      const beginRes = await fetch('/api/auth/webauthn/login/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
      if (!beginRes.ok) {
        const err = await beginRes.json().catch(() => ({}));
        setLoginError(err.message || 'Could not start passkey sign-in');
        return;
      }
      const { sessionId, options } = await beginRes.json();

      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: options });
      } catch (err) {
        // User cancelled or no matching credential — show a friendly message.
        const msg = err instanceof Error ? err.message : 'Sign-in cancelled';
        setLoginError(msg.includes('NotAllowed') ? 'Sign-in cancelled' : msg);
        return;
      }

      const finishRes = await fetch('/api/auth/webauthn/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId, response: assertion }),
      });
      if (finishRes.ok) {
        const data = await finishRes.json().catch(() => ({}));
        await persistRefreshTokenFromResponse(data);
        // task #737: persist auth JWT into LS+IDB (bearer fallback).
        const { persistAuthTokenFromResponse } = await import("@/lib/queryClient");
        await persistAuthTokenFromResponse(data);
        window.location.href = "/dashboard";
        return;
      }
      const err = await finishRes.json().catch(() => ({}));
      setLoginError(err.message || 'Passkey sign-in failed');
    } catch (err) {
      console.error('Passkey login error', err);
      setLoginError('Network error. Please try again.');
    }
  };

  if (mfaPendingToken) {
    const LazyMFAStep = lazy(() => import("@/components/LoginMFAStep").then(m => ({ default: m.LoginMFAStep })));
    return (
      <Suspense fallback={PageFallback}>
        <LazyMFAStep
          pendingToken={mfaPendingToken}
          onVerified={() => { window.location.href = "/dashboard"; }}
          onCancel={() => { setMfaPendingToken(null); setLoginError(""); }}
        />
      </Suspense>
    );
  }

  return <LoginForm onLogin={handleLogin} onPasskeyLogin={handlePasskeyLogin} isLoading={isLoading} error={loginError} />;
}

/**
 * PublicShell — the lightweight tree rendered for marketing-site / unauth
 * routes. Crucially, it does NOT import any of the dashboard infrastructure
 * (no WebSocketProvider, no SyncStatusProvider, no DashboardLayout, no
 * useCurrentUser auth bootstrap). Visitors to /, /login, /privacy, /terms,
 * /licenses, /signup, /forgot-password, /reset-password get this shell only.
 */
function PublicShellRoutes() {
  useStripTrailingSlash();
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={PublicLoginPage} />
      <Route path="/signup" component={SignUp} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/privacy" component={PrivacyPolicy} />
      <Route path="/privacy/:slug" component={PrivacyPolicy} />
      <Route path="/terms" component={TermsOfService} />
      <Route path="/licenses" component={OpenSourceLicenses} />
    </Switch>
  );
}

function PublicShell() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <Suspense fallback={PageFallback}>
            <PublicShellRoutes />
          </Suspense>
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}


/**
 * PublicBookingShell — even more minimal than PublicShell. Used for /book/*
 * so that public booking visitors don't pay for the marketing pages either.
 */
function PublicBookingShellRoutes() {
  useStripTrailingSlash();
  return (
    <Switch>
      <Route path="/book/:slug" component={PublicBooking} />
    </Switch>
  );
}

function PublicBookingShell() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <PublicBookingShellRoutes />
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function App() {
  // Pre-mount path detection: route public visitors to a stripped-down shell
  // so they never download the dashboard chunk. This is the single biggest
  // win for marketing-site time-to-interactive — see task #589.
  if (typeof window !== "undefined") {
    const path = window.location.pathname;
    if (/^\/book\//.test(path)) {
      return <PublicBookingShell />;
    }
    if (isPublicPath(path)) {
      return <PublicShell />;
    }
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Suspense fallback={PageFallback}>
          <AppInner />
        </Suspense>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
