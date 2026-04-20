import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { User } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export function AccountInfoCard() {
  const { data: currentUser } = useCurrentUser();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><User className="h-5 w-5" />Account Information</CardTitle>
        <CardDescription>Manage your account settings and preferences</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <h3 className="text-sm font-medium">Profile Information</h3>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <p className="text-sm" data-testid="text-user-name">{currentUser?.user.name || 'N/A'}</p>
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Email</Label>
              <p className="text-sm" data-testid="text-user-email">{currentUser?.user.email || 'N/A'}</p>
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Role</Label>
              <p className="text-sm capitalize" data-testid="text-user-role">{currentUser?.user.role || 'N/A'}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
