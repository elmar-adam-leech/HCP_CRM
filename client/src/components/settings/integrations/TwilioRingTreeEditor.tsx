import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  PhoneForwarded,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useUsers } from "@/hooks/useUsers";

export interface RingTreeStep {
  numbers: string[];
  userIds: string[];
  timeoutSeconds: number;
}

export interface RingTree {
  steps: RingTreeStep[];
  voicemailGreeting?: string;
}

const MAX_STEPS = 5;
const MAX_MEMBERS = 5;
const TIMEOUT_OPTIONS = [10, 15, 20, 30, 45, 60];

interface Props {
  value: RingTree | null;
  onSave: (tree: RingTree | null) => void;
  isSaving: boolean;
}

/**
 * Admin editor for the inbound-call ring order (task #854). Each step rings
 * all its members at once; unanswered steps fall through in order, ending in
 * voicemail. Null config = default behavior (first teammate with a phone).
 */
export function TwilioRingTreeEditor({ value, onSave, isSaving }: Props) {
  const { data: users } = useUsers();
  const [draft, setDraft] = useState<RingTree | null>(null);
  const [editing, setEditing] = useState(false);
  const [newNumber, setNewNumber] = useState<Record<number, string>>({});

  const startEditing = () => {
    setDraft(
      value && value.steps.length > 0
        ? { steps: value.steps.map((s) => ({ ...s, numbers: [...s.numbers], userIds: [...s.userIds] })), voicemailGreeting: value.voicemailGreeting }
        : { steps: [{ numbers: [], userIds: [], timeoutSeconds: 20 }], voicemailGreeting: "" },
    );
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(null);
    setNewNumber({});
  };

  const updateStep = (i: number, patch: Partial<RingTreeStep>) => {
    setDraft((d) => {
      if (!d) return d;
      const steps = d.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
      return { ...d, steps };
    });
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    setDraft((d) => {
      if (!d) return d;
      const j = i + dir;
      if (j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });
  };

  const removeStep = (i: number) => {
    setDraft((d) => (d ? { ...d, steps: d.steps.filter((_, idx) => idx !== i) } : d));
  };

  const addStep = () => {
    setDraft((d) =>
      d && d.steps.length < MAX_STEPS
        ? { ...d, steps: [...d.steps, { numbers: [], userIds: [], timeoutSeconds: 20 }] }
        : d,
    );
  };

  const memberCount = (s: RingTreeStep) => s.numbers.length + s.userIds.length;

  const addUserToStep = (i: number, userId: string) => {
    const step = draft?.steps[i];
    if (!step || step.userIds.includes(userId) || memberCount(step) >= MAX_MEMBERS) return;
    updateStep(i, { userIds: [...step.userIds, userId] });
  };

  const addNumberToStep = (i: number) => {
    const raw = (newNumber[i] || "").trim();
    const step = draft?.steps[i];
    if (!raw || raw.length < 3 || !step || memberCount(step) >= MAX_MEMBERS) return;
    if (step.numbers.includes(raw)) return;
    updateStep(i, { numbers: [...step.numbers, raw] });
    setNewNumber((m) => ({ ...m, [i]: "" }));
  };

  const draftValid =
    !!draft &&
    draft.steps.length >= 1 &&
    draft.steps.every((s) => memberCount(s) >= 1 && memberCount(s) <= MAX_MEMBERS);

  const save = () => {
    if (!draft || !draftValid) return;
    const tree: RingTree = {
      steps: draft.steps.map((s) => ({
        numbers: s.numbers,
        userIds: s.userIds,
        timeoutSeconds: s.timeoutSeconds,
      })),
    };
    const greeting = draft.voicemailGreeting?.trim();
    if (greeting) tree.voicemailGreeting = greeting;
    onSave(tree);
    setEditing(false);
    setDraft(null);
  };

  const userName = (id: string) => users?.find((u) => u.id === id)?.name || "Removed user";
  const userHasPhone = (id: string) => !!users?.find((u) => u.id === id)?.twilioPhoneToRing;

  // ---- Read-only summary / empty state ----
  if (!editing) {
    if (!value || value.steps.length === 0) {
      return (
        <div className="space-y-2" data-testid="twilio-ring-tree-empty">
          <div className="flex items-center gap-2">
            <PhoneForwarded className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Incoming call ring order</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Default: rings the first teammate with a phone on file, then goes to voicemail.
          </p>
          <Button variant="outline" size="sm" onClick={startEditing} data-testid="button-setup-ring-order">
            Set up ring order
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-2" data-testid="twilio-ring-tree-summary">
        <div className="flex items-center gap-2">
          <PhoneForwarded className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Incoming call ring order</span>
        </div>
        <ol className="space-y-1 text-xs text-muted-foreground list-decimal pl-5">
          {value.steps.map((s, i) => (
            <li key={i}>
              Ring{" "}
              {[...s.userIds.map(userName), ...s.numbers].join(", ")}
              {" "}for {s.timeoutSeconds}s
            </li>
          ))}
          <li>Voicemail{value.voicemailGreeting ? " (custom greeting)" : ""}</li>
        </ol>
        {value.steps.some((s) => s.userIds.some((id) => users && !userHasPhone(id))) && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Some teammates in the ring order have no phone number on file — their steps will be skipped.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={startEditing} disabled={isSaving} data-testid="button-edit-ring-order">
            Edit ring order
          </Button>
          <Button variant="outline" size="sm" onClick={() => onSave(null)} disabled={isSaving} data-testid="button-remove-ring-order">
            Use default instead
          </Button>
        </div>
      </div>
    );
  }

  // ---- Editor ----
  return (
    <div className="space-y-3" data-testid="twilio-ring-tree-editor">
      <div className="flex items-center gap-2">
        <PhoneForwarded className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Incoming call ring order</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Everyone in a step rings at the same time. If nobody answers, the call moves to the next step, then voicemail.
      </p>

      {draft?.steps.map((step, i) => (
        <div key={i} className="rounded-md border p-3 space-y-2" data-testid={`ring-step-${i}`}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm font-medium">Step {i + 1}</span>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" onClick={() => moveStep(i, -1)} disabled={i === 0} data-testid={`button-step-up-${i}`}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => moveStep(i, 1)} disabled={i === draft.steps.length - 1} data-testid={`button-step-down-${i}`}>
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => removeStep(i)} disabled={draft.steps.length <= 1} data-testid={`button-step-remove-${i}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {(step.userIds.length > 0 || step.numbers.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {step.userIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
                  {userName(id)}
                  {users && !userHasPhone(id) && (
                    <AlertTriangle className="h-3 w-3 text-destructive" aria-label="No phone on file" />
                  )}
                  <button
                    type="button"
                    className="ml-0.5"
                    onClick={() => updateStep(i, { userIds: step.userIds.filter((u) => u !== id) })}
                    aria-label={`Remove ${userName(id)}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {step.numbers.map((n) => (
                <span key={n} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
                  {n}
                  <button
                    type="button"
                    className="ml-0.5"
                    onClick={() => updateStep(i, { numbers: step.numbers.filter((x) => x !== n) })}
                    aria-label={`Remove ${n}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {step.userIds.some((id) => users && !userHasPhone(id)) && (
            <p className="text-xs text-destructive">
              A selected teammate has no phone number on file (Settings → Account → Phone to ring). They will be skipped.
            </p>
          )}

          {memberCount(step) < MAX_MEMBERS && (
            <div className="flex flex-col sm:flex-row gap-2">
              <Select value="" onValueChange={(v) => addUserToStep(i, v)}>
                <SelectTrigger className="sm:w-48" data-testid={`select-add-user-${i}`}>
                  <SelectValue placeholder="Add teammate..." />
                </SelectTrigger>
                <SelectContent>
                  {(users ?? [])
                    .filter((u) => !step.userIds.includes(u.id))
                    .map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}{u.twilioPhoneToRing ? "" : " (no phone)"}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Input
                  placeholder="Or a phone number..."
                  value={newNumber[i] || ""}
                  onChange={(e) => setNewNumber((m) => ({ ...m, [i]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNumberToStep(i); } }}
                  className="sm:w-44"
                  data-testid={`input-add-number-${i}`}
                />
                <Button variant="outline" onClick={() => addNumberToStep(i)} disabled={!(newNumber[i] || "").trim()} data-testid={`button-add-number-${i}`}>
                  Add
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground shrink-0">Ring for</Label>
            <Select
              value={String(step.timeoutSeconds)}
              onValueChange={(v) => updateStep(i, { timeoutSeconds: Number(v) })}
            >
              <SelectTrigger className="w-28" data-testid={`select-timeout-${i}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEOUT_OPTIONS.map((t) => (
                  <SelectItem key={t} value={String(t)}>{t} seconds</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {memberCount(step) === 0 && (
            <p className="text-xs text-destructive">Add at least one teammate or phone number to this step.</p>
          )}
        </div>
      ))}

      {draft && draft.steps.length < MAX_STEPS && (
        <Button variant="outline" size="sm" onClick={addStep} data-testid="button-add-ring-step">
          <Plus className="h-4 w-4 mr-1" />
          Add step
        </Button>
      )}

      <div className="space-y-1">
        <Label htmlFor="ring-voicemail-greeting" className="text-xs text-muted-foreground">
          Voicemail greeting (optional)
        </Label>
        <Input
          id="ring-voicemail-greeting"
          placeholder="Please leave a message after the tone."
          maxLength={500}
          value={draft?.voicemailGreeting ?? ""}
          onChange={(e) => setDraft((d) => (d ? { ...d, voicemailGreeting: e.target.value } : d))}
          data-testid="input-voicemail-greeting"
        />
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button size="sm" onClick={save} disabled={!draftValid || isSaving} data-testid="button-save-ring-order">
          {isSaving ? "Saving..." : "Save ring order"}
        </Button>
        <Button variant="outline" size="sm" onClick={cancel} disabled={isSaving} data-testid="button-cancel-ring-order">
          Cancel
        </Button>
      </div>
    </div>
  );
}
