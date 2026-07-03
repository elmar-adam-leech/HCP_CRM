import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatPhoneNumber } from "@/lib/utils";

type Stage = "lead" | "estimate" | "job";

interface CreateContactFromCallDialogProps {
  call: { id: string; phone: string | null };
  onOpenChange: (open: boolean) => void;
}

/**
 * Create a new contact for an unassigned call and set which pipeline stage the
 * contact starts at, then link the call to the new contact.
 *
 * Reuses the existing creation endpoints so all their side effects (HCP sync,
 * workflow triggers, leads-table row, activity attribution) fire exactly as
 * they do elsewhere:
 *   1. POST /api/contacts        (creates the lead contact)
 *   2. POST /api/estimates|jobs  (only when that stage is chosen)
 *   3. POST /api/calls/:id/link  (stamps the call's contactId)
 * Each step surfaces its own error — nothing fails silently.
 */
export function CreateContactFromCallDialog({ call, onOpenChange }: CreateContactFromCallDialogProps) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState(call.phone ?? "");
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>("lead");
  const [recordTitle, setRecordTitle] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Name is required");

      const phones = phone.trim() ? [phone.trim()] : [];
      const emails = email.trim() ? [email.trim()] : [];

      // Step 1: create the contact (or resolve to an existing duplicate).
      // Uses raw fetch (not apiRequest) so the structured 409 duplicate-detection
      // fields survive — apiRequest reads text() and throws before we can parse
      // the JSON body (same reason CreateLeadModal uses raw fetch here).
      const contactRes = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: trimmedName,
          phones,
          emails,
          type: "lead",
          source: "call",
        }),
      });
      const contactBody = await contactRes.json().catch(() => ({}));

      let contactId: string | undefined;
      let linkedToExisting = false;
      if (contactRes.status === 409 && contactBody?.duplicateContactId) {
        // A contact with this number already exists — link the call to them
        // rather than creating a duplicate, and skip stage creation.
        contactId = contactBody.duplicateContactId as string;
        linkedToExisting = true;
      } else if (contactRes.ok && contactBody?.id) {
        contactId = contactBody.id as string;
      } else {
        throw new Error(contactBody?.message || "Failed to create contact");
      }

      // Step 2: create the estimate/job record for the chosen stage.
      // apiRequest throws on any non-2xx; re-wrap so the toast makes clear the
      // contact WAS created even if this later step failed (no silent failures).
      if (!linkedToExisting && stage === "estimate") {
        try {
          await apiRequest("POST", "/api/estimates", {
            title: recordTitle.trim() || `Estimate for ${trimmedName}`,
            description: "",
            amount: 0,
            contactId,
            status: "scheduled",
          });
        } catch {
          throw new Error("Contact created, but failed to create the estimate");
        }
      } else if (!linkedToExisting && stage === "job") {
        try {
          await apiRequest("POST", "/api/jobs", {
            title: recordTitle.trim() || `Job for ${trimmedName}`,
            type: "General",
            value: 0,
            contactId,
            status: "scheduled",
            priority: "medium",
          });
        } catch {
          throw new Error("Contact created, but failed to create the job");
        }
      }

      // Step 3: link the call to the contact.
      try {
        await apiRequest("POST", `/api/calls/${call.id}/link`, { contactId });
      } catch {
        throw new Error("Contact created, but failed to link the call to it");
      }

      return { linkedToExisting, name: trimmedName };
    },
    onSuccess: (result) => {
      toast({
        title: result.linkedToExisting ? "Call linked" : "Contact created",
        description: result.linkedToExisting
          ? `A contact already existed for this number — linked the call to ${result.name}.`
          : `${result.name} was created and the call was linked.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/calls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/with-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/paginated"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not complete",
        description: error instanceof Error ? error.message : "Please try again",
      });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!mutation.isPending) onOpenChange(open); }}>
      <DialogContent data-testid="dialog-create-contact-from-call">
        <DialogHeader>
          <DialogTitle>Create contact from call</DialogTitle>
          <DialogDescription>
            {call.phone
              ? `Create a contact for ${formatPhoneNumber(call.phone)} and choose their stage.`
              : "Create a contact for this call and choose their stage."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cc-name">Name *</Label>
            <Input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contact name"
              data-testid="input-contact-name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cc-phone">Phone</Label>
            <Input
              id="cc-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Phone number"
              data-testid="input-contact-phone"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cc-email">Email (optional)</Label>
            <Input
              id="cc-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              data-testid="input-contact-email"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cc-stage">Stage</Label>
            <Select value={stage} onValueChange={(v) => setStage(v as Stage)}>
              <SelectTrigger id="cc-stage" data-testid="select-stage">
                <SelectValue placeholder="Select stage" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">Lead</SelectItem>
                <SelectItem value="estimate">Estimate</SelectItem>
                <SelectItem value="job">Job</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(stage === "estimate" || stage === "job") && (
            <div className="space-y-2">
              <Label htmlFor="cc-record-title">
                {stage === "estimate" ? "Estimate title" : "Job title"} (optional)
              </Label>
              <Input
                id="cc-record-title"
                value={recordTitle}
                onChange={(e) => setRecordTitle(e.target.value)}
                placeholder={stage === "estimate" ? "HVAC Installation Quote" : "HVAC Repair Service"}
                data-testid="input-record-title"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
            data-testid="button-cancel-create-contact"
          >
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !name.trim()}
            data-testid="button-submit-create-contact"
          >
            {mutation.isPending ? "Saving..." : "Create & link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
