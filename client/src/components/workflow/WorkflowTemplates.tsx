import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, FileText, Users, Briefcase } from 'lucide-react';
import { workflowTemplates, WorkflowTemplate } from '@/data/workflow-templates';

type WorkflowTemplatesProps = {
  onSelectTemplate: (template: WorkflowTemplate) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

export function WorkflowTemplates({ onSelectTemplate, open, onOpenChange, hideTrigger }: WorkflowTemplatesProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open !== undefined ? open : internalOpen;
  const setIsOpen = onOpenChange || setInternalOpen;

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'sales':
        return <Users className="h-4 w-4" />;
      case 'service':
        return <Briefcase className="h-4 w-4" />;
      case 'follow-up':
        return <FileText className="h-4 w-4" />;
      default:
        return <FileText className="h-4 w-4" />;
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'sales':
        return 'default';
      case 'service':
        return 'secondary';
      case 'follow-up':
        return 'outline';
      default:
        return 'outline';
    }
  };

  const handleSelectTemplate = (template: WorkflowTemplate) => {
    onSelectTemplate(template);
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button variant="outline" data-testid="button-templates">
            <Plus className="h-4 w-4 mr-2" />
            Use Template
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Workflow Templates</DialogTitle>
          <DialogDescription>
            Choose from pre-configured workflows to get started quickly
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-[500px] pr-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {workflowTemplates.map((template) => (
              <Card
                key={template.id}
                className="hover-elevate cursor-pointer"
                data-testid={`card-template-${template.id}`}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {getCategoryIcon(template.category)}
                      <CardTitle className="text-base">{template.name}</CardTitle>
                    </div>
                    <Badge variant={getCategoryColor(template.category)} className="text-xs">
                      {template.category}
                    </Badge>
                  </div>
                  <CardDescription className="text-sm">
                    {template.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-3">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>{template.nodes.length} steps</span>
                    <span>•</span>
                    <span>{template.edges.length} connections</span>
                  </div>
                </CardContent>
                <CardFooter>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => handleSelectTemplate(template)}
                    data-testid={`button-use-${template.id}`}
                  >
                    Use This Template
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
