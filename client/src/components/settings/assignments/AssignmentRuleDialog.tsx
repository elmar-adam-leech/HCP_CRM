import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, X } from "lucide-react";
import { AssignmentRule, RuleFormState, AssignmentCondition, FIELD_LABELS, OPERATOR_LABELS } from "./types";

interface AssignmentRuleDialogProps {
  open: boolean;
  editingRule: AssignmentRule | null;
  form: RuleFormState;
  isPending: boolean;
  users: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: () => void;
  onFormChange: (update: Partial<RuleFormState>) => void;
  onAddCondition: () => void;
  onRemoveCondition: (index: number) => void;
  onUpdateCondition: (index: number, update: Partial<AssignmentCondition>) => void;
}

export function AssignmentRuleDialog({
  open,
  editingRule,
  form,
  isPending,
  users,
  onClose,
  onSubmit,
  onFormChange,
  onAddCondition,
  onRemoveCondition,
  onUpdateCondition,
}: AssignmentRuleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingRule ? "Edit Assignment Rule" : "New Assignment Rule"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Rule Name</Label>
            <Input
              id="rule-name"
              placeholder="e.g. Facebook leads to John"
              value={form.name}
              onChange={(e) => onFormChange({ name: e.target.value })}
              data-testid="input-rule-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rule-assign-to">Assign To</Label>
            <Select
              value={form.assignToUserId}
              onValueChange={(val) => onFormChange({ assignToUserId: val === "__none__" ? "" : val })}
            >
              <SelectTrigger id="rule-assign-to" data-testid="select-assign-to">
                <SelectValue placeholder="Select a team member..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— No assignment —</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rule-priority">Priority (lower runs first)</Label>
            <Input
              id="rule-priority"
              type="number"
              min={0}
              value={form.priority}
              onChange={(e) => onFormChange({ priority: parseInt(e.target.value) || 0 })}
              data-testid="input-rule-priority"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Conditions</Label>
              <Button variant="outline" size="sm" onClick={onAddCondition} data-testid="button-add-condition">
                <Plus className="h-3 w-3 mr-1" />
                Add Condition
              </Button>
            </div>
            {form.conditions.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No conditions — this rule will match all leads.
              </p>
            ) : (
              <div className="space-y-2">
                {form.conditions.map((cond, idx) => (
                  <div key={idx} className="flex items-center gap-2 flex-wrap">
                    <Select
                      value={cond.field}
                      onValueChange={(val) => onUpdateCondition(idx, { field: val as AssignmentCondition["field"] })}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(FIELD_LABELS).map(([v, l]) => (
                          <SelectItem key={v} value={v}>{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={cond.operator}
                      onValueChange={(val) => onUpdateCondition(idx, { operator: val as AssignmentCondition["operator"] })}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(OPERATOR_LABELS).map(([v, l]) => (
                          <SelectItem key={v} value={v}>{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="flex-1 min-w-24"
                      placeholder="Value..."
                      value={cond.value}
                      onChange={(e) => onUpdateCondition(idx, { value: e.target.value })}
                    />
                    <Button size="icon" variant="ghost" onClick={() => onRemoveCondition(idx)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="rule-active"
              checked={form.isActive}
              onCheckedChange={(val) => onFormChange({ isActive: val })}
            />
            <Label htmlFor="rule-active">Active</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onSubmit} disabled={isPending} data-testid="button-save-rule">
            {isPending ? "Saving..." : "Save Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
