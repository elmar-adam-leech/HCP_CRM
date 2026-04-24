import { useEffect, useState } from "react";
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin(credentials);
  };

  const handleInputChange = (field: string, value: string) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  const handlePasskeyClick = async () => {
    if (!onPasskeyLogin || passkeyBusy) return;
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

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading || passkeyBusy}
              data-testid="button-login"
            >
              {isLoading ? "Signing in..." : "Sign In"}
            </Button>

            {onPasskeyLogin && passkeySupported && hasLocalPasskey && (
              <>
                <div className="relative my-2">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handlePasskeyClick}
                  disabled={isLoading || passkeyBusy}
                  data-testid="button-passkey-login"
                >
                  <Fingerprint className="h-4 w-4 mr-2" />
                  {passkeyBusy ? "Waiting for Face ID…" : "Unlock with Face ID"}
                </Button>
              </>
            )}

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
