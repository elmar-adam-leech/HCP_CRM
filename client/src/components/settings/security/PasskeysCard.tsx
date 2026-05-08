import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Fingerprint, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

type Credential = {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastUsedAt: string | null;
};

const HAS_PASSKEY_KEY = "hcp.webauthn.hasPasskey";

function setHasPasskeyFlag(value: boolean): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (value) window.localStorage.setItem(HAS_PASSKEY_KEY, "1");
    else window.localStorage.removeItem(HAS_PASSKEY_KEY);
  } catch {
    // localStorage may be unavailable (private mode); login button stays
    // hidden in that case, which is the safe default.
  }
  // task #738: also mirror the hint into a small non-httpOnly cookie so the
  // server-side `/has-credentials` endpoint can return `hasAny: true` on
  // first cold-boot WITHOUT being forced into an account-enumeration shape.
  // Cookie carries no PII — it's literally `pkhint=1` (or absent). Survives
  // localStorage eviction in the same way the refresh cookie does.
  try {
    if (typeof document === "undefined") return;
    if (value) {
      // Long-lived (1 year), SameSite=Lax so it accompanies same-site
      // navigation. Path=/ so every route sees it.
      document.cookie = "pkhint=1; Max-Age=31536000; Path=/; SameSite=Lax";
    } else {
      document.cookie = "pkhint=; Max-Age=0; Path=/; SameSite=Lax";
    }
  } catch {
    // ignore — cookie write is best-effort
  }
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}

export function PasskeysCard() {
  const { toast } = useToast();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [registering, setRegistering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Credential | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window === "undefined" || !window.PublicKeyCredential) {
          if (!cancelled) setSupported(false);
          return;
        }
        const PKC = window.PublicKeyCredential as typeof window.PublicKeyCredential & {
          isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
        };
        if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
          if (!cancelled) setSupported(false);
          return;
        }
        const ok = await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
        if (!cancelled) setSupported(Boolean(ok));
      } catch {
        if (!cancelled) setSupported(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const { data, isLoading } = useQuery<{ credentials: Credential[] }>({
    queryKey: ['/api/auth/webauthn/credentials'],
  });
  const credentials = data?.credentials ?? [];

  // Mirror the "this account has at least one passkey" signal into localStorage
  // so the LoginForm can decide whether to show the Face ID button on this
  // device. Refreshed on every credential-list query so a multi-device signout
  // / removal stays consistent if the user re-opens Settings later.
  useEffect(() => {
    if (data) setHasPasskeyFlag(credentials.length > 0);
  }, [data, credentials.length]);

  const handleRegister = async () => {
    setRegistering(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");

      const beginRes = await apiRequest('POST', '/api/auth/webauthn/register/begin');
      const options = await beginRes.json();

      const attestation = await startRegistration({ optionsJSON: options });

      const finishRes = await apiRequest('POST', '/api/auth/webauthn/register/finish', {
        response: attestation,
      });
      await finishRes.json();

      setHasPasskeyFlag(true);
      queryClient.invalidateQueries({ queryKey: ['/api/auth/webauthn/credentials'] });
      toast({
        title: "Passkey added",
        description: "You can now sign in with Face ID or Touch ID on this device.",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not register passkey';
      const friendly = /NotAllowed|cancell?ed|aborted/i.test(message)
        ? 'Registration cancelled.'
        : message;
      toast({
        title: "Could not add passkey",
        description: friendly,
        variant: "destructive",
      });
    } finally {
      setRegistering(false);
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest('DELETE', `/api/auth/webauthn/credentials/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/auth/webauthn/credentials'] });
      toast({ title: "Passkey removed" });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not remove passkey",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5" />
          Sign-in methods
        </CardTitle>
        <CardDescription>
          Use Face ID, Touch ID, or your device PIN to sign in instantly. Passkeys are stored on this device and synced through iCloud Keychain or Google Password Manager.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {supported === false && (
          <div className="text-sm text-muted-foreground bg-muted/50 border rounded-md p-3">
            This device or browser does not support platform passkeys. Try the latest Safari or Chrome on a device with Face ID, Touch ID, Windows Hello, or a fingerprint reader.
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Add this device</p>
            <p className="text-sm text-muted-foreground">
              Register a passkey for one-tap sign-in on this device.
            </p>
          </div>
          <Button
            onClick={handleRegister}
            disabled={registering || supported !== true}
            data-testid="button-passkey-register"
            className="shrink-0"
          >
            <Fingerprint className="h-4 w-4 mr-2" />
            {registering ? "Waiting…" : "Set up Face ID / Touch ID for this device"}
          </Button>
        </div>

        <div className="border-t pt-4">
          <p className="text-sm font-medium mb-2">Registered passkeys</p>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys registered yet.</p>
          ) : (
            <ul className="space-y-2" data-testid="list-passkeys">
              {credentials.map((cred) => (
                <li
                  key={cred.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                  data-testid={`passkey-item-${cred.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{cred.deviceLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {formatDate(cred.createdAt)}
                      {cred.lastUsedAt ? ` · Last used ${formatDate(cred.lastUsedAt)}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(cred)}
                    disabled={deleteMutation.isPending}
                    data-testid={`button-passkey-remove-${cred.id}`}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              You will no longer be able to sign in from {confirmDelete?.deviceLabel || 'this device'} using Face ID or Touch ID. You can register it again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDelete) {
                  deleteMutation.mutate(confirmDelete.id, {
                    onSettled: () => setConfirmDelete(null),
                  });
                }
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-passkey-confirm-remove"
            >
              {deleteMutation.isPending ? "Removing…" : "Remove passkey"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
