import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { FileText } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface QuickNoteButtonProps {
  leadId?: string;
  estimateId?: string;
  customerId?: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}

export function QuickNoteButton({ 
  leadId, 
  estimateId, 
  customerId,
  variant = "outline",
  size = "sm",
  className = ""
}: QuickNoteButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const { toast } = useToast();

  const createNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const response = await apiRequest('POST', '/api/activities', {
        type: 'note',
        content,
        contactId: leadId,
        estimateId,
        customerId,
      });
      return response.json();
    },
    onSuccess: () => {
      // Invalidate all activity queries including specific ones with contactId/estimateId/customerId
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      if (leadId) {
        queryClient.invalidateQueries({ queryKey: ['/api/activities', { leadId }] });
        queryClient.invalidateQueries({ queryKey: ['/api/activities', { contactId: leadId }] });
      }
      if (estimateId) {
        queryClient.invalidateQueries({ queryKey: ['/api/activities', { estimateId }] });
      }
      if (customerId) {
        queryClient.invalidateQueries({ queryKey: ['/api/activities', { customerId }] });
      }
      setNoteContent("");
      setIsOpen(false);
      toast({ 
        title: "Note added",
        description: "Your note has been saved successfully.",
      });
    },
    onError: () => {
      toast({ 
        title: "Failed to add note",
        description: "Please try again.",
        variant: "destructive" 
      });
    },
  });

  const handleSave = () => {
    if (!noteContent.trim()) {
      toast({ 
        title: "Note content required",
        description: "Please enter some content for your note.",
        variant: "destructive" 
      });
      return;
    }
    createNoteMutation.mutate(noteContent);
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(true);
        }}
        data-testid="button-quick-note"
      >
        <FileText className="h-3 w-3 mr-1 shrink-0" />
        Note
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="w-full max-w-full sm:max-w-md mx-2 sm:mx-4">
          <DialogHeader>
            <DialogTitle>Quick Note</DialogTitle>
            <DialogDescription>
              Add a note about this lead/estimate
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <Textarea
              placeholder="Enter your note here..."
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
              rows={4}
              className="resize-none"
              data-testid="textarea-quick-note"
            />
            
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  setIsOpen(false);
                  setNoteContent("");
                }}
                data-testid="button-cancel-note"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createNoteMutation.isPending}
                data-testid="button-save-note"
              >
                {createNoteMutation.isPending ? "Saving..." : "Save Note"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
