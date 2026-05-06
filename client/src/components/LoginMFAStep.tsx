import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";

type LoginMFAStepProps = {
  pendingToken: string;
  onVerified: () => void;
  onCancel: () => void;
};

export function LoginMFAStep({ pendingToken, onVerified, onCancel }: LoginMFAStepProps) {
  const [code, setCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const response = await fetch('/api/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pendingToken, code }),
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const { persistRefreshTokenFromResponse } = await import("@/lib/queryClient");
        await persistRefreshTokenFromResponse(data);
        onVerified();
      } else {
        const data = await response.json();
        setError(data.message || "Invalid code. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex items-center justify-center mb-4">
            <ShieldCheck className="h-10 w-10 text-primary" />
          </div>
          <CardTitle className="text-2xl">Two-Factor Authentication</CardTitle>
          <CardDescription>
            Enter the 6-digit code from your authenticator app, or use a recovery code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mfa-code">Verification Code</Label>
              <Input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s/g, '').slice(0, 10))}
                autoFocus
                data-testid="input-mfa-code"
              />
            </div>

            {error && (
              <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={code.length < 6 || isLoading}
              data-testid="button-mfa-verify"
            >
              {isLoading ? "Verifying..." : "Verify"}
            </Button>

            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={onCancel}
            >
              Back to login
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
