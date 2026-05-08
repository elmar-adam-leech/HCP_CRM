/**
 * task #738 — post-first-login passkey enrollment prompt.
 *
 * Shown at most once per user account: after a successful PASSWORD-based
 * login, when the user has zero registered WebAuthn credentials AND has not
 * already dismissed the prompt (`users.passkey_prompt_dismissed_at` is
 * null). Both "Set up Face ID" and "Maybe later" record the dismissal so
 * the dialog never reappears uninvited — only the explicit Settings →
 * Security flow opens it again.
 *
 * Enrollment flow re-uses the existing `/api/auth/webauthn/register/begin`
 * + `/finish` endpoints — same code path the Settings card uses.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Fingerprint } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { CurrentUser } from "@/hooks/useCurrentUser";

interface Props {
  user: CurrentUser;
}

const HAS_PASSKEY_KEY = "hcp.webauthn.hasPasskey";

export function PasskeyEnrollmentPrompt({ user }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);

  // Eligibility: passwords-logged-in user, has zero passkeys, has never
  // dismissed the prompt, and the device actually has a platform
  // authenticator. The `passkeyCount` / `passkeyPromptDismissedAt` fields
  // are surfaced by /api/auth/me.
  const eligible = useMemo(() => {
    if (user.passkeyPromptDismissedAt) return false;
    if ((user.passkeyCount ?? 0) > 0) return false;
    return true;
  }, [user.passkeyPromptDismissedAt, user.passkeyCount]);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    (async () => {
      try {
        if (typeof window === "undefined" || !window.PublicKeyCredential) return;
        const PKC = window.PublicKeyCredential as typeof window.PublicKeyCredential & {
          isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
        };
        if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return;
        const ok = await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
        if (cancelled) return;
        setSupported(Boolean(ok));
        if (ok) setOpen(true);
      } catch {
        /* leave dialog closed on detection failure */
      }
    })();
    return () => { cancelled = true; };
  }, [eligible]);

  const recordDismissal = async () => {
    try {
      await apiRequest("POST", "/api/auth/passkey-prompt/dismiss");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    } catch {
      /* best-effort — UI will simply re-prompt next /me refresh */
    }
  };

  const handleDismiss = async () => {
    setOpen(false);
    void recordDismissal();
  };

  const handleEnroll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      // Server contract (server/routes/webauthn.ts:131): register/begin
      // returns the PublicKeyCredentialCreationOptionsJSON DIRECTLY (no
      // wrapper, no sessionId — the in-flight challenge is keyed by userId
      // server-side, not by a per-request session). register/finish only
      // needs `{ response, deviceLabel? }`.
      const begin = await apiRequest("POST", "/api/auth/webauthn/register/begin");
      const options = await begin.json();
      const attestation = await startRegistration({ optionsJSON: options });
      await apiRequest("POST", "/api/auth/webauthn/register/finish", {
        response: attestation,
        deviceLabel: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 40) : "PWA",
      });
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem(HAS_PASSKEY_KEY, "1");
        }
        if (typeof document !== "undefined") {
          document.cookie = "pkhint=1; Max-Age=31536000; Path=/; SameSite=Lax";
        }
      } catch { /* noop */ }
      toast({
        title: "Face ID set up",
        description: "Next time you open the app you can sign in with Face ID.",
      });
      setOpen(false);
      void recordDismissal();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not register passkey";
      toast({
        title: "Couldn't set up Face ID",
        description: msg.includes("NotAllowed") ? "Cancelled — you can try again from Settings → Security." : msg,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  if (!eligible || !supported) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void handleDismiss(); }}>
      <DialogContent data-testid="dialog-passkey-enrollment">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5" />
            Sign in faster with Face ID
          </DialogTitle>
          <DialogDescription>
            Set up Face ID on this device so you don't have to type your password
            next time. You can always sign in with your password too.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 flex-wrap">
          <Button
            variant="ghost"
            onClick={handleDismiss}
            disabled={busy}
            data-testid="button-passkey-prompt-dismiss"
          >
            Maybe later
          </Button>
          <Button
            onClick={handleEnroll}
            disabled={busy}
            data-testid="button-passkey-prompt-enroll"
          >
            <Fingerprint className="h-4 w-4 mr-2" />
            {busy ? "Setting up…" : "Set up Face ID"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
