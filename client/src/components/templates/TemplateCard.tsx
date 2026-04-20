import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Edit2, Trash2, MessageSquare, Mail, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";
import type { Template } from "@shared/schema";

interface TemplateCardProps {
  template: Template;
  isAdmin: boolean;
  onEdit: (template: Template) => void;
  onDelete: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  isApproving: boolean;
  isRejecting: boolean;
}

export function TemplateCard({
  template,
  isAdmin,
  onEdit,
  onDelete,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: TemplateCardProps) {
  const TypeIcon = template.type === "text" ? MessageSquare : Mail;
  const status = template.status || 'approved';
  const isPending = status === 'pending_approval';
  const isRejected = status === 'rejected';

  const handleReject = () => {
    const reason = prompt("Enter rejection reason:");
    if (reason) {
      onReject(template.id, reason);
    }
  };

  return (
    <Card
      className="hover-elevate"
      data-testid={`card-template-${template.id}`}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <TypeIcon className="h-4 w-4 shrink-0" />
          <CardTitle className="text-base font-medium truncate">{template.title}</CardTitle>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(template)}
            data-testid={`button-edit-template-${template.id}`}
          >
            <Edit2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(template.id)}
            data-testid={`button-delete-template-${template.id}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge
              variant={template.type === "text" ? "default" : "secondary"}
              data-testid={`badge-template-type-${template.id}`}
            >
              {template.type.toUpperCase()}
            </Badge>
            {isPending && (
              <Badge variant="outline" className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Pending
              </Badge>
            )}
            {isRejected && (
              <Badge variant="destructive" className="flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                Rejected
              </Badge>
            )}
            {status === 'approved' && (
              <Badge variant="default" className="flex items-center gap-1 bg-green-600">
                <CheckCircle className="h-3 w-3" />
                Approved
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date(template.updatedAt).toLocaleDateString()}
          </div>
        </div>
        <div className="text-sm text-muted-foreground line-clamp-3">
          {template.content}
        </div>
        {isRejected && template.rejectionReason && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Rejection reason:</strong> {template.rejectionReason}
            </AlertDescription>
          </Alert>
        )}
        {isPending && isAdmin && (
          <div className="flex gap-2 pt-2">
            <Button
              size="sm"
              onClick={() => onApprove(template.id)}
              disabled={isApproving}
              data-testid={`button-approve-${template.id}`}
              className="flex-1"
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReject}
              disabled={isRejecting}
              data-testid={`button-reject-${template.id}`}
              className="flex-1"
            >
              <XCircle className="h-3 w-3 mr-1" />
              Reject
            </Button>
          </div>
        )}
        {isPending && !isAdmin && (
          <Alert>
            <Clock className="h-4 w-4" />
            <AlertDescription className="text-xs">
              This template is pending admin approval before it becomes available company-wide.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
