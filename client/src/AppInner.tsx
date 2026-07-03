import { Switch, Route, useLocation } from "wouter";
import { queryClient, persistRefreshTokenFromResponse } from "./lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { SyncStatusProvider } from "@/hooks/use-sync-status";
import { WebSocketProvider } from "@/contexts/WebSocketContext";
import { BulkSelectionProvider } from "@/contexts/BulkSelectionContext";
import { TerminologyProvider } from "@/contexts/TerminologyContext";
import { DashboardLayout } from "@/components/DashboardLayout";
import { LoginForm } from "@/components/LoginForm";
import { RefreshBanner } from "@/components/ui/refresh-banner";
import { useAppVersion } from "@/hooks/use-app-version";
import { useState, lazy, Suspense, useEffect, createContext, useContext } from "react";
import { useToast } from "@/hooks/use-toast";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { LoginMFAStep } from "@/components/LoginMFAStep";
import { PasskeyEnrollmentPrompt } from "@/components/PasskeyEnrollmentPrompt";
import type { ContractorMembership, ActiveContractor } from "@/types/contractor";

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Leads = lazy(() => import("@/pages/Leads"));
const FollowUps = lazy(() => import("@/pages/Follow-ups"));
const Estimates = lazy(() => import("@/pages/Estimates"));
const Jobs = lazy(() => import("@/pages/Jobs"));
const Templates = lazy(() => import("@/pages/Templates"));
const Messages = lazy(() => import("@/pages/Messages"));
const Reports = lazy(() => import("@/pages/Reports"));
const Settings = lazy(() => import("@/pages/Settings"));
const WorkflowBuilder = lazy(() => import("@/pages/WorkflowBuilder"));
const WorkflowExecutions = lazy(() => import("@/pages/WorkflowExecutions"));
const WorkflowsList = lazy(() => import("@/pages/WorkflowsList"));
const SignUp = lazy(() => import("@/pages/SignUp"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const UserManagement = lazy(() => import("@/pages/UserManagement"));
const EnhancedDialpadSetup = lazy(() => import("@/pages/EnhancedDialpadSetup"));
const DialpadHealth = lazy(() => import("@/pages/DialpadHealth"));
const FacebookSetup = lazy(() => import("@/pages/FacebookSetup"));
const SendGridSetup = lazy(() => import("@/pages/SendGridSetup"));
const Contacts = lazy(() => import("@/pages/Contacts"));
const Calls = lazy(() => import("@/pages/Calls"));
const NotFound = lazy(() => import("@/pages/not-found"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));

const PageFallback = (
  <div className="min-h-screen bg-background flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

interface AuthContextValue {
  isAuthenticated: boolean;
  onLogin: (credentials: { email: string; password: string }) => void;
  onPasskeyLogin: () => Promise<void>;
  isLoading: boolean;
  loginError: string;
  globalSearch: string;
}

const AuthContext = createContext<AuthContextValue>({
  isAuthenticated: false,
  onLogin: () => {},
  onPasskeyLogin: async () => {},
  isLoading: false,
  loginError: "",
  globalSearch: "",
});

function useAuth() {
  return useContext(AuthContext);
}

function RedirectTo({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to, navigate]);
  return null;
}

function LoginFallbackPage() {
  const { onLogin, onPasskeyLogin, isLoading, loginError } = useAuth();
  return <ErrorBoundary><LoginForm onLogin={onLogin} onPasskeyLogin={onPasskeyLogin} isLoading={isLoading} error={loginError} /></ErrorBoundary>;
}

function RootRedirect() {
  // Authenticated users hitting `/` inside the dashboard shell go to /dashboard.
  // Unauthenticated users in the dashboard shell shouldn't normally be here
  // (PublicShell handles `/`), but if they do arrive here, send them to /login.
  const { isAuthenticated } = useAuth();
  return <RedirectTo to={isAuthenticated ? "/dashboard" : "/login"} />;
}

function LoginPageRoute() {
  const { isAuthenticated, onLogin, onPasskeyLogin, isLoading, loginError } = useAuth();
  return isAuthenticated
    ? <RedirectTo to="/dashboard" />
    : <ErrorBoundary><LoginForm onLogin={onLogin} onPasskeyLogin={onPasskeyLogin} isLoading={isLoading} error={loginError} /></ErrorBoundary>;
}

function DashboardPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Dashboard /></ErrorBoundary> : <LoginFallbackPage />;
}

function ContactsPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Contacts /></ErrorBoundary> : <LoginFallbackPage />;
}

function CallsPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Calls /></ErrorBoundary> : <LoginFallbackPage />;
}

function LeadsPage() {
  const { isAuthenticated, globalSearch } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Leads externalSearch={globalSearch} /></ErrorBoundary> : <LoginFallbackPage />;
}

function FollowUpsPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><FollowUps /></ErrorBoundary> : <LoginFallbackPage />;
}

function EstimatesPage() {
  const { isAuthenticated, globalSearch } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Estimates externalSearch={globalSearch} /></ErrorBoundary> : <LoginFallbackPage />;
}

function JobsPage() {
  const { isAuthenticated, globalSearch } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Jobs externalSearch={globalSearch} /></ErrorBoundary> : <LoginFallbackPage />;
}

function TemplatesPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Templates /></ErrorBoundary> : <LoginFallbackPage />;
}

function MessagesPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Messages /></ErrorBoundary> : <LoginFallbackPage />;
}

function WorkflowsListPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><WorkflowsList /></ErrorBoundary> : <LoginFallbackPage />;
}

function WorkflowBuilderPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><WorkflowBuilder /></ErrorBoundary> : <LoginFallbackPage />;
}

function WorkflowExecutionsPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><WorkflowExecutions /></ErrorBoundary> : <LoginFallbackPage />;
}

function ReportsPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Reports /></ErrorBoundary> : <LoginFallbackPage />;
}

function SettingsPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><Settings /></ErrorBoundary> : <LoginFallbackPage />;
}

function UsersPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><UserManagement /></ErrorBoundary> : <LoginFallbackPage />;
}

function DialpadSetupPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><EnhancedDialpadSetup /></ErrorBoundary> : <LoginFallbackPage />;
}

function DialpadHealthPage() {
  const { isAuthenticated } = useAuth();
  const { data: currentUserData, isLoading: isUserLoading } = useCurrentUser();
  const isSuperAdmin = currentUserData?.user?.role === 'super_admin';

  if (!isAuthenticated) return <LoginFallbackPage />;
  if (isUserLoading) return null;
  if (!isSuperAdmin) return <RedirectTo to="/dashboard" />;
  return <ErrorBoundary><DialpadHealth /></ErrorBoundary>;
}

function FacebookSetupPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><FacebookSetup /></ErrorBoundary> : <LoginFallbackPage />;
}

function SendGridSetupPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><SendGridSetup /></ErrorBoundary> : <LoginFallbackPage />;
}

function AuditLogPage() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <ErrorBoundary><AuditLog /></ErrorBoundary> : <LoginFallbackPage />;
}

function SignUpPage() {
  return <ErrorBoundary><SignUp /></ErrorBoundary>;
}

function ForgotPasswordPage() {
  return <ErrorBoundary><ForgotPassword /></ErrorBoundary>;
}

function ResetPasswordPage() {
  return <ErrorBoundary><ResetPassword /></ErrorBoundary>;
}

function NotFoundPage() {
  return <ErrorBoundary><NotFound /></ErrorBoundary>;
}

