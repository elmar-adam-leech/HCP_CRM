import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, MessageSquare, Mail } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { useMutation } from "@tanstack/react-query";
import { useTemplates } from "@/hooks/useTemplates";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Template } from "@shared/schema";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { SmsTemplateList } from "@/components/templates/SmsTemplateList";
import { EmailTemplateList } from "@/components/templates/EmailTemplateList";
import { TemplateFormModal, templateFormSchema, type TemplateFormData } from "@/components/templates/TemplateFormModal";

export default function Templates() {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "text" | "email">("all");
  const [templateModal, setTemplateModal] = useState<{
    isOpen: boolean;
    template?: Template;
    mode: "create" | "edit";
  }>({ isOpen: false, mode: "create" });

  const [deleteConfirm, setDeleteConfirm] = useState<{
    isOpen: boolean;
    templateId?: string;
    templateTitle?: string;
  }>({ isOpen: false });

  const { toast } = useToast();

  const { data: textTemplates = [], isLoading: textLoading } = useTemplates('text', filterType === 'all' || filterType === 'text');
  const { data: emailTemplates = [], isLoading: emailLoading } = useTemplates('email', filterType === 'all' || filterType === 'email');
  const templates: Template[] = filterType === 'text' ? textTemplates : filterType === 'email' ? emailTemplates : [...textTemplates, ...emailTemplates];
  const templatesLoading = textLoading || emailLoading;

  const form = useForm<TemplateFormData>({
    resolver: zodResolver(templateFormSchema),
    defaultValues: { title: "", type: "text", subject: "", content: "" },
  });

  const createTemplateMutation = useMutation({
    mutationFn: (data: TemplateFormData) => apiRequest("POST", "/api/templates", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/templates'] });
      setTemplateModal({ isOpen: false, mode: "create" });
      form.reset();
      toast({ title: "Template created", description: "Your template has been created successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create template. Please try again.", variant: "destructive" });
    },
  });

  const updateTemplateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: TemplateFormData }) =>
      apiRequest("PUT", `/api/templates/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/templates'] });
      setTemplateModal({ isOpen: false, mode: "create" });
      form.reset();
      toast({ title: "Template updated", description: "Your template has been updated successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update template. Please try again.", variant: "destructive" });
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/templates'] });
      toast({ title: "Template deleted", description: "Your template has been deleted successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete template. Please try again.", variant: "destructive" });
    },
  });

  const approveTemplateMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/templates/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/templates'] });
      toast({ title: "Template approved", description: "Template is now available company-wide." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to approve template. Please try again.", variant: "destructive" });
    },
  });

  const rejectTemplateMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiRequest("POST", `/api/templates/${id}/reject`, { rejectionReason: reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/templates'] });
      toast({ title: "Template rejected", description: "Template creator has been notified." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to reject template. Please try again.", variant: "destructive" });
    },
  });

  const { data: currentUser } = useCurrentUser();
  const isAdmin = isStrictAdmin(currentUser?.user?.role);

  const handleOpenModal = (mode: "create" | "edit", template?: Template) => {
    if (mode === "edit" && template) {
      form.setValue("title", template.title);
      form.setValue("type", template.type as "text" | "email");
      form.setValue("subject", template.subject ?? "");
      form.setValue("content", template.content);
    } else {
      form.reset();
    }
    setTemplateModal({ isOpen: true, mode, template });
  };

  const handleCloseModal = () => {
    setTemplateModal({ isOpen: false, mode: "create" });
    form.reset();
  };

  const onSubmit = (data: TemplateFormData) => {
    const cleanData = {
      ...data,
      subject: data.type === "email" ? (data.subject || undefined) : undefined,
    };
    if (templateModal.mode === "edit" && templateModal.template) {
      updateTemplateMutation.mutate({ id: templateModal.template.id, data: cleanData });
    } else {
      createTemplateMutation.mutate(cleanData);
    }
  };

  const handleDeleteTemplate = (id: string) => {
    const template = templates.find(t => t.id === id);
    setDeleteConfirm({ isOpen: true, templateId: id, templateTitle: template?.title });
  };

  const filteredTemplates = templates.filter((template) => {
    const matchesSearch = template.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         template.content.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = filterType === "all" || template.type === filterType;
    return matchesSearch && matchesType;
  });

  const smsTemplates = filteredTemplates.filter(t => t.type === 'text');
  const emailTemplatesFiltered = filteredTemplates.filter(t => t.type === 'email');

  const sharedListProps = {
    isAdmin,
    onEdit: (template: Template) => handleOpenModal("edit", template),
    onDelete: handleDeleteTemplate,
    onApprove: (id: string) => approveTemplateMutation.mutate(id),
    onReject: (id: string, reason: string) => rejectTemplateMutation.mutate({ id, reason }),
    isApproving: approveTemplateMutation.isPending,
    isRejecting: rejectTemplateMutation.isPending,
  };

  return (
    <PageLayout>
      <PageHeader
        title="Templates"
        description="Manage your text and email templates"
        actions={
          <Button onClick={() => handleOpenModal("create")} data-testid="button-create-template">
            <Plus className="h-4 w-4 mr-2" />
            Create Template
          </Button>
        }
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-templates"
          />
        </div>
        <div className="flex gap-2">
          <Button variant={filterType === "all" ? "default" : "outline"} size="sm" onClick={() => setFilterType("all")} data-testid="filter-all">All</Button>
          <Button variant={filterType === "text" ? "default" : "outline"} size="sm" onClick={() => setFilterType("text")} data-testid="filter-text">
            <MessageSquare className="h-4 w-4 mr-1" />Text
          </Button>
          <Button variant={filterType === "email" ? "default" : "outline"} size="sm" onClick={() => setFilterType("email")} data-testid="filter-email">
            <Mail className="h-4 w-4 mr-1" />Email
          </Button>
        </div>
      </div>

      {templatesLoading ? (
        <div className="text-center py-8" data-testid="loading-templates">
          <div className="text-muted-foreground">Loading templates...</div>
        </div>
      ) : filteredTemplates.length === 0 ? (
        <div className="text-center py-8" data-testid="no-templates">
          <div className="text-muted-foreground">
            {searchQuery || filterType !== "all" ? "No templates match your criteria" : "No templates found"}
          </div>
          {!searchQuery && filterType === "all" && (
            <Button onClick={() => handleOpenModal("create")} className="mt-4" data-testid="button-create-first-template">
              <Plus className="h-4 w-4 mr-2" />
              Create your first template
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <SmsTemplateList templates={smsTemplates} {...sharedListProps} />
          <EmailTemplateList templates={emailTemplatesFiltered} {...sharedListProps} />
        </div>
      )}

      <TemplateFormModal
        isOpen={templateModal.isOpen}
        mode={templateModal.mode}
        form={form}
        onSubmit={onSubmit}
        onClose={handleCloseModal}
        isSubmitting={createTemplateMutation.isPending || updateTemplateMutation.isPending}
      />

      <DeleteConfirmDialog
        isOpen={deleteConfirm.isOpen}
        onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, isOpen: open }))}
        title="Delete Template"
        description={`Are you sure you want to delete "${deleteConfirm.templateTitle}"? This action cannot be undone.`}
        onConfirm={() => {
          if (deleteConfirm.templateId) deleteTemplateMutation.mutate(deleteConfirm.templateId);
        }}
        confirmTestId="button-confirm-delete-template"
      />
    </PageLayout>
  );
}
