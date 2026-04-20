import { useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { invalidateContacts } from "@/hooks/useInvalidations";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Download, Upload, UserPlus } from "lucide-react";
import { FacebookLeadsImportTab } from "@/components/FacebookLeadsImportTab";
import { LeadForm, contactFormSchema, CONTACT_FORM_DEFAULTS, type ContactFormValues } from "@/components/LeadForm";

interface CreateLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  leads?: Array<{ id: string; name?: string }>;
  onViewDuplicate?: (contactId: string) => void;
}

interface DuplicateContactError extends Error {
  isDuplicate?: boolean;
  duplicateContactId?: string;
  duplicateContactName?: string;
}

export function CreateLeadModal({ isOpen, onClose, onSuccess, leads: _leads = [], onViewDuplicate }: CreateLeadModalProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: fbStatus } = useQuery<{ connected: boolean }>({
    queryKey: ["/api/integrations/facebook/status"],
  });

  const createContactMutation = useMutation({
    mutationFn: async (contactData: ContactFormValues) => {
      const { email, phone, ...rest } = contactData;
      const payload = {
        ...rest,
        type: "lead" as const,
        emails: email ? [email] : [],
        phones: phone ? [phone] : [],
      };

      // Uses raw fetch (not apiRequest) to parse JSON from error responses —
      // apiRequest reads text() before throwing, losing the structured duplicate-
      // detection fields (.isDuplicate, .duplicateContactId, .duplicateContactName).
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.message || "Failed to create contact") as DuplicateContactError;
        error.isDuplicate = data.isDuplicate;
        error.duplicateContactId = data.duplicateContactId;
        error.duplicateContactName = data.duplicateContactName;
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      toast({ title: "Lead Created", description: "Lead has been successfully created." });
      invalidateContacts();
      form.reset();
      onSuccess();
      onClose();
    },
    onError: (error: DuplicateContactError) => {
      if (error.isDuplicate && error.duplicateContactId) {
        toast({
          title: "Duplicate Phone Number",
          description: `A lead with this phone number already exists: ${error.duplicateContactName || "Unknown"}. Click to view.`,
          variant: "destructive",
          action: (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onClose();
                onViewDuplicate?.(error.duplicateContactId!);
              }}
            >
              View Lead
            </Button>
          ),
        });
      } else {
        toast({
          title: "Failed to Create Lead",
          description: error.message || "Something went wrong.",
          variant: "destructive",
        });
      }
    },
  });

  const csvUploadMutation = useMutation({
    mutationFn: async (csvData: string) => {
      const res = await apiRequest("POST", "/api/leads/csv-upload", { csvData });
      return res.json() as Promise<{ message?: string; errors?: unknown[] }>;
    },
    onSuccess: (data) => {
      toast({ title: "CSV Import Successful", description: data.message || "CSV data imported successfully" });
      if (data.errors && data.errors.length > 0) {
        toast({
          title: "Some rows had errors",
          description: `${data.errors.length} rows failed validation and were skipped.`,
          variant: "destructive",
        });
      }
      invalidateContacts();
      if (fileInputRef.current) fileInputRef.current.value = "";
      onSuccess();
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "CSV Import Failed", description: error.message || "Failed to import CSV data", variant: "destructive" });
    },
  });

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: CONTACT_FORM_DEFAULTS,
  });

  const handleDownloadTemplate = async () => {
    try {
      const response = await fetch("/api/leads/csv-template", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to download template");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "leads_template.csv";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      toast({ title: "Download Failed", description: "Could not download CSV template", variant: "destructive" });
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== "text/csv" && !file.name.endsWith(".csv")) {
      toast({ title: "Invalid File Type", description: "Please upload a CSV file", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const csvData = e.target?.result as string;
      csvUploadMutation.mutate(csvData);
    };
    reader.readAsText(file);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) { form.reset(); onClose(); } }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto w-[calc(100vw-2rem)]" data-testid="dialog-add-lead">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Add Lead
          </DialogTitle>
          <DialogDescription>
            Enter the lead's contact information and details to add them to your CRM system.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="manual" className="w-full">
          <TabsList className={`grid w-full ${fbStatus?.connected ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <TabsTrigger value="manual" data-testid="tab-manual">Manual Entry</TabsTrigger>
            <TabsTrigger value="csv" data-testid="tab-csv">CSV Import</TabsTrigger>
            {fbStatus?.connected && (
              <TabsTrigger value="facebook" data-testid="tab-facebook">
                Facebook Leads
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="manual" className="space-y-4 mt-4">
            <LeadForm
              form={form}
              onSubmit={(values) => createContactMutation.mutate(values)}
              onCancel={() => { form.reset(); onClose(); }}
              isPending={createContactMutation.isPending}
              submitLabel="Create Lead"
            />
          </TabsContent>

          <TabsContent value="csv" className="space-y-4 mt-4">
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Upload a CSV file to import multiple leads at once. First download the template to see the required format.
              </p>

              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleDownloadTemplate}
                    disabled={csvUploadMutation.isPending}
                    data-testid="button-download-template"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Template
                  </Button>
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={csvUploadMutation.isPending}
                    data-testid="button-upload-csv"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {csvUploadMutation.isPending ? "Uploading..." : "Upload CSV"}
                  </Button>
                </div>

                <div className="text-sm text-muted-foreground">
                  <div className="font-medium mb-2">Required columns:</div>
                  <ul className="space-y-1">
                    <li>• <span className="font-medium">name</span> (required)</li>
                    <li>• email, phone, address (optional)</li>
                    <li>• source, notes (optional)</li>
                    <li>• followUpDate (optional, YYYY-MM-DD)</li>
                  </ul>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                style={{ display: "none" }}
                data-testid="input-csv-file"
              />

              <div className="flex justify-end">
                <Button variant="outline" onClick={onClose} data-testid="button-cancel-csv">
                  Close
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="facebook" className="mt-4">
            <FacebookLeadsImportTab
              onImportSuccess={() => {
                invalidateContacts();
                onSuccess();
                onClose();
              }}
              onCancel={onClose}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
