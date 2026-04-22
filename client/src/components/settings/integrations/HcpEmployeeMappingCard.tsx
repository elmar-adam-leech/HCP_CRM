import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Users } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const UNLINKED_VALUE = "__unlinked__";

interface HcpEmployeeRow {
  id: string;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  isActive: boolean | null;
  userContractorId: string | null;
  linkedUserId: string | null;
  linkedName: string | null;
  linkedEmail: string | null;
  linkedIsSalesperson: boolean | null;
}

interface SalespersonOption {
  userContractorId: string;
  userId: string;
  name: string;
  email: string;
  isSalesperson: boolean;
  role: string;
}

function fullName(emp: HcpEmployeeRow): string {
  const parts = [emp.firstName, emp.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : (emp.email ?? "(no name)");
}

export function HcpEmployeeMappingCard() {
  const { toast } = useToast();
  const [savingId, setSavingId] = useState<string | null>(null);

  const employeesQuery = useQuery<HcpEmployeeRow[]>({
    queryKey: ["/api/integrations/hcp/employees"],
  });

  const optionsQuery = useQuery<SalespersonOption[]>({
    queryKey: ["/api/integrations/hcp/salesperson-options"],
  });

  const linkMutation = useMutation({
    mutationFn: async (vars: { id: string; userContractorId: string | null }) => {
      return apiRequest("PATCH", `/api/integrations/hcp/employees/${vars.id}`, {
        userContractorId: vars.userContractorId,
      });
    },
    onMutate: (vars) => setSavingId(vars.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/hcp/employees"] });
      toast({ title: "Link updated" });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to update link",
        description: err?.message ?? "Unexpected error",
        variant: "destructive",
      });
    },
    onSettled: () => setSavingId(null),
  });

  const backfillMutation = useMutation<{ estimatesUpdated: number; jobsUpdated: number }>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/hcp/backfill-assignments", {});
      return (await res.json()) as { estimatesUpdated: number; jobsUpdated: number };
    },
    onSuccess: (data) => {
      toast({
        title: "Backfill complete",
        description: `${data.estimatesUpdated} estimates and ${data.jobsUpdated} jobs updated.`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Backfill failed",
        description: err?.message ?? "Unexpected error",
        variant: "destructive",
      });
    },
  });

  const isLoading = employeesQuery.isLoading || optionsQuery.isLoading;

  return (
    <Card data-testid="card-hcp-employee-mapping">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-muted p-2">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>HCP Employee Mapping</CardTitle>
              <CardDescription>
                Link Housecall Pro employees to your CRM users so estimates and jobs are
                attributed to the correct salesperson.
              </CardDescription>
            </div>
          </div>
          <Button
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            data-testid="button-backfill-assignments"
          >
            {backfillMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Backfill assignments
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : employeesQuery.data && employeesQuery.data.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No Housecall Pro employees have been synced yet.
          </div>
        ) : (
          <div className="divide-y">
            {employeesQuery.data?.map((emp) => {
              const value = emp.userContractorId ?? UNLINKED_VALUE;
              const isSaving = savingId === emp.id && linkMutation.isPending;
              return (
                <div
                  key={emp.id}
                  className="flex items-center justify-between gap-3 py-3 flex-wrap"
                  data-testid={`row-hcp-employee-${emp.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{fullName(emp)}</div>
                      {emp.email && (
                        <div className="text-xs text-muted-foreground truncate">{emp.email}</div>
                      )}
                    </div>
                    {emp.isActive === false && (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={value}
                      disabled={isSaving}
                      onValueChange={(v) => {
                        const next = v === UNLINKED_VALUE ? null : v;
                        if (next === emp.userContractorId) return;
                        linkMutation.mutate({ id: emp.id, userContractorId: next });
                      }}
                    >
                      <SelectTrigger className="w-[260px]" data-testid={`select-link-${emp.id}`}>
                        <SelectValue placeholder="Not linked" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNLINKED_VALUE}>Not linked</SelectItem>
                        {optionsQuery.data?.map((opt) => (
                          <SelectItem key={opt.userContractorId} value={opt.userContractorId}>
                            {opt.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {isSaving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
