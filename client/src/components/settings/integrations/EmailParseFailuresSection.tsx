import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDateTime } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface EmailParseFailure {
  id: string;
  inboxId: string;
  messageId: string;
  email: {
    from: string;
    subject: string;
    body: string;
    date: string;
  };
  errorCode: string;
  errorMessage: string;
  attempts: number;
  failedAt: string;
  lastAttemptAt: string;
  resolvedAt: string | null;
}

interface EmailParseFailuresResponse {
  entries: EmailParseFailure[];
  total: number;
}

const PARSE_FAILURES_QUERY_KEY = "/api/settings/lead-capture-inbox/parse-failures";

function errorMessage(error: unknown): string {
  const fallback = "Could not retry this email.";
  if (!(error instanceof Error)) return fallback;

  // apiRequest includes the HTTP status and JSON response in Error.message.
  // Prefer the server's actionable message (notably the reconnect guidance).
  const jsonStart = error.message.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const body = JSON.parse(error.message.slice(jsonStart));
      if (typeof body.message === "string" && body.message) {
        return body.message;
      }
    } catch {
      // The response was not JSON; show the request error below.
    }
  }
  return error.message || fallback;
}

function invalidateLeadCaptureResults() {
  queryClient.invalidateQueries({ queryKey: [PARSE_FAILURES_QUERY_KEY] });
  queryClient.invalidateQueries({ queryKey: ["/api/settings/lead-capture-inbox"] });
  queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === "string" &&
      query.queryKey[0].startsWith("/api/settings/lead-capture-inbox/spam-audit-log"),
  });
  queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
  queryClient.invalidateQueries({ queryKey: ["/api/contacts/paginated"] });
}

export function EmailParseFailuresSection() {
  const { toast } = useToast();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ id: string; message: string } | null>(null);

  const { data, isPending, isError, error, refetch, isFetching } = useQuery<EmailParseFailuresResponse>({
    queryKey: [PARSE_FAILURES_QUERY_KEY],
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      setRetryingId(id);
      setRetryError(null);
      const response = await apiRequest(
        "POST",
        `/api/settings/lead-capture-inbox/parse-failures/${encodeURIComponent(id)}/retry`,
      );
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Email reprocessed",
        description: "The saved email was processed successfully.",
      });
      setRetryingId(null);
      invalidateLeadCaptureResults();
    },
    onError: (mutationError: unknown, id) => {
      const message = errorMessage(mutationError);
      setRetryError({ id, message });
      setRetryingId(null);
      invalidateLeadCaptureResults();
    },
  });

  const entries = data?.entries ?? [];

  return (
    <div className="space-y-3" data-testid="email-parse-failures-section">
      <Separator />
      <div>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <p className="text-sm font-medium">Email parse failures</p>
          {!!data?.total && (
            <Badge variant="destructive" className="text-xs tabular-nums">
              {data.total}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Saved emails that need manual review remain available here, even if the inbox is disconnected.
        </p>
      </div>

      {isPending && (
        <div className="flex items-center gap-2 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading emails that need review...</span>
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{errorMessage(error)}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              {isFetching && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!isPending && !isError && entries.length === 0 && (
        <p className="py-2 text-xs text-muted-foreground">No emails need parsing review.</p>
      )}

      {entries.length > 0 && (
        <div className="space-y-3">
          {entries.map((entry) => {
            const isRetrying = retryMutation.isPending && retryingId === entry.id;
            const entryRetryError = retryError?.id === entry.id ? retryError.message : null;

            return (
              <div
                key={entry.id}
                className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
                data-testid={`email-parse-failure-${entry.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-destructive">
                      Needs review — AI parsing failed
                    </p>
                    <p className="mt-1 truncate text-sm font-medium">
                      {entry.email.subject || "(No subject)"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{entry.email.from}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => retryMutation.mutate(entry.id)}
                    disabled={retryMutation.isPending || !!entry.resolvedAt}
                    data-testid={`button-retry-parse-failure-${entry.id}`}
                  >
                    {isRetrying ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3 w-3" />
                    )}
                    {isRetrying ? "Retrying..." : entry.resolvedAt ? "Resolved" : "Retry"}
                  </Button>
                </div>

                <Alert className="bg-background/70">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    The failed AI parse did not classify this email as spam or create a lead. Saved emails from the connected inbox are retried during sync.
                  </AlertDescription>
                </Alert>

                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="inline text-muted-foreground">Reason: </dt>
                    <dd className="inline break-words">{entry.errorMessage || entry.errorCode}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Attempts: </dt>
                    <dd className="inline tabular-nums">{entry.attempts}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Email received: </dt>
                    <dd className="inline">{formatDateTime(entry.email.date)}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Last attempt: </dt>
                    <dd className="inline">{formatDateTime(entry.lastAttemptAt || entry.failedAt)}</dd>
                  </div>
                </dl>

                {entryRetryError && (
                  <Alert variant="destructive" data-testid={`retry-error-parse-failure-${entry.id}`}>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{entryRetryError}</AlertDescription>
                  </Alert>
                )}

                <details className="group rounded-md border bg-background/70">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-sm font-medium">
                    Review plain-text email body
                    <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="max-h-72 overflow-auto border-t p-3">
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                      {entry.email.body || "(Empty email body)"}
                    </pre>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}