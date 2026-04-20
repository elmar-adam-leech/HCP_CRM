import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { 
  SiFacebook 
} from "react-icons/si";
import { 
  ArrowLeft, 
  RefreshCw, 
  Calendar as CalendarIcon, 
  CheckCircle, 
  XCircle,
  Database,
  MapPin,
  Mail,
  Phone,
  User,
  FileText,
  Save,
  Loader2,
  Stethoscope,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Tag,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DatePicker } from "@/components/ui/date-picker";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select";

interface DiagnoseResult {
  connected?: boolean;
  message?: string;
  pageId?: string;
  hasPageToken?: boolean;
  hasUserToken?: boolean;
  tokenValid?: boolean;
  tokenType?: string;
  grantedPermissions?: string[];
  hasLeadsRetrieval?: boolean;
  tokenExpiresAt?: string;
  tokenDebugError?: string;
  pageTokenWorks?: boolean;
  pageTokenError?: { code?: number; message?: string; type?: string };
  userTokenValid?: boolean | null;
  userTokenError?: string;
  formCount?: number;
  webhookVerifyTokenSet?: boolean;
  webhookSubscribed?: boolean;
  webhookSubscriptionError?: string;
  guidance?: string[];
}

export default function FacebookSetup() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [sinceDate, setSinceDate] = useState<Date>();
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [showDiag, setShowDiag] = useState(false);

  // Form Tags state — initialized from server data when first loaded
  const [formTagRules, setFormTagRules] = useState<Record<string, string[]>>({});
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({});
  const [formTagRulesInitialized, setFormTagRulesInitialized] = useState(false);

  const { data: fbStatus } = useQuery<{ connected: boolean; pageId?: string; pageName?: string }>({
    queryKey: ['/api/integrations/facebook/status'],
  });

  const { data: mappingData } = useQuery<{ mappings: Record<string, string> }>({
    queryKey: ['/api/integrations/facebook/field-mappings'],
  });

  const { data: formTagsData } = useQuery<{ rules: Record<string, string[]> }>({
    queryKey: ['/api/integrations/facebook/form-tags'],
  });

  const { data: formsData, isLoading: isLoadingFields, refetch: loadFields } = useQuery<{ 
    forms: Array<{ id: string; name: string; fields: string[] }> 
  }>({
    queryKey: ['/api/integrations/facebook/form-fields'],
    enabled: false,
  });

  const { data: formsForTagging, isLoading: isLoadingForms, refetch: loadForms } = useQuery<{
    forms: Array<{ id: string; name: string }>;
  }>({
    queryKey: ['/api/integrations/facebook/forms'],
    enabled: false,
  });

  // Seed local formTagRules state from server once on first load
  useEffect(() => {
    if (formTagsData?.rules && !formTagRulesInitialized) {
      setFormTagRules(formTagsData.rules);
      setFormTagRulesInitialized(true);
    }
  }, [formTagsData, formTagRulesInitialized]);

  const diagnoseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('GET', '/api/integrations/facebook/diagnose');
      return res.json() as Promise<DiagnoseResult>;
    },
    onSuccess: () => {
      setShowDiag(true);
    },
    onError: () => {
      toast({ title: "Diagnostic failed", variant: "destructive" });
    },
  });

  const resubscribeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/integrations/facebook/resubscribe-webhook');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Webhook Re-subscribed", description: "Your page is now subscribed to receive real-time leads." });
      diagnoseMutation.mutate();
    },
    onError: (error: any) => {
      toast({ title: "Re-subscribe Failed", description: error.message || "Failed to re-subscribe to webhook.", variant: "destructive" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async (date?: Date) => {
      const response = await apiRequest('POST', '/api/integrations/facebook/sync-leads', {
        sinceDate: date?.toISOString(),
      });
      const data = await response.json();
      if (!response.ok) throw data;
      return data as { imported: number; skipped: number; total: number };
    },
    onSuccess: (data) => {
      toast({
        title: "Sync Complete",
        description: `Imported ${data.imported} new leads, skipped ${data.skipped} duplicates.`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
    },
    onError: (error: any) => {
      const fbDetail = error?.detail;
      const code = error?.code;
      let description = error?.message || "Failed to sync leads from Facebook.";
      if (fbDetail) {
        description = fbDetail;
        if (code === 100) {
          description += " — Go to Meta Business Manager → Lead Access and assign this app as a CRM for your page.";
        } else if (code === 200) {
          description += " — Check that your Meta account has admin access to this page.";
        } else if (code === 190) {
          description += " — Token expired. Please reconnect Facebook in Settings → Integrations.";
        }
      }
      toast({
        title: "Sync Failed",
        description,
        variant: "destructive",
      });
    },
  });

  const saveMappingsMutation = useMutation({
    mutationFn: async (newMappings: Record<string, string>) => {
      const response = await apiRequest('POST', '/api/integrations/facebook/field-mappings', newMappings);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Mappings Saved",
        description: "Your Facebook field mappings have been updated.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/field-mappings'] });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save field mappings.",
        variant: "destructive",
      });
    },
  });

  const saveFormTagsMutation = useMutation({
    mutationFn: async (rules: Record<string, string[]>) => {
      const response = await apiRequest('POST', '/api/integrations/facebook/form-tags', rules);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Form Tags Saved",
        description: "Your form tag rules have been updated.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/form-tags'] });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save form tags.",
        variant: "destructive",
      });
    },
  });

  const handleMappingChange = (fbField: string, crmField: string) => {
    setMappings(prev => ({
      ...prev,
      [fbField]: crmField === "none" ? "" : crmField
    }));
  };

  const addTagToForm = (formId: string) => {
    const raw = (tagInputs[formId] || '').trim();
    if (!raw) return;
    const newTags = raw.split(',').map(t => t.trim()).filter(Boolean);
    setFormTagRules(prev => {
      const existing = prev[formId] ?? [];
      const merged = Array.from(new Set([...existing, ...newTags]));
      return { ...prev, [formId]: merged };
    });
    setTagInputs(prev => ({ ...prev, [formId]: '' }));
  };

  const removeTagFromForm = (formId: string, tag: string) => {
    setFormTagRules(prev => {
      const updated = (prev[formId] ?? []).filter(t => t !== tag);
      if (updated.length === 0) {
        const next = { ...prev };
        delete next[formId];
        return next;
      }
      return { ...prev, [formId]: updated };
    });
  };

  const crmFields = [
    { value: "name", label: "Name", icon: User },
    { value: "email", label: "Email", icon: Mail },
    { value: "phone", label: "Phone", icon: Phone },
    { value: "address", label: "Address", icon: MapPin },
    { value: "notes", label: "Notes", icon: FileText },
  ];

  const diagResult = diagnoseMutation.data;

  return (
    <PageLayout>
      <PageHeader 
        title="Facebook Lead Ads Setup" 
        description="Configure how leads are imported from your Facebook Pages and map form fields."
        icon={<SiFacebook className="h-6 w-6 text-white" />}
        actions={
          <Button
            variant="outline"
            onClick={() => navigate('/settings?tab=integrations')}
            data-testid="button-back-to-integrations"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Integrations
          </Button>
        }
      />

      <div className="grid gap-6">
        {/* Section 1: Connection Status */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Database className="h-5 w-5 text-muted-foreground" />
              Connection Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Linked Facebook Page</p>
                {fbStatus?.connected ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="default" className="gap-1">
                      <CheckCircle className="h-3 w-3" />
                      Connected
                    </Badge>
                    <span className="text-sm text-muted-foreground font-medium">
                      {fbStatus.pageName || fbStatus.pageId}
                    </span>
                  </div>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <XCircle className="h-3 w-3" />
                    Not Connected
                  </Badge>
                )}
              </div>
              {fbStatus?.connected && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    diagnoseMutation.mutate();
                    setShowDiag(true);
                  }}
                  disabled={diagnoseMutation.isPending}
                  data-testid="button-diagnose"
                >
                  {diagnoseMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Stethoscope className="h-4 w-4 mr-2" />
                  )}
                  Test Connection
                </Button>
              )}
            </div>

            {/* Diagnostic Panel */}
            {showDiag && diagResult && (
              <div className="rounded-md border bg-muted/40 p-4 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-semibold flex items-center gap-2">
                    <Stethoscope className="h-4 w-4 text-muted-foreground" />
                    Connection Diagnostic
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => setShowDiag(false)}>
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                </div>

                {diagResult.guidance && diagResult.guidance.length > 0 && (
                  <div className="space-y-1.5">
                    {diagResult.guidance.map((g, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                        <span>{g}</span>
                      </div>
                    ))}
                  </div>
                )}

                <Separator />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground text-sm">Token Status</p>
                    <p>Valid: <span className={diagResult.tokenValid ? "text-green-600" : "text-red-500"}>{diagResult.tokenValid ? "Yes" : "No"}</span></p>
                    <p>Type: {diagResult.tokenType ?? "—"}</p>
                    <p>Expires: {diagResult.tokenExpiresAt ?? "—"}</p>
                    <p>leads_retrieval: <span className={diagResult.hasLeadsRetrieval ? "text-green-600" : "text-red-500"}>{diagResult.hasLeadsRetrieval ? "Granted" : "Missing"}</span></p>
                    <p>pages_manage_metadata: <span className={diagResult.hasPagesManageMetadata ? "text-green-600" : "text-red-500"}>{diagResult.hasPagesManageMetadata ? "Granted" : "Missing"}</span></p>
                    {diagResult.grantedPermissions && diagResult.grantedPermissions.length > 0 && (
                      <p>Permissions: {diagResult.grantedPermissions.join(", ")}</p>
                    )}
                    {diagResult.tokenDebugError && (
                      <p className="text-red-500">Error: {diagResult.tokenDebugError}</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium text-foreground text-sm">API Access</p>
                    <p>Page token works: <span className={diagResult.pageTokenWorks ? "text-green-600" : "text-red-500"}>{diagResult.pageTokenWorks ? `Yes (${diagResult.formCount} form(s))` : "No"}</span></p>
                    {!diagResult.pageTokenWorks && diagResult.pageTokenError && (
                      <p className="text-red-500">Error #{diagResult.pageTokenError.code}: {diagResult.pageTokenError.message}</p>
                    )}
                    <p>User token valid: <span className={diagResult.userTokenValid === true ? "text-green-600" : diagResult.userTokenValid === false ? "text-red-500" : "text-muted-foreground"}>
                      {diagResult.userTokenValid === true ? "Yes" : diagResult.userTokenValid === false ? "No" : "Not stored"}
                    </span></p>
                    {diagResult.userTokenValid === false && diagResult.userTokenError && (
                      <p className="text-yellow-600">{diagResult.userTokenError}</p>
                    )}
                    <p>User token stored: <span className={diagResult.hasUserToken ? "text-green-600" : "text-yellow-600"}>{diagResult.hasUserToken ? "Yes" : "No — reconnect to enable fallback"}</span></p>
                    <p className="font-medium text-foreground text-sm pt-2">Webhook</p>
                    <p>Verify token set: <span className={diagResult.webhookVerifyTokenSet ? "text-green-600" : "text-red-500"}>{diagResult.webhookVerifyTokenSet ? "Yes" : "No"}</span></p>
                    <p>Page subscribed: <span className={diagResult.webhookSubscribed ? "text-green-600" : "text-red-500"}>{diagResult.webhookSubscribed ? "Yes" : "No"}</span></p>
                    {diagResult.webhookSubscriptionError && (
                      <p className="text-red-500">Error: {diagResult.webhookSubscriptionError}</p>
                    )}
                  </div>
                </div>

                {diagResult.webhookSubscribed === false && diagResult.webhookVerifyTokenSet && (
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => resubscribeMutation.mutate()}
                      disabled={resubscribeMutation.isPending}
                      data-testid="button-resubscribe-webhook"
                    >
                      {resubscribeMutation.isPending ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3 mr-1" />
                      )}
                      Re-subscribe Webhook
                    </Button>
                  </div>
                )}
              </div>
            )}

            {showDiag && !diagResult && !diagnoseMutation.isPending && (
              <Button variant="ghost" size="sm" onClick={() => setShowDiag(false)} className="text-xs">
                <ChevronDown className="h-3 w-3 mr-1" />
                Hide diagnostic
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Section 2: Sync Leads */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-muted-foreground" />
              Manual Sync
            </CardTitle>
            <CardDescription>
              Import historical leads from your Facebook forms. Webhooks will handle new leads automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="space-y-2 flex-1">
                <label className="text-sm font-medium flex items-center gap-2">
                  <CalendarIcon className="h-4 w-4" />
                  Import leads since
                </label>
                <DatePicker 
                  value={sinceDate} 
                  onChange={setSinceDate}
                />
              </div>
              <Button 
                onClick={() => syncMutation.mutate(sinceDate)} 
                disabled={syncMutation.isPending || !fbStatus?.connected}
                className="w-full sm:w-auto"
                data-testid="button-sync-now"
              >
                {syncMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync Now
              </Button>
            </div>

            {syncMutation.data && (
              <div className="mt-4 p-4 rounded-lg bg-muted/50 border">
                <p className="text-sm font-medium text-foreground">Last Sync Result:</p>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  <li>• Imported: {syncMutation.data.imported}</li>
                  <li>• Skipped (Duplicates): {syncMutation.data.skipped}</li>
                  <li>• Total Processed: {syncMutation.data.total}</li>
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 3: Field Mapping */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <MapPin className="h-5 w-5 text-muted-foreground" />
                  Field Mapping
                </CardTitle>
                <CardDescription>
                  Map your Facebook lead form fields to CRM contact fields.
                </CardDescription>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => loadFields()}
                disabled={isLoadingFields || !fbStatus?.connected}
              >
                {isLoadingFields ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Load Form Fields
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {!formsData ? (
              <div className="text-center py-8 border-2 border-dashed rounded-lg">
                <p className="text-sm text-muted-foreground">
                  Click "Load Form Fields" to see available fields from your Facebook forms.
                </p>
              </div>
            ) : formsData.forms.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">No lead forms found for this page.</p>
              </div>
            ) : (
              <div className="space-y-8">
                {formsData.forms.map((form) => (
                  <div key={form.id} className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-xs">FORM</Badge>
                      <h3 className="font-semibold">{form.name}</h3>
                    </div>
                    <div className="grid gap-3">
                      {form.fields.map((field) => (
                        <div key={`${form.id}-${field}`} className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-md border bg-card">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{field}</p>
                            <p className="text-xs text-muted-foreground truncate">Facebook Field</p>
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground hidden sm:flex">
                            <ArrowLeft className="h-4 w-4 rotate-180" />
                          </div>
                          <div className="w-full sm:w-64">
                            <Select 
                              value={mappings[field] || mappingData?.mappings[field] || "none"}
                              onValueChange={(val) => handleMappingChange(field, val)}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select mapping..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No mapping (Save to notes)</SelectItem>
                                <Separator className="my-1" />
                                {crmFields.map((f) => (
                                  <SelectItem key={f.value} value={f.value}>
                                    <div className="flex items-center gap-2">
                                      <f.icon className="h-3.5 w-3.5 text-muted-foreground" />
                                      <span>{f.label}</span>
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                
                <div className="pt-4 flex justify-end">
                  <Button 
                    onClick={() => saveMappingsMutation.mutate(mappings)}
                    disabled={saveMappingsMutation.isPending || Object.keys(mappings).length === 0}
                    data-testid="button-save-mappings"
                  >
                    {saveMappingsMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    Save Mappings
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 4: Form Tags */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Tag className="h-5 w-5 text-muted-foreground" />
                  Form Tags
                </CardTitle>
                <CardDescription>
                  Automatically apply tags to contacts based on which Facebook form they submitted. Load your forms, then assign tags to each one.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadForms()}
                disabled={isLoadingForms || !fbStatus?.connected}
                data-testid="button-load-forms"
              >
                {isLoadingForms ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Load Forms
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {!formsForTagging ? (
              <div className="text-center py-8 border-2 border-dashed rounded-lg">
                <p className="text-sm text-muted-foreground">
                  Click "Load Forms" to see your available Facebook forms and assign tags.
                </p>
              </div>
            ) : formsForTagging.forms.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">No lead forms found for this page.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {formsForTagging.forms.map((form) => {
                  const tags = formTagRules[form.id] ?? [];
                  return (
                    <div key={form.id} className="p-4 rounded-md border bg-card space-y-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-xs">FORM</Badge>
                        <span className="font-semibold text-sm">{form.name}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="gap-1">
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTagFromForm(form.id, tag)}
                              className="ml-0.5 hover:text-destructive transition-colors"
                              aria-label={`Remove tag ${tag}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                        {tags.length === 0 && (
                          <span className="text-xs text-muted-foreground">No tags assigned</span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Add tags (comma-separated)"
                          value={tagInputs[form.id] ?? ''}
                          onChange={(e) => setTagInputs(prev => ({ ...prev, [form.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              addTagToForm(form.id);
                            }
                          }}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => addTagToForm(form.id)}
                          disabled={!tagInputs[form.id]?.trim()}
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  );
                })}

                <div className="pt-2 flex justify-end">
                  <Button
                    onClick={() => saveFormTagsMutation.mutate(formTagRules)}
                    disabled={saveFormTagsMutation.isPending}
                    data-testid="button-save-form-tags"
                  >
                    {saveFormTagsMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    Save Form Tags
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}
