import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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

  return (
    <Sheet open={!!contact} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        {contact && (
          <>
            <SheetHeader className="mb-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12">
                  <AvatarFallback className="text-lg">{getInitials(contact.name)}</AvatarFallback>
                </Avatar>
                <div>
                  <SheetTitle>{contact.name}</SheetTitle>
                  <SheetDescription className="capitalize">
                    {contact.type} · {contact.status}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                {contact.emails?.map((email) => (
                  <div key={email} className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                    <a href={`mailto:${email}`} className="text-foreground hover:underline truncate">{email}</a>
                  </div>
                ))}
                {contact.phones?.map((phone) => (
                  <div key={phone} className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span>{phone}</span>
                  </div>
                ))}
                {contact.address && (
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">{contact.address}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm" data-testid="contact-source-row">
                  <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Source:</span>
                  {isEditingSource ? (
                    <div className="flex items-center gap-1 flex-1">
                      <Input
                        value={sourceDraft}
                        onChange={(e) => setSourceDraft(e.target.value)}
                        placeholder="e.g. referral, website"
                        className="h-8"
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
                        onClick={() => updateSource.mutate(sourceDraft)}
                        disabled={updateSource.isPending}
                        data-testid="button-save-contact-source"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
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
                  <div className="text-center p-3 rounded-md bg-muted">
                    <div className="text-lg font-semibold">{contact.leadCount}</div>
                    <div className="text-xs text-muted-foreground">Lead{contact.leadCount !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="text-center p-3 rounded-md bg-muted">
                    <div className="text-lg font-semibold">{contact.estimateCount}</div>
                    <div className="text-xs text-muted-foreground">Estimate{contact.estimateCount !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="text-center p-3 rounded-md bg-muted">
                    <div className="text-lg font-semibold">{contact.jobCount}</div>
                    <div className="text-xs text-muted-foreground">Job{contact.jobCount !== 1 ? "s" : ""}</div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Quick Links</div>
                <div className="flex flex-col gap-1">
                  {contact.leadCount > 0 && (
                    <Link href={`/leads?search=${encodeURIComponent(contact.name)}`}>
                      <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                        <Users className="h-4 w-4" />
                        View Leads
                        <ExternalLink className="h-3 w-3 ml-auto" />
                      </Button>
                    </Link>
                  )}
                  {contact.estimateCount > 0 && (
                    <Link href={`/estimates?search=${encodeURIComponent(contact.name)}`}>
                      <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                        <FileText className="h-4 w-4" />
                        View Estimates
                        <ExternalLink className="h-3 w-3 ml-auto" />
                      </Button>
                    </Link>
                  )}
                  {contact.jobCount > 0 && (
                    <Link href={`/jobs?search=${encodeURIComponent(contact.name)}`}>
                      <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                        <Briefcase className="h-4 w-4" />
                        View Jobs
                        <ExternalLink className="h-3 w-3 ml-auto" />
                      </Button>
                    </Link>
                  )}
                  <Link href={`/messages?contactId=${contact.id}`}>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                      <Mail className="h-4 w-4" />
                      View Messages
                      <ExternalLink className="h-3 w-3 ml-auto" />
                    </Button>
                  </Link>
                </div>
              </div>

              {contact.notes && (
                <>
                  <Separator />
                  <div className="space-y-1">
                    <div className="text-sm font-medium">Notes</div>
                    <p className="text-sm text-muted-foreground">{contact.notes}</p>
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
                        <Download className="h-4 w-4" />
                        Export Personal Data
                      </Button>
                      {!contact.anonymized && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full justify-start gap-2 text-destructive border-destructive/30"
                          onClick={() => onEraseData(contact)}
                          data-testid={`button-erase-contact-${contact.id}`}
                        >
                          <ShieldOff className="h-4 w-4" />
                          Erase Personal Data
                        </Button>
                      )}
                      {contact.anonymized && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <ShieldOff className="h-3 w-3" />
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
                <p className="text-xs text-muted-foreground">
                  Permanently deletes this contact along with all associated leads, estimates, jobs, messages, and activities. This cannot be undone.
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full"
                  onClick={() => onDelete(contact)}
                  data-testid={`button-delete-contact-${contact.id}`}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Contact Permanently
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
