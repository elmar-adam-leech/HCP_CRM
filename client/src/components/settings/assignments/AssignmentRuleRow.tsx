import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Pencil, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { AssignmentRule, FIELD_LABELS, OPERATOR_LABELS } from "./types";

interface AssignmentRuleRowProps {
  rule: AssignmentRule;
  onEdit: (rule: AssignmentRule) => void;
  onDelete: (id: string) => void;
  onToggleActive: (id: string, isActive: boolean) => void;
}

export function AssignmentRuleRow({ rule, onEdit, onDelete, onToggleActive }: AssignmentRuleRowProps) {
  return (
    <div
      className="flex items-start gap-3 p-4 rounded-md border bg-card"
      data-testid={`assignment-rule-${rule.id}`}
    >
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <span className="text-xs text-muted-foreground font-mono w-6 text-center">{rule.priority}</span>
        <ChevronUp className="h-3 w-3 text-muted-foreground" />
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{rule.name}</span>
          {!rule.isActive && (
            <Badge variant="secondary" className="text-xs">Inactive</Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {rule.conditions.length === 0 ? (
            <span className="italic">Matches all leads</span>
          ) : (
            <span>
              {rule.conditions.map((c, i) => (
                <span key={i}>
                  {i > 0 && " AND "}
                  <span className="font-medium">{FIELD_LABELS[c.field]}</span>
                  {" "}{OPERATOR_LABELS[c.operator]}{" "}
                  <span className="font-medium">&ldquo;{c.value}&rdquo;</span>
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Assign to:{" "}
          <span className="font-medium">
            {rule.assignToUserName ?? <em>Unassigned</em>}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Switch
          checked={rule.isActive}
          onCheckedChange={(checked) => onToggleActive(rule.id, checked)}
          aria-label="Toggle rule active"
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onEdit(rule)}
          data-testid={`button-edit-rule-${rule.id}`}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onDelete(rule.id)}
          data-testid={`button-delete-rule-${rule.id}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
