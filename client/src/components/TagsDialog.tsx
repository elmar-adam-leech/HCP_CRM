import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "lucide-react";

interface TagsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: string[];
  onSave: (tags: string[]) => void;
  entityName?: string;
  entityType?: string;
}

export function TagsDialog({
  open,
  onOpenChange,
  tags: initialTags,
  onSave,
  entityName,
  entityType = "item",
}: TagsDialogProps) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    if (open) {
      setTags(initialTags);
      setInputValue("");
    }
  }, [open, initialTags]);

  const handleAddTag = () => {
    const newTag = inputValue.trim();
    if (newTag && !tags.includes(newTag)) {
      setTags([...tags, newTag]);
      setInputValue("");
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleSave = () => {
    onSave(tags);
    onOpenChange(false);
  };

  const handleClose = () => {
    setTags(initialTags);
    setInputValue("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="sm:max-w-[500px]" data-testid="dialog-manage-tags">
        <DialogHeader>
          <DialogTitle>Manage Tags</DialogTitle>
          <DialogDescription>
            {entityName 
              ? `Add or remove tags for ${entityName}` 
              : `Add or remove tags for this ${entityType}`
            }
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          {/* Current Tags */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Current Tags</label>
            <div className="flex flex-wrap gap-2 min-h-[40px] p-2 border rounded-md">
              {tags.length === 0 ? (
                <span className="text-sm text-muted-foreground">No tags yet</span>
              ) : (
                tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="gap-1 pr-1"
                    data-testid={`badge-tag-${tag}`}
                  >
                    <span>{tag}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 hover:bg-transparent"
                      onClick={() => handleRemoveTag(tag)}
                      data-testid={`button-remove-tag-${tag}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))
              )}
            </div>
          </div>

          {/* Add New Tag */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Add Tag</label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Enter tag name..."
                data-testid="input-add-tag"
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleAddTag}
                disabled={!inputValue.trim()}
                data-testid="button-add-tag"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            data-testid="button-cancel-tags"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            data-testid="button-save-tags"
          >
            Save Tags
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
