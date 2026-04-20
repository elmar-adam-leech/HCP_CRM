import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";
import { useUsers } from "@/hooks/useUsers";
import { useDialpadPhoneNumbers } from "@/hooks/useDialpadPhoneNumbers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { UserPlus, Mail, Shield, Search, ArrowLeft, Key, Check, X, ChevronLeft, ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Link } from "wouter";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  contractorId: string;
  dialpadDefaultNumber?: string | null;
  canManageIntegrations?: boolean;
  mfaEnabled?: boolean;
  createdAt: string;
};

type PhonePermission = {
  id: string;
  userId: string;
  phoneNumberId: string;
  phoneNumber?: string;
  displayName?: string;
  canSendSms: boolean;
  canMakeCalls: boolean;
  isActive: boolean;
};

const PAGE_SIZE = 5;

export default function UserManagement() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  useWebSocketInvalidation([
    { types: ['user_updated', 'user_created', 'user_deleted'], queryKeys: ['/api/users'] },
  ]);
  const [isAddUserDialogOpen, setIsAddUserDialogOpen] = useState(false);
  const [newUserData, setNewUserData] = useState({ 
    name: "", 
    email: "", 
    password: "", 
    role: "user" 
  });
  const [isPermissionsDialogOpen, setIsPermissionsDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  // Fetch all users
  const { data: users = [], isLoading } = useUsers();

  // Fetch available Dialpad phone numbers
  const { data: dialpadPhoneNumbers = [] } = useDialpadPhoneNumbers();

  // Fetch user phone permissions
  const { data: userPermissions = [], refetch: refetchPermissions } = useQuery<PhonePermission[]>({
    queryKey: ['/api/users', selectedUser?.id, 'phone-permissions'],
    enabled: !!selectedUser && isPermissionsDialogOpen,
  });

  // Add user mutation
  const addUserMutation = useMutation({
    mutationFn: async (data: { name: string; email: string; password: string; role: string }) => {
      return await apiRequest('POST', '/api/users', data);
    },
    onSuccess: () => {
      toast({
        title: "User added",
        description: "The user has been added successfully",
      });
      setIsAddUserDialogOpen(false);
      setNewUserData({ name: "", email: "", password: "", role: "user" });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to add user",
        description: error.message,
        variant: "destructive",
      });
    },
  });


  // Grant/update permission mutation
  const grantPermissionMutation = useMutation({
    mutationFn: async (data: { phoneNumberId: string; userId: string; canSendSms: boolean; canMakeCalls: boolean }) => {
      return await apiRequest('POST', `/api/dialpad/phone-numbers/${data.phoneNumberId}/permissions`, {
        userId: data.userId,
        canSendSms: data.canSendSms,
        canMakeCalls: data.canMakeCalls
      });
    },
    onSuccess: () => {
      refetchPermissions();
      toast({
        title: "Permission updated",
        description: "Phone number permission has been updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update permission",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Toggle integration permission mutation
  const toggleIntegrationPermissionMutation = useMutation({
    mutationFn: async (data: { userId: string; canManageIntegrations: boolean }) => {
      return await apiRequest('PATCH', `/api/users/${data.userId}/integration-permission`, {
        canManageIntegrations: data.canManageIntegrations
      });
    },
    onMutate: async (newData) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['/api/users'] });

      // Snapshot the previous value
      const previousUsers = queryClient.getQueryData<User[]>(['/api/users']);

      // Optimistically update to the new value
      if (previousUsers) {
        queryClient.setQueryData<User[]>(['/api/users'], (old) =>
          old?.map((user) =>
            user.id === newData.userId
              ? { ...user, canManageIntegrations: newData.canManageIntegrations }
              : user
          ) || []
        );
      }

      // Return a context object with the snapshotted value
      return { previousUsers };
    },
    onSuccess: () => {
      toast({
        title: "Integration permission updated",
        description: "User integration permission has been updated successfully",
      });
    },
    onError: (error: Error, _newData, context) => {
      // Rollback to the previous value on error
      if (context?.previousUsers) {
        queryClient.setQueryData(['/api/users'], context.previousUsers);
      }
      toast({
        title: "Failed to update permission",
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      // Always refetch after error or success to ensure we have the latest data
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
    },
  });

  const handleAddUser = () => {
    if (!newUserData.name || !newUserData.email || !newUserData.password) {
      toast({
        title: "All fields required",
        description: "Please fill in all fields",
        variant: "destructive",
      });
      return;
    }
    addUserMutation.mutate(newUserData);
  };

  const handleManagePermissions = (user: User) => {
    setSelectedUser(user);
    setIsPermissionsDialogOpen(true);
  };

  // Admins and managers have implicit access, no need for auto-grant
  // The backend automatically grants them access to all phone numbers

  const togglePermission = (phoneNumberId: string, type: 'sms' | 'calls', currentValue: boolean) => {
    if (!selectedUser) return;
    
    const existingPerm = userPermissions.find(p => p.phoneNumberId === phoneNumberId);
    const canSendSms = type === 'sms' ? !currentValue : (existingPerm?.canSendSms || false);
    const canMakeCalls = type === 'calls' ? !currentValue : (existingPerm?.canMakeCalls || false);

    grantPermissionMutation.mutate({
      phoneNumberId,
      userId: selectedUser.id,
      canSendSms,
      canMakeCalls
    });
  };

  const hasPermission = (phoneNumberId: string) => {
    return userPermissions.find(p => p.phoneNumberId === phoneNumberId);
  };

  const getRoleBadge = (role: string) => {
    const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline", color: string }> = {
      super_admin: { variant: "destructive", color: "red" },
      admin: { variant: "default", color: "blue" },
      manager: { variant: "secondary", color: "purple" },
      user: { variant: "outline", color: "gray" },
    };
    const config = variants[role] || variants.user;
    return (
      <Badge variant={config.variant} data-testid={`badge-role-${role}`}>
        {role.replace('_', ' ').toUpperCase()}
      </Badge>
    );
  };

  const filteredUsers = users.filter(user =>
    user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(1, currentPage), totalPages);
  const pagedUsers = filteredUsers.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  return (
    <div className="p-6 space-y-6">
      <Link href="/settings">
        <Button variant="ghost" size="sm" data-testid="button-back-to-settings">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
      </Link>
      
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">User Management</h1>
          <p className="text-muted-foreground">Manage users and permissions</p>
        </div>
        <Dialog open={isAddUserDialogOpen} onOpenChange={setIsAddUserDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-user">
              <UserPlus className="h-4 w-4 mr-2" />
              Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New User</DialogTitle>
              <DialogDescription>
                Create a new user account for your team
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-name">Full Name</Label>
                <Input
                  id="new-name"
                  type="text"
                  placeholder="John Doe"
                  value={newUserData.name}
                  onChange={(e) => setNewUserData({ ...newUserData, name: e.target.value })}
                  data-testid="input-new-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-email">Email Address</Label>
                <div className="relative">
                  <Mail className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="new-email"
                    type="email"
                    placeholder="user@example.com"
                    value={newUserData.email}
                    onChange={(e) => setNewUserData({ ...newUserData, email: e.target.value })}
                    className="pl-8"
                    data-testid="input-new-email"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  placeholder="••••••••"
                  value={newUserData.password}
                  onChange={(e) => setNewUserData({ ...newUserData, password: e.target.value })}
                  data-testid="input-new-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-role">Role</Label>
                <div className="relative">
                  <Shield className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground z-10" />
                  <Select
                    value={newUserData.role}
                    onValueChange={(value) => setNewUserData({ ...newUserData, role: value })}
                  >
                    <SelectTrigger className="pl-8" data-testid="select-new-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button
                onClick={handleAddUser}
                className="w-full"
                disabled={addUserMutation.isPending}
                data-testid="button-create-user"
              >
                {addUserMutation.isPending ? "Creating..." : "Create User"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Dialog open={isPermissionsDialogOpen} onOpenChange={setIsPermissionsDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Manage Phone Number Permissions</DialogTitle>
            <DialogDescription>
              {selectedUser?.role === 'admin' || selectedUser?.role === 'manager' 
                ? `${selectedUser?.name} has automatic access to all phone numbers (${selectedUser?.role} role)`
                : `Grant or revoke phone number permissions for ${selectedUser?.name}`
              }
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4">
            {dialpadPhoneNumbers.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No phone numbers available</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[200px]">Phone Number</TableHead>
                      <TableHead className="text-center w-20">SMS</TableHead>
                      <TableHead className="text-center w-24">Calling</TableHead>
                      <TableHead className="text-center w-32">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dialpadPhoneNumbers.map((phone) => {
                      // Admins and managers have implicit access to all phone numbers
                      const isAdminOrManager = selectedUser?.role === 'admin' || selectedUser?.role === 'manager';
                      const permission = hasPermission(phone.id);
                      const hasSms = isAdminOrManager ? true : (permission?.canSendSms || false);
                      const hasCalls = isAdminOrManager ? true : (permission?.canMakeCalls || false);
                      const isActive = isAdminOrManager ? true : (permission?.isActive || false);

                      return (
                        <TableRow key={phone.id}>
                          <TableCell>
                            <div>
                              <div className="font-medium">{phone.displayName || phone.phoneNumber}</div>
                              {phone.displayName && (
                                <div className="text-sm text-muted-foreground">{phone.phoneNumber}</div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-center">
                            <Checkbox
                              checked={hasSms}
                              onCheckedChange={() => togglePermission(phone.id, 'sms', hasSms)}
                              disabled={isAdminOrManager || grantPermissionMutation.isPending}
                              data-testid={`checkbox-sms-${phone.id}`}
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            <Checkbox
                              checked={hasCalls}
                              onCheckedChange={() => togglePermission(phone.id, 'calls', hasCalls)}
                              disabled={isAdminOrManager || grantPermissionMutation.isPending}
                              data-testid={`checkbox-calls-${phone.id}`}
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            {isActive ? (
                              <Badge variant="default" className="gap-1" data-testid={`badge-status-${phone.id}`}>
                                <Check className="h-3 w-3" />
                                {isAdminOrManager ? 'Always Active' : 'Active'}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="gap-1" data-testid={`badge-status-${phone.id}`}>
                                <X className="h-3 w-3" />
                                No Access
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          <div className="flex justify-end pt-4 border-t">
            <Button
              onClick={() => {
                setIsPermissionsDialogOpen(false);
                setSelectedUser(null);
              }}
              data-testid="button-close-permissions"
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Team Members</CardTitle>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8"
              data-testid="input-search-users"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading users...</p>
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No users found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-center">Integrations</TableHead>
                  <TableHead className="text-center">2FA</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedUsers.map((user) => (
                  <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                    <TableCell className="font-medium" data-testid={`text-user-name-${user.id}`}>
                      {user.name}
                    </TableCell>
                    <TableCell data-testid={`text-user-email-${user.id}`}>{user.email}</TableCell>
                    <TableCell>{getRoleBadge(user.role)}</TableCell>
                    <TableCell className="text-center" data-testid={`cell-integrations-${user.id}`}>
                      <div className="flex justify-center">
                        <Checkbox
                          checked={user.role === 'admin' || user.role === 'super_admin' || user.role === 'manager' || user.canManageIntegrations === true}
                          disabled={user.role === 'admin' || user.role === 'super_admin' || user.role === 'manager' || toggleIntegrationPermissionMutation.isPending}
                          onCheckedChange={(checked) => {
                            toggleIntegrationPermissionMutation.mutate({
                              userId: user.id,
                              canManageIntegrations: checked as boolean
                            });
                          }}
                          data-testid={`checkbox-integrations-${user.id}`}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-center" data-testid={`cell-mfa-${user.id}`}>
                      {user.mfaEnabled ? (
                        <Badge variant="secondary" className="text-xs">Enabled</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">Off</span>
                      )}
                    </TableCell>
                    <TableCell data-testid={`text-user-joined-${user.id}`}>
                      {new Date(user.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleManagePermissions(user)}
                        data-testid={`button-manage-permissions-${user.id}`}
                      >
                        <Key className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {filteredUsers.length > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-4" data-testid="pagination-controls">
              <p className="text-sm text-muted-foreground">
                Showing {(clampedPage - 1) * PAGE_SIZE + 1}–{Math.min(clampedPage * PAGE_SIZE, filteredUsers.length)} of {filteredUsers.length} users
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={clampedPage === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm" data-testid="text-page-indicator">
                  Page {clampedPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={clampedPage === totalPages}
                  data-testid="button-next-page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
