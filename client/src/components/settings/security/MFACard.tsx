import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ShieldCheck, ShieldOff, Copy, Download } from "lucide-react";

export function MFACard() {
  const { toast } = useToast();

  // Current MFA status
  const { data: mfaStatus, isLoading } = useQuery<{ mfaEnabled: boolean }>({
    queryKey: ['/api/mfa/status'],
  });

  const [setupStep, setSetupStep] = useState<'idle' | 'scanning' | 'confirming' | 'done'>('idle');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [manualSecret, setManualSecret] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [showDisableDialog, setShowDisableDialog] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Setup MFA — get QR code
  const setupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/mfa/setup');
      return res.json();
    },
    onSuccess: (data) => {
      setQrDataUrl(data.qrDataUrl);
      setManualSecret(data.manualEntrySecret);
      setSetupStep('scanning');
    },
    onError: (err: any) => {
      toast({ title: "Setup failed", description: err.message, variant: "destructive" });
    },
  });

  // Confirm MFA — verify first code
  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/mfa/confirm', { code: confirmCode });
      return res.json();
    },
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setShowRecoveryModal(true);
      setSetupStep('done');
      queryClient.invalidateQueries({ queryKey: ['/api/mfa/status'] });
      toast({ title: "MFA enabled", description: "Two-factor authentication is now active." });
    },
    onError: (err: any) => {
      toast({ title: "Verification failed", description: err.message ?? "Invalid code. Try again.", variant: "destructive" });
    },
  });

  // Disable MFA
  const disableMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/mfa/disable', { code: disableCode });
      return res.json();
    },
    onSuccess: () => {
      setShowDisableDialog(false);
      setDisableCode('');
      setSetupStep('idle');
      queryClient.invalidateQueries({ queryKey: ['/api/mfa/status'] });
      toast({ title: "MFA disabled", description: "Two-factor authentication has been turned off." });
    },
    onError: (err: any) => {
      toast({ title: "Failed to disable MFA", description: err.message ?? "Invalid code.", variant: "destructive" });
    },
  });

  const handleCopySecret = () => {
    navigator.clipboard.writeText(manualSecret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  };

  const handleDownloadCodes = () => {
    const content = recoveryCodes.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Two-Factor Authentication</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-8 bg-muted rounded animate-pulse w-48" />
        </CardContent>
      </Card>
    );
  }

  const mfaEnabled = mfaStatus?.mfaEnabled ?? false;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Two-Factor Authentication (2FA)</CardTitle>
              <CardDescription className="mt-1">
                Add an extra layer of security using a TOTP authenticator app (Google Authenticator, Authy, etc.)
              </CardDescription>
            </div>
            <Badge variant={mfaEnabled ? "default" : "secondary"} className="shrink-0">
              {mfaEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {mfaEnabled ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="w-4 h-4 text-green-600" />
                Your account is protected with two-factor authentication.
              </div>
              <Button
                variant="outline"
                onClick={() => setShowDisableDialog(true)}
                className="flex items-center gap-2"
              >
                <ShieldOff className="w-4 h-4" />
                Disable 2FA
              </Button>
            </div>
          ) : setupStep === 'idle' ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Protect your account with a TOTP authenticator app. You will need to enter a 6-digit code at each login.
              </p>
              <Button onClick={() => setupMutation.mutate()} disabled={setupMutation.isPending}>
                <ShieldCheck className="w-4 h-4 mr-2" />
                {setupMutation.isPending ? "Setting up..." : "Enable 2FA"}
              </Button>
            </div>
          ) : setupStep === 'scanning' ? (
            <div className="space-y-4">
              <p className="text-sm font-medium">Step 1: Scan this QR code with your authenticator app</p>
              {qrDataUrl && (
                <img
                  src={qrDataUrl}
                  alt="MFA QR Code"
                  className="w-56 h-56 border rounded-md"
                />
              )}
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Can't scan the QR code? Enter this key manually:
                </p>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-muted px-2 py-1 rounded font-mono break-all">{manualSecret}</code>
                  <Button size="icon" variant="ghost" onClick={handleCopySecret}>
                    <Copy className="w-4 h-4" />
                  </Button>
                  {copiedSecret && <span className="text-xs text-green-600">Copied!</span>}
                </div>
              </div>
              <Button onClick={() => setSetupStep('confirming')}>
                Next: Enter verification code
              </Button>
            </div>
          ) : setupStep === 'confirming' ? (
            <div className="space-y-4">
              <p className="text-sm font-medium">Step 2: Enter the 6-digit code from your authenticator app</p>
              <div className="space-y-2 max-w-xs">
                <Label htmlFor="confirm-code">Verification Code</Label>
                <Input
                  id="confirm-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => confirmMutation.mutate()}
                  disabled={confirmCode.length !== 6 || confirmMutation.isPending}
                >
                  {confirmMutation.isPending ? "Verifying..." : "Verify & Activate"}
                </Button>
                <Button variant="outline" onClick={() => setSetupStep('scanning')}>Back</Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Disable MFA dialog */}
      <Dialog open={showDisableDialog} onOpenChange={setShowDisableDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable Two-Factor Authentication</DialogTitle>
            <DialogDescription>
              Enter your current 6-digit authenticator code to confirm. This will remove 2FA protection from your account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="disable-code">Authenticator Code</Label>
              <Input
                id="disable-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={() => disableMutation.mutate()}
                disabled={disableCode.length !== 6 || disableMutation.isPending}
              >
                {disableMutation.isPending ? "Disabling..." : "Disable 2FA"}
              </Button>
              <Button variant="outline" onClick={() => { setShowDisableDialog(false); setDisableCode(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Recovery codes modal — shown once */}
      <Dialog open={showRecoveryModal} onOpenChange={setShowRecoveryModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save Your Recovery Codes</DialogTitle>
            <DialogDescription>
              Store these codes in a safe place. Each code can only be used once. If you lose access to your authenticator app, you can use one of these codes to log in.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((code) => (
                <code key={code} className="text-xs font-mono bg-muted px-3 py-2 rounded text-center">
                  {code}
                </code>
              ))}
            </div>
            <Button onClick={handleDownloadCodes} className="w-full flex items-center gap-2">
              <Download className="w-4 h-4" />
              Download Recovery Codes
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              These codes will not be shown again.
            </p>
            <Button variant="outline" className="w-full" onClick={() => setShowRecoveryModal(false)}>
              I've saved my codes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
