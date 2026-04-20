import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import type { Contact } from "@shared/schema";

type ContactWithCounts = Contact & {
  leadCount: number;
  estimateCount: number;
  jobCount: number;
};

interface ContactMergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedForMerge: ContactWithCounts[];
  mergePrimaryId: string | null;
  onPrimaryChange: (id: string) => void;
  onConfirm: () => void;
  isPending: boolean;
}

export function ContactMergeDialog({
  open,
  onOpenChange,
  selectedForMerge,
  mergePrimaryId,
  onPrimaryChange,
  onConfirm,
  isPending,
}: ContactMergeDialogProps) {
  const mergePreview = selectedForMerge.length === 2
    ? (() => {
        const allEmails = new Set<string>();
        const allPhones = new Set<string>();
        selectedForMerge.forEach((c) => {
          c.emails?.forEach((e) => allEmails.add(e.toLowerCase()));
          c.phones?.forEach((p) => allPhones.add(p));
        });
        return { emails: Array.from(allEmails), phones: Array.from(allPhones) };
      })()
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge Contacts</DialogTitle>
          <DialogDescription>
            Choose which contact to keep as primary. All records from the other contact will be merged into it.
          </DialogDescription>
        </DialogHeader>

        {selectedForMerge.length === 2 && mergePrimaryId && (
          <div className="space-y-4">
            <RadioGroup value={mergePrimaryId} onValueChange={onPrimaryChange}>
              <div className="grid grid-cols-2 gap-3">
                {selectedForMerge.map((contact) => (
                  <label
                    key={contact.id}
                    className={`relative flex flex-col gap-2 p-3 rounded-md border cursor-pointer ${
                      mergePrimaryId === contact.id ? "border-primary ring-1 ring-primary" : "border-border"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value={contact.id} id={`merge-radio-${contact.id}`} />
                      <Label htmlFor={`merge-radio-${contact.id}`} className="text-sm font-medium cursor-pointer">
                        Keep as primary
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarFallback className="text-xs">{getInitials(contact.name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{contact.name}</div>
                        {contact.emails?.[0] && (
                          <div className="text-xs text-muted-foreground truncate">{contact.emails[0]}</div>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {contact.leadCount + contact.estimateCount + contact.jobCount} records
                    </div>
                  </label>
                ))}
              </div>
            </RadioGroup>

            {mergePreview && (
              <div className="rounded-md bg-muted p-3 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Merged contact will have:</div>
                {mergePreview.emails.length > 0 && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Emails: </span>
                    {mergePreview.emails.join(", ")}
                  </div>
                )}
                {mergePreview.phones.length > 0 && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Phones: </span>
                    {mergePreview.phones.join(", ")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={onConfirm}
            disabled={isPending}
            data-testid="button-confirm-merge"
          >
            {isPending ? "Merging..." : "Merge Contacts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