function Router() {
  return (
    <Suspense fallback={PageFallback}>
      <Switch>
        <Route path="/" component={RootRedirect} />
        <Route path="/login" component={LoginPageRoute} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/signup" component={SignUpPage} />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />

        {/* Protected routes - redirect to login if not authenticated */}
        <Route path="/contacts" component={ContactsPage} />
        <Route path="/calls" component={CallsPage} />
        <Route path="/leads" component={LeadsPage} />
        <Route path="/follow-ups" component={FollowUpsPage} />
        <Route path="/estimates" component={EstimatesPage} />
        <Route path="/jobs" component={JobsPage} />
        <Route path="/templates" component={TemplatesPage} />
        <Route path="/messages" component={MessagesPage} />
        <Route path="/workflows/manage" component={WorkflowsListPage} />
        <Route path="/workflows/new" component={WorkflowBuilderPage} />
        <Route path="/workflows/:id/edit" component={WorkflowBuilderPage} />
        <Route path="/workflows/:id/executions" component={WorkflowExecutionsPage} />
        <Route path="/workflows" component={WorkflowBuilderPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/users" component={UsersPage} />
        <Route path="/dialpad-setup" component={DialpadSetupPage} />
        <Route path="/dialpad/health" component={DialpadHealthPage} />
        <Route path="/facebook-setup" component={FacebookSetupPage} />
        <Route path="/sendgrid-setup" component={SendGridSetupPage} />
        <Route path="/audit-log" component={AuditLogPage} />
        <Route component={NotFoundPage} />
      </Switch>
    </Suspense>
  );
}

function useRateLimitToast() {
  const { toast } = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      toast({
        title: "Slow down",
        description: `Too many requests. Please wait ${detail?.retryAfter ?? 60} seconds before trying again.`,
        duration: 5000,
      });
    };
    window.addEventListener("rate-limit-hit", handler);
    return () => window.removeEventListener("rate-limit-hit", handler);
  }, [toast]);
}

/**
 * AppInner — rendered inside QueryClientProvider so hooks like useCurrentUser
 * and useToast have access to the React Query client and toast context.
 *
 * Auth strategy: useCurrentUser calls /api/auth/me via React Query (5-minute
 * staleTime, retry:1). This is the single canonical fetch — all other
 * components that call useCurrentUser share the same cache entry and never
 * make a duplicate network request.
 *
 * NOTE: This entire module is loaded lazily by App.tsx — public/marketing
 * routes never pull this chunk. The dashboard infrastructure (WebSocket,
 * sync status, terminology, bulk selection providers, DashboardLayout,
 * MobileBottomNav, etc.) only ships to authenticated visitors.
 */
