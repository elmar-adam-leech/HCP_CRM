import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Users } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUsers } from "@/hooks/useUsers";
import { AssignmentRule, RuleFormState, AssignmentCondition, EMPTY_FORM } from "./types";
import { AssignmentRuleRow } from "./AssignmentRuleRow";
import { AssignmentRuleDialog } from "./AssignmentRuleDialog";

export function AssignmentsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingRule, setEditingRule] = useState<AssignmentRule | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);

  const { data: rules = [], isLoading } = useQuery<AssignmentRule[]>({
    queryKey: ["/api/assignment-rules"],
  });

  const { data: usersData = [] } = useUsers();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/assignment-rules"] });

  const createMutation = useMutation({
    mutationFn: async (data: RuleFormState) => {
      const res = await apiRequest("POST", "/api/assignment-rules", {
        name: data.name,
        conditions: data.conditions,
        assignToUserId: data.assignToUserId || null,
        priority: data.priority,
        isActive: data.isActive,
      });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setIsCreating(false);
      setForm(EMPTY_FORM);
      toast({ title: "Rule created" });
    },
    onError: () => toast({ title: "Failed to create rule", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<RuleFormState> }) => {
      const res = await apiRequest("PATCH", `/api/assignment-rules/${id}`, {
        name: data.name,
        conditions: data.conditions,
        assignToUserId: data.assignToUserId || null,
        priority: data.priority,
        isActive: data.isActive,
      });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setEditingRule(null);
      setForm(EMPTY_FORM);
      toast({ title: "Rule updated" });
    },
    onError: () => toast({ title: "Failed to update rule", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/assignment-rules/${id}`);
    },
    onSuccess: () => {
      invalidate();
      setDeletingRuleId(null);
      toast({ title: "Rule deleted" });
    },
    onError: () => toast({ title: "Failed to delete rule", variant: "destructive" }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/assignment-rules/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => invalidate(),
    onError: () => toast({ title: "Failed to update rule", variant: "destructive" }),
  });

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setIsCreating(true);
  };

  const openEdit = (rule: AssignmentRule) => {
    setForm({
      name: rule.name,
      conditions: rule.conditions,
      assignToUserId: rule.assignToUserId ?? "",
      priority: rule.priority,
      isActive: rule.isActive,
    });
    setEditingRule(rule);
  };

  const closeModal = () => {
    setIsCreating(false);
    setEditingRule(null);
    setForm(EMPTY_FORM);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) {
      toast({ title: "Rule name is required", variant: "destructive" });
      return;
    }
    if (editingRule) {
      updateMutation.mutate({ id: editingRule.id, data: form });
    } else {
      createMutation.mutate(form);
    }
  };

  const handleFormChange = (update: Partial<RuleFormState>) => {
    setForm(prev => ({ ...prev, ...update }));
  };

  const addCondition = () => {
    setForm(prev => ({
      ...prev,
      conditions: [...prev.conditions, { field: "source", operator: "equals", value: "" }],
    }));
  };

  const removeCondition = (index: number) => {
    setForm(prev => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
    }));
  };

  const updateCondition = (index: number, update: Partial<AssignmentCondition>) => {
    setForm(prev => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => i === index ? { ...c, ...update } : c),
    }));
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Assignment Rules
              </CardTitle>
              <CardDescription className="mt-1">
                Automatically assign incoming leads to team members based on conditions. Rules are evaluated in priority order.
              </CardDescription>
            </div>
            <Button onClick={openCreate} data-testid="button-create-assignment-rule">
              <Plus className="h-4 w-4 mr-2" />
              Add Rule
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-4">Loading rules...</div>
          ) : rules.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No assignment rules yet.</p>
              <p className="text-xs mt-1">Create a rule to automatically assign leads to team members.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {rules.map((rule) => (
                <AssignmentRuleRow
                  key={rule.id}
                  rule={rule}
                  onEdit={openEdit}
                  onDelete={setDeletingRuleId}
                  onToggleActive={(id, isActive) => toggleActiveMutation.mutate({ id, isActive })}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AssignmentRuleDialog
        open={isCreating || !!editingRule}
        editingRule={editingRule}
        form={form}
        isPending={isPending}
        users={usersData}
        onClose={closeModal}
        onSubmit={handleSubmit}
        onFormChange={handleFormChange}
        onAddCondition={addCondition}
        onRemoveCondition={removeCondition}
        onUpdateCondition={updateCondition}
      />

      <AlertDialog open={!!deletingRuleId} onOpenChange={(open) => { if (!open) setDeletingRuleId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Assignment Rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the rule. Leads already assigned will keep their assignment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingRuleId && deleteMutation.mutate(deletingRuleId)}
              className="bg-destructive text-destructive-foreground"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
