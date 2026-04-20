import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Check, X, Loader2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface InlineEditProps {
  value: string | number;
  onSave: (newValue: string | number) => Promise<void>;
  type?: "text" | "number";
  className?: string;
  inputClassName?: string;
  displayClassName?: string;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  showEditIcon?: boolean;
}

export function InlineEdit({
  value,
  onSave,
  type = "text",
  className,
  inputClassName,
  displayClassName,
  placeholder,
  prefix,
  suffix,
  showEditIcon = false,
}: InlineEditProps) {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(value));
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditValue(String(value));
  }, [value]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (editValue === String(value)) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      const valueToSave = type === "number" ? parseFloat(editValue) || 0 : editValue;
      await onSave(valueToSave);
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to save:", error);
      setEditValue(String(value));
      toast({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Your change could not be saved. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValue(String(value));
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  if (isEditing) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
        <Input
          ref={inputRef}
          type={type}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          disabled={isSaving}
          className={cn("h-8 text-sm", inputClassName)}
          placeholder={placeholder}
          data-testid="inline-edit-input"
        />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation();
              handleSave();
            }}
            disabled={isSaving}
            data-testid="inline-edit-save"
          >
            {isSaving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation();
              handleCancel();
            }}
            disabled={isSaving}
            data-testid="inline-edit-cancel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-1 cursor-pointer hover-elevate rounded px-2 py-1 -mx-2 -my-1",
        displayClassName
      )}
      onClick={() => setIsEditing(true)}
      data-testid="inline-edit-display"
    >
      {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
      <span className="flex-1">
        {value || <span className="text-muted-foreground italic">{placeholder}</span>}
      </span>
      {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      {showEditIcon && (
        <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </div>
  );
}
