import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { useIsBelowSm } from "@/components/ui/responsive-modal";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Mail, Phone, MapPin, Trash2, Users, Briefcase, FileText, ExternalLink, Download, ShieldOff, Tag, Pencil, Check, X } from "lucide-react";
import { getInitials } from "@/lib/utils";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Contact } from "@shared/schema";

function formatSource(source: string | null | undefined): string {
  if (!source || !source.trim()) return "Unknown";
  return source
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

type ContactWithCounts = Contact & {
  leadCount: number;
  estimateCount: number;
  jobCount: number;
};

interface ContactDetailSheetProps {
  contact: ContactWithCounts | null;
  isAdmin: boolean;
  onClose: () => void;
  onDelete: (contact: ContactWithCounts) => void;
  onExportData: (contactId: string) => void;
  onEraseData: (contact: ContactWithCounts) => void;
}

export function ContactDetailSheet({
  contact,
  isAdmin,
  onClose,
  onDelete,
  onExportData,
  onEraseData,
}: ContactDetailSheetProps) {
  const { toast } = useToast();
  const isMobile = useIsBelowSm();
  const [isEditingSource, setIsEditingSource] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");

  useEffect(() => {
    setIsEditingSource(false);
    setSourceDraft(contact?.source ?? "");
    setOptimisticSource(undefined);
  }, [contact?.id, contact?.source]);

  const isHcpContact = !!contact?.housecallProCustomerId;
  const canEditSource = !!contact && !isHcpContact;

  const [optimisticSource, setOptimisticSource] = useState<string | null | undefined>(undefined);
  const displayedSource = optimisticSource !== undefined ? optimisticSource : contact?.source;

  const updateSource = useMutation({
    mutationFn: async (newSource: string) => {
      if (!contact) throw new Error("No contact selected");
      return apiRequest("PATCH", `/api/contacts/${contact.id}`, {
        source: newSource.trim() || null,
      });
    },
    onSuccess: (_res, newSource) => {
      const saved = newSource.trim() || null;
      setOptimisticSource(saved);
      toast({ title: "Source updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/with-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/paginated"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/status-counts"] });
      if (contact) {
        queryClient.invalidateQueries({ queryKey: ["/api/contacts", contact.id] });
      }
      setIsEditingSource(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update source",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  const headerSubtitle = contact ? `${contact.type} · ${contact.status}` : "";

  const headerNode = contact && (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar className="h-12 w-12 shrink-0">
        <AvatarFallback className="text-lg">{getInitials(contact.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-base">{contact.name}</div>
        <div className="text-sm text-muted-foreground capitalize truncate">
          {headerSubtitle}
        </div>
      </div>
    </div>
  );

  const bodyNode = contact && (
    <div className="space-y-4">
      <div className="space-y-2">
        {contact.emails?.map((email) => (
          <div key={email} className="flex items-center gap-2 text-sm min-w-0">
            <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
            <a
              href={`mailto:${email}`}
              className="text-foreground hover:underline truncate min-w-0 flex-1"
            >
              {email}
            </a>
          </div>
        ))}
        {contact.phones?.map((phone) => (
          <div key={phone} className="flex items-center gap-2 text-sm min-w-0">
            <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="truncate min-w-0 flex-1">{phone}</span>
          </div>
        ))}
        {contact.address && (
          <div className="flex items-start gap-2 text-sm min-w-0">
            <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <span className="text-muted-foreground break-words min-w-0 flex-1">
              {contact.address}
            </span>
          </div>
        )}
        <div
          className="flex items-center gap-2 text-sm min-w-0 flex-wrap"
          data-testid="contact-source-row"
        >
          <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground shrink-0">Source:</span>
          {isEditingSource ? (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <Input
                value={sourceDraft}
                onChange={(e) => setSourceDraft(e.target.value)}
                placeholder="e.g. referral, website"
                className="h-8 min-w-0 flex-1"
                autoFocus
                disabled={updateSource.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!updateSource.isPending) updateSource.mutate(sourceDraft);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setSourceDraft(contact.source ?? "");
                    setIsEditingSource(false);
                  }
                }}
                data-testid="input-contact-source"
              />
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => updateSource.mutate(sourceDraft)}
                disabled={updateSource.isPending}
                data-testid="button-save-contact-source"
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  setSourceDraft(contact.source ?? "");
                  setIsEditingSource(false);
                }}
                disabled={updateSource.isPending}
                data-testid="button-cancel-contact-source"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <>
              <Badge variant="secondary" data-testid="badge-contact-source">
                {formatSource(displayedSource)}
              </Badge>
              {canEditSource && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => {
                    setSourceDraft(displayedSource ?? "");
                    setIsEditingSource(true);
                  }}
                  data-testid="button-edit-contact-source"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <div className="text-sm font-medium">Records</div>
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-3 rounded-md bg-muted min-w-0">
            <div className="text-lg font-semibold">{contact.leadCount}</div>
            <div className="text-xs text-muted-foreground truncate">Lead{contact.leadCount !== 1 ? "s" : ""}</div>
          </div>
          <div className="text-center p-3 rounded-md bg-muted min-w-0">
            <div className="text-lg font-semibold">{contact.estimateCount}</div>
            <div className="text-xs text-muted-foreground truncate">Estimate{contact.estimateCount !== 1 ? "s" : ""}</div>
          </div>
          <div className="text-center p-3 rounded-md bg-muted min-w-0">
            <div className="text-lg font-semibold">{contact.jobCount}</div>
            <div className="text-xs text-muted-foreground truncate">Job{contact.jobCount !== 1 ? "s" : ""}</div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Quick Links</div>
        <div className="flex flex-col gap-1">
          {contact.leadCount > 0 && (
            <Link href={`/leads?search=${encodeURIComponent(contact.name)}`}>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Users className="h-4 w-4 shrink-0" />
                <span className="truncate">View Leads</span>
                <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
              </Button>
            </Link>
          )}
          {contact.estimateCount > 0 && (
            <Link href={`/estimates?search=${encodeURIComponent(contact.name)}`}>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">View Estimates</span>
                <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
              </Button>
            </Link>
          )}
          {contact.jobCount > 0 && (
            <Link href={`/jobs?search=${encodeURIComponent(contact.name)}`}>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Briefcase className="h-4 w-4 shrink-0" />
                <span className="truncate">View Jobs</span>
                <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
              </Button>
            </Link>
          )}
          <Link href={`/messages?contactId=${contact.id}`}>
            <Button variant="outline" size="sm" className="w-full justify-start gap-2">
              <Mail className="h-4 w-4 shrink-0" />
              <span className="truncate">View Messages</span>
              <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
            </Button>
          </Link>
        </div>
      </div>

      {contact.notes && (
        <>
          <Separator />
          <div className="space-y-1">
            <div className="text-sm font-medium">Notes</div>
            <p className="text-sm text-muted-foreground break-words">{contact.notes}</p>
          </div>
        </>
      )}

      {isAdmin && (
        <>
          <Separator />
          <div className="space-y-2">
            <div className="text-sm font-medium">Data & Privacy</div>
            <p className="text-xs text-muted-foreground">
              Export a full data bundle or anonymize personal data for GDPR / CCPA compliance.
            </p>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => onExportData(contact.id)}
                data-testid={`button-export-contact-${contact.id}`}
              >
                <Download className="h-4 w-4 shrink-0" />
                <span className="truncate">Export Personal Data</span>
              </Button>
              {!contact.anonymized && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2 text-destructive border-destructive/30"
                  onClick={() => onEraseData(contact)}
                  data-testid={`button-erase-contact-${contact.id}`}
                >
                  <ShieldOff className="h-4 w-4 shrink-0" />
                  <span className="truncate">Erase Personal Data</span>
                </Button>
              )}
              {contact.anonymized && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <ShieldOff className="h-3 w-3 shrink-0" />
                  Personal data has been erased
                </p>
              )}
            </div>
          </div>
        </>
      )}

      <Separator />

      <div className="space-y-2">
        <div className="text-sm font-medium text-destructive">Danger Zone</div>
        <p className="text-xs text-muted-foreground break-words">
          Permanently deletes this contact along with all associated leads, estimates, jobs, messages, and activities. This cannot be undone.
        </p>
        <Button
          variant="destructive"
          size="sm"
          className="w-full"
          onClick={() => onDelete(contact)}
          data-testid={`button-delete-contact-${contact.id}`}
        >
          <Trash2 className="h-4 w-4 mr-2 shrink-0" />
          <span className="truncate">Delete Contact Permanently</span>
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={!!contact} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DrawerContent className="h-[100dvh] max-h-[100dvh] flex flex-col p-0 pb-[env(safe-area-inset-bottom)]">
          {contact && (
            <>
              <DrawerHeader className="px-4 py-4 border-b text-left shrink-0 space-y-0">
                <DrawerTitle asChild>
                  {headerNode}
                </DrawerTitle>
                <DrawerDescription className="sr-only">
                  Contact details for {contact.name}
                </DrawerDescription>
              </DrawerHeader>
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
                {bodyNode}
              </div>
            </>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={!!contact} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        {contact && (
          <>
            <SheetHeader className="mb-4">
              <SheetTitle asChild>
                {headerNode}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Contact details for {contact.name}
              </SheetDescription>
            </SheetHeader>
            {bodyNode}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
