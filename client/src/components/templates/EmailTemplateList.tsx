import type { Template } from "@shared/schema";
import { TemplateCard } from "./TemplateCard";

interface EmailTemplateListProps {
  templates: Template[];
  isAdmin: boolean;
  onEdit: (template: Template) => void;
  onDelete: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  isApproving: boolean;
  isRejecting: boolean;
}

export function EmailTemplateList({
  templates,
  isAdmin,
  onEdit,
  onDelete,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: EmailTemplateListProps) {
  return (
    <>
      {templates.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          isAdmin={isAdmin}
          onEdit={onEdit}
          onDelete={onDelete}
          onApprove={onApprove}
          onReject={onReject}
          isApproving={isApproving}
          isRejecting={isRejecting}
        />
      ))}
    </>
  );
}
