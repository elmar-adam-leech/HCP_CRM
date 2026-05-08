import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff, Fingerprint, Lock, Mail } from "lucide-react";

type LoginFormProps = {
  onLogin: (credentials: { email: string; password: string }) => void;
  onPasskeyLogin?: () => Promise<void> | void;
  isLoading?: boolean;
  error?: string;
};

export function LoginForm({ onLogin, onPasskeyLogin, isLoading = false, error }: LoginFormProps) {
  const [credentials, setCredentials] = useState({
    email: "",
    password: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // Set when this device has at least one registered passkey for this app
  // (written by PasskeysCard on successful registration). Acceptance criterion:
  // "users with no passkeys do not see new login UI", so the button stays
  // hidden until there's a credential to actually unlock.
  const [hasLocalPasskey, setHasLocalPasskey] = useState(false);
  // task #738: when a passkey is registered locally we collapse the
  // password fields behind a "Sign in another way" toggle so Face ID is
  // visually the primary path. Users can still expand the password form to
  // sign in with credentials.
  const [showPasswordFields, setShowPasswordFields] = useState(false);
  // task #738 follow-up: shared handle for the in-flight conditional
  // WebAuthn request so explicit/password sign-in paths can cancel it
  // before starting their own navigator.credentials.get() call. Two
  // overlapping WebAuthn requests cause NotAllowedError on platforms that
  // support conditional mediation, which would block the explicit CTA.
  const conditionalAbortRef = useRef<AbortController | null>(null);
  const cancelConditionalPasskey = () => {
    const ac = conditionalAbortRef.current;
    conditionalAbortRef.current = null;
    if (ac) {
      try { ac.abort(); } catch { /* noop */ }
    }
  };

  useEffect(() => {
    if (!onPasskeyLogin) return;
    let cancelled = false;
    (async () => {
      try {
        if (typeof window === "undefined" || !window.PublicKeyCredential) {
          return;
        }
        try {
          if (window.localStorage?.getItem("hcp.webauthn.hasPasskey") === "1") {
            if (!cancelled) setHasLocalPasskey(true);
          }
        } catch {
          // localStorage unavailable (private mode) — leave gate closed.
        }
        const PKC = window.PublicKeyCredential as typeof window.PublicKeyCredential & {
          isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
        };
        if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return;
        const available = await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
        if (!cancelled) setPasskeySupported(Boolean(available));
      } catch {
        // Silent: just hide the button if detection fails.
      }
    })();
    return () => { cancelled = true; };
  }, [onPasskeyLogin]);

  // task #738: conditional-UI passkey discovery. When the device hint says
  // there's a registered passkey AND the user-agent supports WebAuthn
  // autofill (`browserSupportsWebAuthnAutofill`), we open a long-lived
  // conditional-mediation request in the background. The browser will offer
  // the passkey as an autofill suggestion on the email/password inputs (which
  // carry `autocomplete="username webauthn"` / `current-password webauthn"`)
  // — selecting it triggers Face ID and signs the user in WITHOUT them ever
  // having to type. If the request is cancelled (component unmount, user
  // tapped the explicit button, password submit) we abort it cleanly.
  useEffect(() => {
    if (!onPasskeyLogin) return;
    if (!passkeySupported || !hasLocalPasskey) return;
    let cancelled = false;
    const ac = new AbortController();
    conditionalAbortRef.current = ac;
    (async () => {
      try {
        const { attemptConditionalPasskey, reportBootResolution } = await import(
          "@/lib/boot-auth"
        );
        const result = await attemptConditionalPasskey({ signal: ac.signal });
        if (cancelled) return;
        if (!result.ok) return;
        const data = result.data ?? {};
        const {
          persistRefreshTokenFromResponse,
          persistAuthTokenFromResponse,
          queryClient,
        } = await import("@/lib/queryClient");
        await persistRefreshTokenFromResponse(data);
        await persistAuthTokenFromResponse(data);
        if (result.source === "passkey-conditional" || result.source === "passkey-explicit") {
          reportBootResolution(result.source);
        }
        queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      } catch {
        // Silent: conditional UI is a progressive enhancement.
      }
    })();
    return () => {
      cancelled = true;
      if (conditionalAbortRef.current === ac) {
        conditionalAbortRef.current = null;
      }
      try { ac.abort(); } catch { /* noop */ }
    };
  }, [onPasskeyLogin, passkeySupported, hasLocalPasskey]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Cancel the in-flight conditional WebAuthn request before the
    // password submit triggers its own auth flow — overlapping
    // navigator.credentials.get() calls cause NotAllowedError on
    // platforms with conditional mediation.
    cancelConditionalPasskey();
    onLogin(credentials);
  };

  const handleInputChange = (field: string, value: string) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  const handlePasskeyClick = async () => {
    if (!onPasskeyLogin || passkeyBusy) return;
    // Same coordination as handleSubmit: ensure no conditional WebAuthn
    // request is pending before the explicit flow opens its own.
    cancelConditionalPasskey();
    setPasskeyBusy(true);
    try {
      await onPasskeyLogin();
    } finally {
      setPasskeyBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex items-center justify-center mb-4">
            <img src="/hcp-crm-logo.png" alt="HCP CRM" className="h-10 w-10 object-contain" />
          </div>
          <CardTitle className="text-2xl">Login</CardTitle>
          <CardDescription>
            Enter your credentials to access your contractor dashboard
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* task #738: when this device has a registered passkey, the
              password form is collapsed behind a "Sign in another way"
              link and Face ID is the only visible CTA. Users without a
              local passkey see the password form by default (no UX
              change). The hidden email field stays mounted with
              `autoComplete="username webauthn"` so iOS conditional-UI can
              still autofill into it in the background. */}
          {onPasskeyLogin && passkeySupported && hasLocalPasskey && !showPasswordFields ? (
            <div className="space-y-4">
              <input
                type="email"
                value={credentials.email}
                onChange={(e) => handleInputChange("email", e.target.value)}
                autoComplete="username webauthn"
                aria-hidden="true"
                tabIndex={-1}
                style={{ position: "absolute", opacity: 0, pointerEvents: "none", height: 0, width: 0 }}
                data-testid="input-email-hidden"
              />
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
                  {error}
                </div>
              )}
              <Button
                type="button"
                size="lg"
                className="w-full"
                onClick={handlePasskeyClick}
                disabled={isLoading || passkeyBusy}
                data-testid="button-passkey-login"
              >
                <Fingerprint className="h-4 w-4 mr-2" />
                {passkeyBusy ? "Waiting for Face ID…" : "Sign in with Face ID"}
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  className="text-sm text-primary hover:underline"
                  onClick={() => setShowPasswordFields(true)}
                  data-testid="button-show-password"
                >
                  Sign in another way
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <div className="relative">
                  <Mail className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="your@email.com"
                    value={credentials.email}
                    onChange={(e) => handleInputChange("email", e.target.value)}
                    className="pl-8"
                    required
                    autoComplete="username webauthn"
                    data-testid="input-email"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <Lock className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      placeholder="Enter your password"
                      value={credentials.password}
                      onChange={(e) => handleInputChange("password", e.target.value)}
                      className="pl-8"
                      required
                      data-testid="input-password"
                    />
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                    onClick={() => setShowPassword((prev) => !prev)}
                    tabIndex={-1}
                    data-testid="button-toggle-password"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
                  {error}
                </div>
              )}

              {onPasskeyLogin && passkeySupported && (
                <Button
                  type="button"
                  size="lg"
                  className="w-full"
                  variant={hasLocalPasskey ? "default" : "outline"}
                  onClick={handlePasskeyClick}
                  disabled={isLoading || passkeyBusy}
                  data-testid="button-passkey-login"
                >
                  <Fingerprint className="h-4 w-4 mr-2" />
                  {passkeyBusy ? "Waiting for Face ID…" : "Sign in with Face ID"}
                </Button>
              )}

              <Button
                type="submit"
                className="w-full"
                variant={onPasskeyLogin && passkeySupported && hasLocalPasskey ? "outline" : "default"}
                disabled={isLoading || passkeyBusy}
                data-testid="button-login"
              >
                {isLoading ? "Signing in..." : "Sign In"}
              </Button>

              <div className="text-center">
                <a
                  href="/forgot-password"
                  className="text-sm text-primary hover:underline"
                  data-testid="link-forgot-password"
                >
                  Forgot your password?
                </a>
              </div>
            </form>
          )}

          <div className="mt-4 text-center text-sm text-muted-foreground">
            Don't have an account?{" "}
            <a href="/signup" className="text-primary hover:underline" data-testid="link-signup">
              Sign up
            </a>
          </div>
        </CardContent>
      </Card>
      <footer className="mt-6 text-center text-xs text-muted-foreground space-x-4">
        <span>&copy; {new Date().getFullYear()} All rights reserved.</span>
        <a href="/privacy" className="hover:underline">Privacy Policy</a>
        <a href="/terms" className="hover:underline">Terms of Service</a>
      </footer>
    </div>
  );
}
