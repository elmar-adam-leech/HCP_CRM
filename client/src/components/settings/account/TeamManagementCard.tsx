import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Users, UserPlus, Search, Pencil } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";
import { useUsers } from "@/hooks/useUsers";

const INTEGRATION_OPTIONS = [
  { key: 'facebook-leads', label: 'Facebook Lead Ads' },
  { key: 'housecall-pro', label: 'Housecall Pro' },
  { key: 'dialpad', label: 'Dialpad' },
  { key: 'gmail', label: 'Gmail' },
  { key: 'lead-capture', label: 'Lead Capture Inbox' },
  { key: 'sendgrid', label: 'SendGrid' },
] as const;

type UserRow = { id: string; name: string; email: string; role: string; contractorId: string; createdAt: string; canManageIntegrations?: boolean; allowedIntegrations?: string[] | null };

function getInitials(name: string): string {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

export function TeamManagementCard() {
  const { toast } = useToast();
  const { data: currentUser } = useCurrentUser();
  const isAdmin = isStrictAdmin(currentUser?.user?.role);
  const viewerRole = currentUser?.user?.role ?? '';

  const { data: allUsers = [], isLoading: usersLoading } = useUsers();

  const [isAddUserDialogOpen, setIsAddUserDialogOpen] = useState(false);
  const [newUserData, setNewUserData] = useState({ name: "", email: "", password: "", role: "user" });
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [isEditUserDialogOpen, setIsEditUserDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editAllowedIntegrations, setEditAllowedIntegrations] = useState<string[]>([]);

  const addUserMutation = useMutation({
    mutationFn: async (data: typeof newUserData) => apiRequest('POST', '/api/users', data),
    onSuccess: () => {
      toast({ title: "User added", description: "The user has been added successfully" });
      setIsAddUserDialogOpen(false);
      setNewUserData({ name: "", email: "", password: "", role: "user" });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to add user", description: error.message, variant: "destructive" });
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: async ({ userId, role, allowedIntegrations }: { userId: string; role: string; allowedIntegrations: string[] }) => {
      const canManageIntegrations = allowedIntegrations.length > 0;
      return apiRequest('PATCH', `/api/users/${userId}`, {
        role,
        canManageIntegrations,
        allowedIntegrations: canManageIntegrations ? allowedIntegrations : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      toast({ title: "User updated", description: `${editingUser?.name}'s permissions have been updated.` });
      setIsEditUserDialogOpen(false);
      setEditingUser(null);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update user", description: error.message, variant: "destructive" });
    },
  });

  const handleOpenEditUser = (user: UserRow) => {
    setEditingUser(user);
    setEditRole(user.role);
    const existing = user.allowedIntegrations ?? (user.canManageIntegrations ? INTEGRATION_OPTIONS.map(o => o.key) : []);
    setEditAllowedIntegrations([...existing]);
    setIsEditUserDialogOpen(true);
  };

  const toggleIntegration = (key: string) => {
    setEditAllowedIntegrations(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleSaveEditUser = () => {
    if (!editingUser) return;
    const roleChanged = editRole !== editingUser.role;
    const prevAllowed = editingUser.allowedIntegrations ?? (editingUser.canManageIntegrations ? INTEGRATION_OPTIONS.map(o => o.key) : []);
    const permChanged = JSON.stringify([...editAllowedIntegrations].sort()) !== JSON.stringify([...prevAllowed].sort());
    if (!roleChanged && !permChanged) { setIsEditUserDialogOpen(false); return; }
    updateUserMutation.mutate({ userId: editingUser.id, role: editRole, allowedIntegrations: editAllowedIntegrations });
  };

  const filteredUsers = allUsers.filter((user) =>
    userSearchQuery === '' ||
    user.name.toLowerCase().includes(userSearchQuery.toLowerCase()) ||
    user.email.toLowerCase().includes(userSearchQuery.toLowerCase())
  );

  if (!isAdmin) return null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" />Team Management</CardTitle>
              <CardDescription>Manage user accounts and permissions for your organization</CardDescription>
            </div>
            <Dialog open={isAddUserDialogOpen} onOpenChange={setIsAddUserDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" data-testid="button-add-user"><UserPlus className="h-4 w-4 mr-2" />Add User</Button>
              </DialogTrigger>
              <DialogContent data-testid="dialog-add-user">
                <DialogHeader>
                  <DialogTitle>Add New User</DialogTitle>
                  <DialogDescription>Create a new user account for your organization</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Full Name</Label>
                    <Input id="name" placeholder="John Doe" value={newUserData.name} onChange={(e) => setNewUserData({ ...newUserData, name: e.target.value })} data-testid="input-name" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" placeholder="john.doe@example.com" value={newUserData.email} onChange={(e) => setNewUserData({ ...newUserData, email: e.target.value })} data-testid="input-email" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input id="password" type="password" placeholder="••••••••" value={newUserData.password} onChange={(e) => setNewUserData({ ...newUserData, password: e.target.value })} data-testid="input-password" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="role">Role</Label>
                    <Select value={newUserData.role} onValueChange={(value) => setNewUserData({ ...newUserData, role: value })}>
                      <SelectTrigger id="role" data-testid="select-role"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">User</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                        {viewerRole === 'super_admin' && <SelectItem value="super_admin">Super Admin</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => { setIsAddUserDialogOpen(false); setNewUserData({ name: "", email: "", password: "", role: "user" }); }} data-testid="button-cancel-add-user">Cancel</Button>
                    <Button
                      onClick={() => addUserMutation.mutate(newUserData)}
                      disabled={!newUserData.name || !newUserData.email || !newUserData.password || addUserMutation.isPending}
                      data-testid="button-create-user"
                    >
                      {addUserMutation.isPending ? "Creating..." : "Create User"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search users..." value={userSearchQuery} onChange={(e) => setUserSearchQuery(e.target.value)} className="pl-9" data-testid="input-search-users" />
            </div>
            {usersLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading users...</div>
            ) : (
              <div className="space-y-2">
                {filteredUsers.map((user) => (
                  <div key={user.id} className="flex items-center justify-between p-3 rounded-lg border bg-card" data-testid={`user-item-${user.id}`}>
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <span className="text-sm font-medium text-primary">{getInitials(user.name)}</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium" data-testid={`text-user-name-${user.id}`}>{user.name}</p>
                        <p className="text-xs text-muted-foreground" data-testid={`text-user-email-${user.id}`}>{user.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="capitalize" data-testid={`badge-role-${user.id}`}>{user.role.replace('_', ' ')}</Badge>
                      {user.id !== currentUser?.user?.id && (
                        <Button size="icon" variant="ghost" onClick={() => handleOpenEditUser(user)} data-testid={`button-edit-user-${user.id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {filteredUsers.length === 0 && <div className="text-center py-8 text-muted-foreground">No users found</div>}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={isEditUserDialogOpen} onOpenChange={setIsEditUserDialogOpen}>
        <DialogContent data-testid="dialog-edit-user">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>Update role and permissions for {editingUser?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger id="edit-role" data-testid="select-edit-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  {viewerRole === 'super_admin' && <SelectItem value="super_admin">Super Admin</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            {editRole !== 'admin' && editRole !== 'super_admin' && (
              <div className="space-y-2 pt-1">
                <Label className="text-sm">Integration Access</Label>
                <p className="text-xs text-muted-foreground">Select which integrations this user can manage</p>
                <div className="grid grid-cols-1 gap-2 pt-1">
                  {INTEGRATION_OPTIONS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-3">
                      <Checkbox
                        id={`integration-${key}`}
                        checked={editAllowedIntegrations.includes(key)}
                        onCheckedChange={() => toggleIntegration(key)}
                        data-testid={`checkbox-integration-${key}`}
                      />
                      <Label htmlFor={`integration-${key}`} className="text-sm cursor-pointer font-normal">{label}</Label>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsEditUserDialogOpen(false); setEditingUser(null); }}>Cancel</Button>
            <Button onClick={handleSaveEditUser} disabled={updateUserMutation.isPending} data-testid="button-save-edit-user">
              {updateUserMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
