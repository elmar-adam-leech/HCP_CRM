import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Trash2, Plus, Ban, Mail, Link, Sparkles, ChevronUp, Settings2, Save } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { crmFieldEnum, type CrmField, type FieldMapping } from "@shared/schema";

type SenderRuleAction = "block" | "each_email_is_new_lead" | "follow_link" | "default";

interface SenderRule {
  senderEmail: string;
  actions: SenderRuleAction[];
  action?: SenderRuleAction;
  fieldMappings?: FieldMapping[];
  spamOverride?: "none" | "always_allow" | "always_block";
  urlPattern?: string;
}

function normalizeRule(rule: SenderRule): SenderRule {
  const actions = rule.actions && rule.actions.length > 0
    ? rule.actions
    : rule.action ? [rule.action] : ['default' as const];
  return { ...rule, actions };
}

const ACTION_LABELS: Record<SenderRuleAction, string> = {
  block: "Block",
  each_email_is_new_lead: "Each email is a new lead",
  follow_link: "Follow link",
  default: "Default",
};

const ACTION_ICONS: Record<SenderRuleAction, typeof Ban> = {
  block: Ban,
  each_email_is_new_lead: Mail,
  follow_link: Link,
  default: Sparkles,
};

const ACTION_VARIANTS: Record<SenderRuleAction, "destructive" | "secondary" | "default" | "outline"> = {
  block: "destructive",
  each_email_is_new_lead: "secondary",
  follow_link: "secondary",
  default: "outline",
};

const FIELD_LABELS: Record<CrmField, string> = {
  name: "Name",
  firstName: "First Name",
  lastName: "Last Name",
  phone: "Phone",
  email: "Email",
  address: "Address",
  message: "Service Description",
  source: "Source",
  notes: "Notes",
  utmCampaign: "Campaign",
  utmSource: "UTM Source",
  utmMedium: "UTM Medium",
  utmTerm: "UTM Term",
  utmContent: "UTM Content",
  pageUrl: "Page URL",
};

const CRM_FIELDS: { value: CrmField; label: string }[] = crmFieldEnum.options.map(
  (value) => ({ value, label: FIELD_LABELS[value] })
);

const NON_BLOCK_ACTIONS: SenderRuleAction[] = ["each_email_is_new_lead", "follow_link", "default"];

