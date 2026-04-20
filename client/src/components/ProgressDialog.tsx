import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Loader2 } from "lucide-react";

interface ProgressDialogProps {
  open: boolean;
  title: string;
  description?: string;
  progress?: number; // 0-100, undefined for indeterminate
  total?: number;
  current?: number;
}

export function ProgressDialog({
  open,
  title,
  description,
  progress,
  total,
  current,
}: ProgressDialogProps) {
  const isIndeterminate = progress === undefined;
  const displayProgress = progress ?? 0;

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="dialog-progress"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isIndeterminate && <Loader2 className="h-5 w-5 animate-spin" />}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-4">
          <Progress value={displayProgress} className="w-full" />

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            {total !== undefined && current !== undefined ? (
              <>
                <span>
                  Processing {current} of {total}
                </span>
                <span>{Math.round(displayProgress)}%</span>
              </>
            ) : (
              <span className="mx-auto">
                {isIndeterminate
                  ? "Processing..."
                  : `${Math.round(displayProgress)}% complete`}
              </span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
