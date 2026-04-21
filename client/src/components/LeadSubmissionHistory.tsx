import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { AlertCircle, Calendar, ExternalLink, FileText, Briefcase, LayoutTemplate, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import type { Lead } from "@shared/schema";
import { Link } from "wouter";
import { formatLeadSource } from "@/lib/lead-source";

interface LeadSubmissionHistoryProps {
  contactId: string;
}

function describeHcpSkipReason(reason: string): string {
  switch (reason) {
    case 'integration_disabled':
      return "Housecall Pro integration is disabled or not configured.";
    case 'send_leads_off':
      return "'Send leads to Housecall Pro' is turned off.";
    case 'skip_tag_matched':
      return "Lead carries a tag in the HCP skip list.";
    case 'no_email_or_phone':
      return "Lead has no email or phone number to send.";
    case 'integration_credentials_missing':
      return "Housecall Pro API credentials are missing.";
    case 'failed_create_customer':
      return "Failed to create the customer in Housecall Pro.";
    case 'failed_create_lead':
      return "Failed to create the lead in Housecall Pro.";
    default:
      return reason;
  }
}

export function LeadSubmissionHistory({ contactId }: LeadSubmissionHistoryProps) {
  const { data: leads, isLoading, isError } = useQuery<Lead[]>({
    queryKey: [`/api/contacts/${contactId}/leads`],
    enabled: !!contactId,
  });

  if (isError) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-destructive" data-testid="lead-history-error">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Unable to load submission history.</span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="lead-history-loading">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!leads || leads.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No submission history"
        description="This contact has no lead submissions yet."
        data-testid="lead-history-empty"
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="lead-history-list">
      {leads.map((lead) => (
        <Card key={lead.id} className="hover-elevate" data-testid={`lead-submission-${lead.id}`}>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-base font-medium" data-testid={`lead-date-${lead.id}`}>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  {format(new Date(lead.createdAt), "PPP 'at' p")}
                </div>
              </CardTitle>
              <Badge 
                variant={
                  lead.status === 'converted' ? 'default' :
                  lead.status === 'qualified' ? 'secondary' :
                  lead.status === 'disqualified' ? 'destructive' :
                  'outline'
                }
                data-testid={`lead-status-${lead.id}`}
              >
                {lead.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {lead.source && (
              <div data-testid={`lead-source-${lead.id}`}>
                <span className="text-sm font-medium text-muted-foreground">Source: </span>
                <span className="text-sm">{formatLeadSource(lead.source)}</span>
              </div>
            )}

            {lead.source === 'facebook' && (() => {
              let formId: string | undefined;
              let formName: string | undefined;
              try {
                const raw = JSON.parse(lead.rawPayload ?? '{}');
                formId = raw.form_id ? String(raw.form_id) : undefined;
                formName = raw._fb_form_name ? String(raw._fb_form_name) : undefined;
              } catch {
                // ignore parse errors
              }
              if (!formId) return null;
              return (
                <div className="flex items-center gap-2" data-testid={`lead-fb-form-${lead.id}`}>
                  <LayoutTemplate className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-muted-foreground">Facebook Form:</span>
                  <span className="text-sm">
                    {formName ? (
                      <>{formName} <span className="text-xs text-muted-foreground font-mono">({formId})</span></>
                    ) : (
                      <span className="font-mono text-xs">{formId}</span>
                    )}
                  </span>
                </div>
              );
            })()}

            {lead.source === 'google_local_services' && (() => {
              let glsLeadId: string | undefined;
              let glsLeadType: string | undefined;
              try {
                const raw = JSON.parse(lead.rawPayload ?? '{}');
                glsLeadId = raw._gls_lead_id ? String(raw._gls_lead_id) : undefined;
                glsLeadType = raw._gls_lead_type ? String(raw._gls_lead_type) : undefined;
              } catch {
                // ignore parse errors
              }
              if (!glsLeadId) return null;
              return (
                <div className="flex items-center gap-2" data-testid={`lead-gls-info-${lead.id}`}>
                  <LayoutTemplate className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-muted-foreground">Google Local Services:</span>
                  <span className="text-sm">
                    {glsLeadType ? (
                      <>{glsLeadType.toLowerCase().replace('_', ' ')} <span className="text-xs text-muted-foreground font-mono">({glsLeadId})</span></>
                    ) : (
                      <span className="font-mono text-xs">{glsLeadId}</span>
                    )}
                  </span>
                </div>
              );
            })()}

            {lead.message && (
              <div data-testid={`lead-message-${lead.id}`}>
                <span className="text-sm font-medium text-muted-foreground">Message: </span>
                <p className="text-sm mt-1 whitespace-pre-wrap break-all">{lead.message}</p>
              </div>
            )}

            {lead.pageUrl && (
              <div data-testid={`lead-page-url-${lead.id}`}>
                <span className="text-sm font-medium text-muted-foreground">Page: </span>
                {/^https?:\/\//i.test(lead.pageUrl) ? (
                  <a 
                    href={lead.pageUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline inline-flex items-center gap-1 break-all"
                    data-testid={`lead-page-link-${lead.id}`}
                  >
                    {lead.pageUrl}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-sm break-all" data-testid={`lead-page-link-${lead.id}`}>
                    {lead.pageUrl}
                  </span>
                )}
              </div>
            )}

            {(lead.utmSource || lead.utmMedium || lead.utmCampaign || lead.utmTerm || lead.utmContent) && (
              <div className="space-y-1" data-testid={`lead-utm-params-${lead.id}`}>
                <span className="text-sm font-medium text-muted-foreground">UTM Parameters:</span>
                <div className="flex flex-wrap gap-2 mt-1">
                  {lead.utmSource && (
                    <Badge variant="outline" data-testid={`lead-utm-source-${lead.id}`}>
                      Source: {lead.utmSource}
                    </Badge>
                  )}
                  {lead.utmMedium && (
                    <Badge variant="outline" data-testid={`lead-utm-medium-${lead.id}`}>
                      Medium: {lead.utmMedium}
                    </Badge>
                  )}
                  {lead.utmCampaign && (
                    <Badge variant="outline" data-testid={`lead-utm-campaign-${lead.id}`}>
                      Campaign: {lead.utmCampaign}
                    </Badge>
                  )}
                  {lead.utmTerm && (
                    <Badge variant="outline" data-testid={`lead-utm-term-${lead.id}`}>
                      Term: {lead.utmTerm}
                    </Badge>
                  )}
                  {lead.utmContent && (
                    <Badge variant="outline" data-testid={`lead-utm-content-${lead.id}`}>
                      Content: {lead.utmContent}
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {lead.hcpSyncSkipReason && (
              <div
                className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs"
                data-testid={`lead-hcp-skip-${lead.id}`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="min-w-0">
                  <span className="font-medium">Not sent to Housecall Pro: </span>
                  <span>{describeHcpSkipReason(lead.hcpSyncSkipReason)}</span>
                  {lead.hcpSyncSkipDetail && (
                    <span className="text-muted-foreground"> — {lead.hcpSyncSkipDetail}</span>
                  )}
                </div>
              </div>
            )}

            {(lead.convertedToEstimateId || lead.convertedToJobId) && (
              <div className="pt-2 border-t space-y-2" data-testid={`lead-conversion-${lead.id}`}>
                <span className="text-sm font-medium text-muted-foreground">Conversion:</span>
                <div className="flex flex-wrap gap-2">
                  {lead.convertedToEstimateId && (
                    <Link 
                      href={`/estimates?highlight=${lead.convertedToEstimateId}`}
                      data-testid={`lead-estimate-link-${lead.id}`}
                    >
                      <Badge variant="secondary" className="hover-elevate cursor-pointer">
                        <FileText className="h-3 w-3 mr-1" />
                        Estimate Created
                      </Badge>
                    </Link>
                  )}
                  {lead.convertedToJobId && (
                    <Link 
                      href={`/jobs?highlight=${lead.convertedToJobId}`}
                      data-testid={`lead-job-link-${lead.id}`}
                    >
                      <Badge variant="secondary" className="hover-elevate cursor-pointer">
                        <Briefcase className="h-3 w-3 mr-1" />
                        Job Created
                      </Badge>
                    </Link>
                  )}
                </div>
                {lead.convertedAt && (
                  <p className="text-xs text-muted-foreground" data-testid={`lead-converted-at-${lead.id}`}>
                    Converted on {format(new Date(lead.convertedAt), "PPP")}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