export default function AppInner() {
  const { toast } = useToast();
  useRateLimitToast();
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [mfaPendingToken, setMfaPendingToken] = useState<string | null>(null);

  const { data: currentUserData, isLoading: isInitializing } = useCurrentUser();
  const user = currentUserData?.user ?? null;
  const isAuthenticated = !!user;

  const { showRefreshBanner, handleRefresh, handleDismiss } = useAppVersion();

  const { data: contractorData } = useQuery<ContractorMembership[]>({
    queryKey: ['/api/user/contractors'],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const userContractors = contractorData ?? [];

  const currentContractor: ActiveContractor | null = (() => {
    if (!user || userContractors.length === 0) return null;
    const current = userContractors.find((c) => c.contractorId === user.contractorId);
    if (!current) return null;
    return {
      id: current.contractor.id,
      name: current.contractor.name,
      domain: current.contractor.domain,
      role: current.role,
      logoUrl: current.contractor.logoUrl ?? null,
    };
  })();

  const handleLogin = async (credentials: { email: string; password: string }) => {
    setIsLoading(true);
    setLoginError("");

    try {
      if (credentials.email === "demo@example.com" && credentials.password === "demo") {
        try {
          await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              username: 'demo',
              password: 'demo',
              name: 'Demo User',
              email: 'demo@example.com',
              role: 'admin',
              contractorName: 'Demo Company',
            }),
          });
        } catch {
          // User might already exist, continue with login
        }
      }

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
          // task #737: also persist the auth JWT into LS+IDB for the
          // cookieless bearer-token fallback path.
          const { persistAuthTokenFromResponse } = await import("@/lib/queryClient");
          await persistAuthTokenFromResponse(data);
          // task #738: report `password` so production telemetry sees the
          // full boot-resolution distribution including the slowest /
          // most-friction outcome.
          try {
            const { reportBootResolution } = await import("@/lib/boot-auth");
            reportBootResolution("password");
          } catch {
            // Telemetry must never block sign-in.
          }
          queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
        }
      } else {
        const errorData = await response.json();
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
        // task #737: also persist the auth JWT into LS+IDB for the
        // cookieless bearer-token fallback path.
        const { persistAuthTokenFromResponse } = await import("@/lib/queryClient");
        await persistAuthTokenFromResponse(data);
        // task #738: explicit (button-triggered) passkey sign-in is the
        // `passkey-explicit` boot resolution branch.
        try {
          const { reportBootResolution } = await import("@/lib/boot-auth");
          reportBootResolution("passkey-explicit");
        } catch {
          // Telemetry must never block sign-in.
        }
        queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
        return;
      }
      const err = await finishRes.json().catch(() => ({}));
      setLoginError(err.message || 'Passkey sign-in failed');
    } catch (err) {
      console.error('Passkey login error', err);
      setLoginError('Network error. Please try again.');
    }
  };

  const handleContractorChange = async (contractor: ActiveContractor) => {
    try {
      const response = await fetch('/api/user/switch-contractor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ contractorId: contractor.id }),
      });
      if (response.ok) {
        window.location.reload();
      } else {
        toast({
          title: "Failed to switch account",
          description: "Could not switch to the selected account. Please refresh the page and try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error switching contractor:", error);
      toast({
        title: "Failed to switch account",
        description: "A network error occurred. Please refresh the page and try again.",
        variant: "destructive",
      });
    }
  };

  const [globalSearch, setGlobalSearch] = useState("");
  const handleSearch = (query: string) => setGlobalSearch(query);

  const [, setLocation] = useLocation();
  const handleQuickAction = (action: string) => {
    switch (action) {
      case "create-lead":      setLocation("/leads?add=true");     break;
      case "create-estimate":  setLocation("/estimates?add=true"); break;
      case "create-job":       setLocation("/jobs?add=true");      break;
    }
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (mfaPendingToken && !isAuthenticated) {
    return (
      <LoginMFAStep
        pendingToken={mfaPendingToken}
        onVerified={() => {
          setMfaPendingToken(null);
          queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
        }}
        onCancel={() => {
          setMfaPendingToken(null);
          setLoginError("");
        }}
      />
    );
  }

  const authContextValue: AuthContextValue = {
    isAuthenticated,
    onLogin: handleLogin,
    onPasskeyLogin: handlePasskeyLogin,
    isLoading,
    loginError,
    globalSearch,
  };

  return (
    <AuthContext.Provider value={authContextValue}>
      <WebSocketProvider>
        {isAuthenticated && user ? (
          <SyncStatusProvider>
            <TerminologyProvider>
            <BulkSelectionProvider>
              {showRefreshBanner && (
                <RefreshBanner
                  onRefresh={handleRefresh}
                  onDismiss={handleDismiss}
                />
              )}
              <DashboardLayout
                user={user}
                contractors={userContractors.map(uc => ({
                  id: uc.contractor.id,
                  name: uc.contractor.name,
                  domain: uc.contractor.domain,
                  role: uc.role,
                  logoUrl: uc.contractor.logoUrl ?? null,
                }))}
                currentContractor={currentContractor || {
                  id: user.contractorId,
                  name: 'Loading...',
                  domain: '',
                  role: user.role,
                }}
                onContractorChange={handleContractorChange}
                onSearch={handleSearch}
                onQuickAction={handleQuickAction}
              >
                <Router />
              </DashboardLayout>
              <MobileBottomNav />
              <PasskeyEnrollmentPrompt user={user} />
              <Toaster />
            </BulkSelectionProvider>
            </TerminologyProvider>
          </SyncStatusProvider>
        ) : (
          <>
            <Router />
            <Toaster />
          </>
        )}
      </WebSocketProvider>
    </AuthContext.Provider>
  );
}
