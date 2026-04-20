import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, RotateCcw, CheckCircle, Loader2, ChevronLeft, ChevronRight, Mail, Trash2 } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { formatDateTime } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { SPAM_AUDIT_RETENTION_DAYS } from "@shared/constants/spam-audit-retention";

interface SpamAuditEntry {
  id: string;
  senderEmail: string;
  subject: string;
  body: string;
  spamConfidence: number;
  reason: string | null;
  flaggedAt: string;
  recoveredAt: string | null;
  recoveredLeadId: string | null;
}

interface SpamAuditLogResponse {
  entries: SpamAuditEntry[];
  total: number;
}

const PAGE_SIZE = 3;

function invalidateAuditLog() {
  queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' &&
      query.queryKey[0].startsWith('/api/settings/lead-capture-inbox/spam-audit-log'),
  });
}

export function SpamAuditLogSection() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [selectedEntry, setSelectedEntry] = useState<SpamAuditEntry | null>(null);
  const [recoveringEntryId, setRecoveringEntryId] = useState<string | null>(null);
  const [dismissingEntry, setDismissingEntry] = useState<SpamAuditEntry | null>(null);
  const [dismissingEntryId, setDismissingEntryId] = useState<string | null>(null);
  const [clearAllOpen, setClearAllOpen] = useState(false);

  const offset = (page - 1) * PAGE_SIZE;

  const { data, isLoading } = useQuery<SpamAuditLogResponse>({
    queryKey: [`/api/settings/lead-capture-inbox/spam-audit-log?limit=${PAGE_SIZE}&offset=${offset}`],
  });

  const recoverMutation = useMutation({
    mutationFn: async (entryId: string) => {
      setRecoveringEntryId(entryId);
      const response = await apiRequest('POST', `/api/settings/lead-capture-inbox/spam-audit-log/${entryId}/recover`);
      return response.json();
    },
    onSuccess: () => {
      invalidateAuditLog();
      toast({ title: "Lead Created", description: "The flagged email has been recovered as a lead." });
      setSelectedEntry(null);
      setRecoveringEntryId(null);
    },
    onError: (error: any) => {
      toast({
        title: "Recovery Failed",
        description: error.message || "Failed to create lead from flagged email.",
        variant: "destructive",
      });
      setRecoveringEntryId(null);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (entryId: string) => {
      setDismissingEntryId(entryId);
      const response = await apiRequest('DELETE', `/api/settings/lead-capture-inbox/spam-audit-log/${entryId}`);
      return response.json();
    },
    onSuccess: () => {
      invalidateAuditLog();
      toast({ title: "Entry dismissed", description: "Removed from the audit log." });
      setDismissingEntry(null);
      setDismissingEntryId(null);
    },
    onError: (error: any) => {
      toast({
        title: "Dismiss failed",
        description: error.message || "Could not delete this entry.",
        variant: "destructive",
      });
      setDismissingEntryId(null);
    },
  });

  const clearAllMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('DELETE', `/api/settings/lead-capture-inbox/spam-audit-log`);
      return response.json() as Promise<{ deleted: number }>;
    },
    onSuccess: (result) => {
      invalidateAuditLog();
      setPage(1);
      setClearAllOpen(false);
      toast({
        title: "Audit log cleared",
        description: `Cleared ${result.deleted} flagged email${result.deleted === 1 ? '' : 's'}.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Clear failed",
        description: error.message || "Could not clear the audit log.",
        variant: "destructive",
      });
    },
  });

  const entries = data?.entries || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const isRecovering = (entryId: string) => recoverMutation.isPending && recoveringEntryId === entryId;
  const isDismissing = (entryId: string) => dismissMutation.isPending && dismissingEntryId === entryId;

  return (
    <div className="space-y-3">
      <Separator />
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">Spam Audit Log</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Recently flagged emails. You can recover false positives as leads.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Flagged emails are automatically deleted {SPAM_AUDIT_RETENTION_DAYS} days after they're flagged or recovered.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setClearAllOpen(true)}
          disabled={total === 0 || isLoading || clearAllMutation.isPending}
          data-testid="button-clear-all-spam-audit"
        >
          {clearAllMutation.isPending ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3 mr-1" />
          )}
          Clear all
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading audit log...</span>
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <p className="text-xs text-muted-foreground py-2">No flagged emails yet. Emails flagged as spam will appear here.</p>
      )}

      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              role="button"
              tabIndex={0}
              className="rounded-md border p-3 space-y-1 cursor-pointer hover-elevate"
              onClick={() => setSelectedEntry(entry)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedEntry(entry);
                }
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{entry.subject}</p>
                  <p className="text-xs text-muted-foreground truncate">{entry.senderEmail}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDismissingEntry(entry);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    disabled={isDismissing(entry.id)}
                    aria-label="Dismiss entry"
                    data-testid={`button-dismiss-spam-audit-${entry.id}`}
                  >
                    {isDismissing(entry.id) ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                  <Badge variant="secondary" className="no-default-active-elevate text-xs tabular-nums">
                    {entry.spamConfidence}%
                  </Badge>
                  {entry.recoveredAt ? (
                    <Link href={entry.recoveredLeadId ? `/leads/${entry.recoveredLeadId}` : '#'}>
                      <Badge variant="outline" className="no-default-active-elevate text-xs cursor-pointer">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Recovered
                      </Badge>
                    </Link>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        recoverMutation.mutate(entry.id);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      disabled={isRecovering(entry.id)}
                    >
                      {isRecovering(entry.id) ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3 mr-1" />
                      )}
                      Create Lead
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {entry.reason && (
                  <span className="text-xs text-muted-foreground">{entry.reason}</span>
                )}
                <span className="text-xs text-muted-foreground ml-auto">{formatDateTime(entry.flaggedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            <ChevronLeft className="h-3 w-3 mr-1" />
            Previous
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
            <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      )}

      <Dialog open={!!selectedEntry} onOpenChange={(open) => { if (!open) setSelectedEntry(null); }}>
        <DialogContent className="max-w-lg sm:max-w-lg max-w-[calc(100vw-2rem)] overflow-x-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 min-w-0">
              <Mail className="h-4 w-4 shrink-0" />
              <span className="truncate">{selectedEntry?.subject}</span>
            </DialogTitle>
            <DialogDescription>Flagged email details</DialogDescription>
          </DialogHeader>

          {selectedEntry && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm text-muted-foreground">From</span>
                  <span className="text-sm font-medium break-all">{selectedEntry.senderEmail}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm text-muted-foreground">Flagged</span>
                  <span className="text-sm">{formatDateTime(selectedEntry.flaggedAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm text-muted-foreground">Spam confidence</span>
                  <Badge variant="secondary" className="no-default-active-elevate text-xs tabular-nums">
                    {selectedEntry.spamConfidence}%
                  </Badge>
                </div>
                {selectedEntry.reason && (
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground">Reason</span>
                    <span className="text-sm break-words">{selectedEntry.reason}</span>
                  </div>
                )}
              </div>

              <Separator />

              <div className="space-y-1">
                <span className="text-sm font-medium">Email body</span>
                <div className="rounded-md border bg-muted/50 p-3 max-h-64 overflow-y-auto overflow-x-hidden">
                  <pre className="text-sm whitespace-pre-wrap break-words font-sans">{selectedEntry.body}</pre>
                </div>
              </div>

              <div className="flex justify-end">
                {selectedEntry.recoveredAt ? (
                  <Link href={selectedEntry.recoveredLeadId ? `/leads/${selectedEntry.recoveredLeadId}` : '#'}>
                    <Badge variant="outline" className="no-default-active-elevate cursor-pointer">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Recovered
                    </Badge>
                  </Link>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => recoverMutation.mutate(selectedEntry.id)}
                    disabled={isRecovering(selectedEntry.id)}
                  >
                    {isRecovering(selectedEntry.id) ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4 mr-1" />
                    )}
                    Create Lead
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!dismissingEntry}
        onOpenChange={(open) => { if (!open && !dismissMutation.isPending) setDismissingEntry(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the audit log entry only. It does not change any spam rules
              {dismissingEntry?.recoveredAt ? ', and the recovered lead will not be removed.' : '.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dismissMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (dismissingEntry) dismissMutation.mutate(dismissingEntry.id);
              }}
              disabled={dismissMutation.isPending}
              data-testid="button-confirm-dismiss-spam-audit"
            >
              {dismissMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : null}
              Dismiss
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={clearAllOpen}
        onOpenChange={(open) => { if (!clearAllMutation.isPending) setClearAllOpen(open); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all flagged emails?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete all {total} flagged email{total === 1 ? '' : 's'} from the audit log?
              Recovered entries will not be removed. This action is irreversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearAllMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                clearAllMutation.mutate();
              }}
              disabled={clearAllMutation.isPending}
              data-testid="button-confirm-clear-all-spam-audit"
            >
              {clearAllMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : null}
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
