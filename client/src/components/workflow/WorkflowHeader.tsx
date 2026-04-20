import { Link } from "wouter";
import { Plus, Save, Trash2, ArrowLeft, MoreVertical, Play, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { WorkflowTemplates } from "@/components/workflow/WorkflowTemplates";
import { WorkflowTestDialog } from "@/components/workflow/WorkflowTestDialog";
import { WorkflowTemplate } from "@/data/workflow-templates";
import type { Workflow, WorkflowApprovalStatus } from "@/types/workflow";
import { useState } from "react";

type WorkflowHeaderProps = {
  workflowId: string | undefined;
  workflowName: string;
  setWorkflowName: (name: string) => void;
  workflow: Workflow | undefined;
  creator: { id: string; name: string; email: string } | undefined;
  isDirty: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  isToggling: boolean;
  onSave: () => void;
  onDelete: () => void;
  onToggleActive: (isActive: boolean) => void;
  onNewWorkflow: () => void;
  onSelectTemplate: (template: WorkflowTemplate) => void;
  onSaveBeforeTest: () => Promise<void>;
};

function getApprovalStatusBadge(status: WorkflowApprovalStatus) {
  switch (status) {
    case 'approved':
      return <Badge variant="default" data-testid="badge-workflow-approved">Approved</Badge>;
    case 'pending_approval':
      return <Badge variant="secondary" data-testid="badge-workflow-pending">Pending Approval</Badge>;
    case 'rejected':
      return <Badge variant="destructive" data-testid="badge-workflow-rejected">Rejected</Badge>;
    default:
      return null;
  }
}

export function WorkflowHeader({
  workflowId,
  workflowName,
  setWorkflowName,
  workflow,
  creator,
  isDirty,
  isSaving,
  isDeleting,
  isToggling,
  onSave,
  onDelete,
  onToggleActive,
  onNewWorkflow,
  onSelectTemplate,
  onSaveBeforeTest,
}: WorkflowHeaderProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [mobileTemplateOpen, setMobileTemplateOpen] = useState(false);
  const [mobileTestOpen, setMobileTestOpen] = useState(false);

  const testDisabled = !workflowId || (!!workflow && workflow.approvalStatus !== 'approved');

  return (
    <div className="flex flex-col gap-2 p-3 md:p-4 border-b">
      <div className="flex items-center gap-2 md:gap-4">
        <Link href="/workflows/manage">
          <Button
            variant="ghost"
            size="icon"
            data-testid="button-back-to-workflows"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <Input
          type="text"
          value={workflowName}
          onChange={(e) => setWorkflowName(e.target.value)}
          className="text-lg md:text-2xl font-bold h-auto border-0 px-2 py-1 focus-visible:ring-1 min-w-0 flex-1 md:flex-none md:max-w-md"
          placeholder="Workflow Name"
          data-testid="input-workflow-name"
        />

        {isDirty && (
          <Badge variant="outline" className="border-yellow-500 text-yellow-600 dark:text-yellow-400 no-default-active-elevate hidden md:inline-flex">
            Unsaved changes
          </Badge>
        )}

        <div className="flex items-center gap-2 ml-auto md:hidden">
          <Button
            variant="default"
            size="default"
            data-testid="button-save-workflow-mobile"
            onClick={onSave}
            disabled={isSaving}
          >
            <Save className="h-4 w-4 mr-1" />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" data-testid="button-workflow-more-menu">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setMobileTemplateOpen(true)}>
                <FileText className="h-4 w-4 mr-2" />
                Use Template
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNewWorkflow}>
                <Plus className="h-4 w-4 mr-2" />
                New Workflow
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setMobileTestOpen(true)}
                disabled={testDisabled}
              >
                <Play className="h-4 w-4 mr-2" />
                Test
              </DropdownMenuItem>
              {workflowId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={isDeleting}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-2 ml-14 flex-wrap">
        <WorkflowTemplates onSelectTemplate={onSelectTemplate} />
        
        <Button
          variant="outline"
          size="default"
          data-testid="button-new-workflow"
          onClick={onNewWorkflow}
        >
          <Plus className="h-4 w-4 mr-2" />
          New Workflow
        </Button>
        
        <WorkflowTestDialog 
          workflowId={workflowId} 
          disabled={testDisabled}
          unapprovedMessage={workflow && workflow.approvalStatus !== 'approved' ? 'Workflow must be approved before testing' : undefined}
          isDirty={isDirty}
          onSaveBeforeTest={onSaveBeforeTest}
        />
        
        <AlertDialog>
          <AlertDialogTrigger asChild>
            {workflowId ? (
              <Button
                variant="outline"
                size="default"
                data-testid="button-delete-workflow"
                disabled={isDeleting}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </Button>
            ) : null}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this workflow? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        
        <Button
          variant="default"
          size="default"
          data-testid="button-save-workflow"
          onClick={onSave}
          disabled={isSaving}
        >
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </div>

      {creator && (
        <div className="hidden md:flex items-center gap-3 ml-14 text-sm text-muted-foreground flex-wrap">
          <span>Created by:</span>
          <span className="font-medium">{creator.name}</span>
          {workflow && getApprovalStatusBadge(workflow.approvalStatus)}
          
          {workflow && workflow.approvalStatus === 'approved' && (
            <div className="flex items-center gap-2 ml-4 border-l pl-4">
              <Switch 
                id="workflow-active"
                checked={workflow.isActive}
                onCheckedChange={onToggleActive}
                disabled={isSaving || isToggling}
                data-testid="switch-workflow-active"
              />
              <Label htmlFor="workflow-active" className={(isSaving || isToggling) ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}>
                {isToggling ? (workflow.isActive ? 'Deactivating...' : 'Activating...') : (workflow.isActive ? 'Active' : 'Inactive')}
              </Label>
            </div>
          )}
        </div>
      )}

      <WorkflowTemplates
        onSelectTemplate={onSelectTemplate}
        open={mobileTemplateOpen}
        onOpenChange={setMobileTemplateOpen}
        hideTrigger
      />

      <WorkflowTestDialog
        workflowId={workflowId}
        disabled={testDisabled}
        unapprovedMessage={workflow && workflow.approvalStatus !== 'approved' ? 'Workflow must be approved before testing' : undefined}
        isDirty={isDirty}
        onSaveBeforeTest={onSaveBeforeTest}
        open={mobileTestOpen}
        onOpenChange={setMobileTestOpen}
        hideTrigger
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this workflow? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setShowDeleteDialog(false); onDelete(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