function FieldMappingPanel({ rule, onSave, isPending }: { rule: SenderRule; onSave: (mappings: FieldMapping[]) => void; isPending?: boolean }) {
  const [mappings, setMappings] = useState<FieldMapping[]>(rule.fieldMappings || []);

  const addMapping = () => {
    const updated = [...mappings, { label: "", field: "name" as const }];
    setMappings(updated);
  };

  const removeMapping = (index: number) => {
    const updated = mappings.filter((_, i) => i !== index);
    setMappings(updated);
    saveValidMappings(updated);
  };

  const saveValidMappings = (list: FieldMapping[]) => {
    onSave(list.filter(m => m.label.trim()));
  };

  const updateMapping = (index: number, updates: Partial<FieldMapping>) => {
    const updated = mappings.map((m, i) => i === index ? { ...m, ...updates } : m);
    setMappings(updated);
  };

  const hasValidMappings = mappings.some(m => m.label.trim());

  return (
    <div className="space-y-2 pt-2">
      <p className="text-xs text-muted-foreground">
        Define how text labels in the email body map to CRM fields. For example, "Customer Name:" maps to the Name field.
      </p>
      <p className="text-xs text-muted-foreground">
        "First Name" and "Last Name" are combined into the contact's full name.
      </p>

      {mappings.map((mapping, index) => (
        <div key={index} className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="w-full sm:flex-1 sm:min-w-[140px]">
            <Input
              placeholder='e.g. "Customer Name:"'
              value={mapping.label}
              onChange={(e) => updateMapping(index, { label: e.target.value })}
              className="text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">maps to</span>
            <div className="flex-1 sm:w-[160px] sm:flex-none">
              <Select
                value={mapping.field}
                onValueChange={(v) => updateMapping(index, { field: v as FieldMapping["field"] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CRM_FIELDS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => removeMapping(index)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" onClick={addMapping}>
          <Plus className="h-4 w-4 mr-1" />
          Add Mapping
        </Button>
        {mappings.length > 0 && (
          <Button
            size="sm"
            onClick={() => saveValidMappings(mappings)}
            disabled={isPending || !hasValidMappings}
          >
            <Save className="h-4 w-4 mr-1" />
            {isPending ? "Saving..." : "Save Mappings"}
          </Button>
        )}
      </div>
    </div>
  );
}

let actionToggleCounter = 0;

function ActionToggle({ actions, onChange, disabled }: {
  actions: SenderRuleAction[];
  onChange: (actions: SenderRuleAction[]) => void;
  disabled?: boolean;
}) {
  const [instanceId] = useState(() => `at-${++actionToggleCounter}`);
  const isBlock = actions.includes("block");

  const handleBlockToggle = (checked: boolean) => {
    if (checked) {
      onChange(["block"]);
    } else {
      onChange(["default"]);
    }
  };

  const handleActionToggle = (action: SenderRuleAction, checked: boolean) => {
    if (action === "block") {
      handleBlockToggle(checked);
      return;
    }
    let next = actions.filter(a => a !== "block" && a !== action);
    if (checked) {
      next = next.filter(a => a !== "default");
      next.push(action);
    }
    if (next.length === 0) next = ["default"];
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${instanceId}-block`}
          checked={isBlock}
          onCheckedChange={(checked) => handleBlockToggle(!!checked)}
          disabled={disabled}
        />
        <label htmlFor={`${instanceId}-block`} className="text-xs cursor-pointer flex items-center gap-1">
          <Ban className="h-3 w-3" /> Block
        </label>
      </div>
      {!isBlock && NON_BLOCK_ACTIONS.map((action) => (
        <div key={action} className="flex items-center gap-2">
          <Checkbox
            id={`${instanceId}-${action}`}
            checked={actions.includes(action)}
            onCheckedChange={(checked) => handleActionToggle(action, !!checked)}
            disabled={disabled}
          />
          <label htmlFor={`${instanceId}-${action}`} className="text-xs cursor-pointer flex items-center gap-1">
            {(() => { const Icon = ACTION_ICONS[action]; return <Icon className="h-3 w-3" />; })()}
            {ACTION_LABELS[action]}
          </label>
        </div>
      ))}
    </div>
  );
}

function UrlPatternInput({ rule, onSave, isPending }: { rule: SenderRule; onSave: (urlPattern: string) => void; isPending?: boolean }) {
  const [value, setValue] = useState(rule.urlPattern || "");
  const isDirty = value !== (rule.urlPattern || "");

  return (
    <div className="pt-3 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">URL must contain</p>
      <p className="text-xs text-muted-foreground">
        Prefer links matching this text. Falls back to first URL if no match. Leave empty to always use the first URL.
      </p>
      <div className="flex items-center gap-2">
        <Input
          placeholder="e.g. mitsubishielectrictrane.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="text-sm flex-1"
        />
        {isDirty && (
          <Button
            size="sm"
            onClick={() => onSave(value.trim())}
            disabled={isPending}
          >
            <Save className="h-4 w-4 mr-1" />
            {isPending ? "Saving..." : "Save"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function SenderRulesSection({ spamFilterEnabled = false }: { spamFilterEnabled?: boolean }) {
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");
  const [newActions, setNewActions] = useState<SenderRuleAction[]>(["default"]);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [showNewActions, setShowNewActions] = useState(false);

  const { data: rawRules = [], isLoading } = useQuery<SenderRule[]>({
    queryKey: ['/api/settings/lead-capture-inbox/sender-rules'],
  });

  const rules = rawRules.map(normalizeRule);

  const addMutation = useMutation({
    mutationFn: async (rule: { senderEmail: string; actions: SenderRuleAction[] }) => {
      const response = await apiRequest('POST', '/api/settings/lead-capture-inbox/sender-rules', rule);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox/sender-rules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
      setNewEmail("");
      setNewActions(["default"]);
      setShowNewActions(false);
      toast({ title: "Rule Added", description: "Sender rule has been saved." });
    },
    onError: (error: any) => {
      toast({ title: "Failed", description: error.message || "Failed to add rule.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (senderEmail: string) => {
      const response = await apiRequest('DELETE', `/api/settings/lead-capture-inbox/sender-rules/${encodeURIComponent(senderEmail)}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox/sender-rules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
      toast({ title: "Rule Removed", description: "Sender rule has been removed." });
    },
    onError: (error: any) => {
      toast({ title: "Failed", description: error.message || "Failed to remove rule.", variant: "destructive" });
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: async (rule: { senderEmail: string; actions: SenderRuleAction[]; fieldMappings?: FieldMapping[]; spamOverride?: string; urlPattern?: string }) => {
      const response = await apiRequest('POST', '/api/settings/lead-capture-inbox/sender-rules', rule);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox/sender-rules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
      toast({ title: "Rule Updated", description: "Sender rule has been updated." });
    },
    onError: (error: any) => {
      toast({ title: "Failed", description: error.message || "Failed to update rule.", variant: "destructive" });
    },
  });

  const handleAdd = () => {
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) {
      toast({ title: "Invalid Email", description: "Please enter a valid email address.", variant: "destructive" });
      return;
    }
    addMutation.mutate({ senderEmail: trimmed, actions: newActions });
  };

  const handleActionsChange = (rule: SenderRule, newRuleActions: SenderRuleAction[]) => {
    updateRuleMutation.mutate({
      senderEmail: rule.senderEmail,
      actions: newRuleActions,
      fieldMappings: rule.fieldMappings,
      spamOverride: rule.spamOverride,
      urlPattern: rule.urlPattern,
    });
  };

  return (
    <div className="space-y-3">
      <Separator />
      <div>
        <p className="text-sm font-medium">Sender Rules</p>
        <p className="text-xs text-muted-foreground mt-1">
          Control how emails from specific sender addresses are handled during lead capture. You can combine multiple actions for one sender.
        </p>
      </div>

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((rule) => {
            const isExpanded = expandedRule === rule.senderEmail;
            const isBlocked = rule.actions.includes("block");
            const showFieldMapping = !isBlocked;
            const hasMappings = (rule.fieldMappings?.length || 0) > 0;
            return (
              <div key={rule.senderEmail} className="rounded-md border">
                <div className="flex items-center justify-between gap-2 p-2 min-w-0">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-sm truncate">{rule.senderEmail}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    {hasMappings && (
                      <Badge variant="outline" className="no-default-active-elevate text-xs">
                        {rule.fieldMappings!.length} mapping{rule.fieldMappings!.length !== 1 ? "s" : ""}
                      </Badge>
                    )}
                    {rule.actions.map((action) => {
                      const Icon = ACTION_ICONS[action];
                      return (
                        <Badge key={action} variant={ACTION_VARIANTS[action]} className="no-default-active-elevate">
                          <Icon className="h-3 w-3 shrink-0 sm:mr-1" />
                          <span className="hidden sm:inline">{ACTION_LABELS[action]}</span>
                        </Badge>
                      );
                    })}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setExpandedRule(isExpanded ? null : rule.senderEmail)}
                      title="Configure rule"
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(rule.senderEmail)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t px-3 pb-3">
                    <div className="pt-3">
                      <p className="text-xs font-medium text-muted-foreground mb-2">Actions</p>
                      <ActionToggle
                        actions={rule.actions}
                        onChange={(newRuleActions) => handleActionsChange(rule, newRuleActions)}
                        disabled={updateRuleMutation.isPending}
                      />
                    </div>
                    {rule.actions.includes("follow_link") && (
                      <UrlPatternInput
                        rule={rule}
                        onSave={(urlPattern) => updateRuleMutation.mutate({
                          senderEmail: rule.senderEmail,
                          actions: rule.actions,
                          fieldMappings: rule.fieldMappings,
                          spamOverride: rule.spamOverride,
                          urlPattern,
                        })}
                        isPending={updateRuleMutation.isPending}
                      />
                    )}
                    {spamFilterEnabled && showFieldMapping && (
                      <div className="flex items-center gap-2 pt-3">
                        <span className="text-xs text-muted-foreground shrink-0">Spam Override:</span>
                        <Select
                          value={rule.spamOverride || "none"}
                          onValueChange={(v) => updateRuleMutation.mutate({
                            senderEmail: rule.senderEmail,
                            actions: rule.actions,
                            fieldMappings: rule.fieldMappings,
                            spamOverride: v,
                            urlPattern: rule.urlPattern,
                          })}
                        >
                          <SelectTrigger className="w-full sm:w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Default (AI decides)</SelectItem>
                            <SelectItem value="always_allow">Always Allow</SelectItem>
                            <SelectItem value="always_block">Always Block</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {showFieldMapping && (
                      <FieldMappingPanel
                        rule={rule}
                        onSave={(fieldMappings) =>
                          updateRuleMutation.mutate({
                            senderEmail: rule.senderEmail,
                            actions: rule.actions,
                            fieldMappings,
                            spamOverride: rule.spamOverride,
                            urlPattern: rule.urlPattern,
                          })
                        }
                        isPending={updateRuleMutation.isPending}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {rules.length === 0 && !isLoading && (
        <p className="text-xs text-muted-foreground">No sender rules configured. All emails use default AI classification.</p>
      )}

      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-end gap-2">
          <div className="w-full sm:flex-1 min-w-0">
            <Input
              placeholder="sender@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
            />
          </div>
          <Button
            variant="outline"
            size="default"
            onClick={() => setShowNewActions(!showNewActions)}
            className="w-full sm:w-auto"
          >
            {newActions.map(a => ACTION_LABELS[a]).join(" + ")}
          </Button>
          <Button
            size="default"
            onClick={handleAdd}
            disabled={addMutation.isPending || !newEmail.trim()}
            className="w-full sm:w-auto"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Rule
          </Button>
        </div>
        {showNewActions && (
          <div className="rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">Select actions for new rule</p>
            <ActionToggle
              actions={newActions}
              onChange={setNewActions}
            />
          </div>
        )}
      </div>
    </div>
  );
}
