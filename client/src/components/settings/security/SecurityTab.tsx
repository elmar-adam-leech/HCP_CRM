import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Shield, LogOut } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { MFACard } from "./MFACard";
import { PasskeysCard } from "./PasskeysCard";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";

export function SecurityTab() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { data: currentUser } = useCurrentUser();
  const isAdmin = isStrictAdmin(currentUser?.user?.role);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const handleLogoutCompany = async () => {
    setIsPending(true);
    try {
      const result = await apiRequest("POST", "/api/auth/logout-company");
      const data = await result.json();
      // Clear the IDB-stored refresh token (task #720) — this user's own session
      // is also being terminated by logout-company.
      try {
        const { clearStoredRefreshToken } = await import("@/lib/refresh-token-storage");
        await clearStoredRefreshToken();
      } catch {}
      toast({
        title: "All company users signed out",
        description: data.message ?? "Every active session across your company has been ended.",
      });
      setTimeout(() => setLocation("/login"), 800);
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to sign out company users",
        variant: "destructive",
      });
    } finally {
      setIsPending(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <MFACard />
      <PasskeysCard />

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Security Settings
            </CardTitle>
            <CardDescription>Manage company-wide security controls</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Sign out all company users</p>
                <p className="text-sm text-muted-foreground">
                  Immediately ends every active session for all users in your company. Use this if you suspect unauthorized access or a security breach.
                </p>
              </div>
              <Button
                variant="destructive"
                className="shrink-0 sm:w-auto w-full"
                onClick={() => setConfirmOpen(true)}
                data-testid="button-logout-all"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Sign out all users
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out all company users?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately end all active sessions for every user in your company — including yours. Everyone will be redirected to the login page. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLogoutCompany}
              disabled={isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-logout-all"
            >
              {isPending ? "Signing out..." : "Sign out all users"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
