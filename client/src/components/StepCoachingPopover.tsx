import { useState, type ReactNode } from "react";
import { BookOpen, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type CoachingActionType = "call" | "text" | "email";

export interface StepCoachingPopoverProps {
  actionType: CoachingActionType;
  guidance?: string | null;
  callScript?: string | null;
  messageTemplate?: string | null;
  vars: Record<string, string>;
  testId: string;
  trigger?: ReactNode;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => vars[key] ?? "")
    .replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? "");
}

export function hasCoaching(p: Pick<StepCoachingPopoverProps, "actionType" | "guidance" | "callScript" | "messageTemplate">): boolean {
  const guidance = (p.guidance ?? "").trim();
  if (guidance.length > 0) return true;
  if (p.actionType === "call") {
    return (p.callScript ?? "").trim().length > 0;
  }
  return (p.messageTemplate ?? "").trim().length > 0;
}

export function StepCoachingPopover({
  actionType,
  guidance,
  callScript,
  messageTemplate,
  vars,
  testId,
  trigger,
}: StepCoachingPopoverProps) {
  const [copied, setCopied] = useState(false);

  const renderedGuidance = (guidance ?? "").trim() ? renderTemplate(guidance!, vars) : "";
  const scriptSource = actionType === "call" ? callScript : messageTemplate;
  const renderedScript = (scriptSource ?? "").trim() ? renderTemplate(scriptSource!, vars) : "";

  if (!renderedGuidance && !renderedScript) return null;

  const scriptLabel = actionType === "call"
    ? "Call talk track"
    : actionType === "text"
      ? "Suggested text"
      : "Suggested email";

  const handleCopy = async () => {
    if (!renderedScript) return;
    try {
      await navigator.clipboard.writeText(renderedScript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied (e.g. iframe / no user gesture). Fail
      // quietly — the user can still read and select the text manually.
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Show step script"
            data-testid={`${testId}-trigger`}
          >
            <BookOpen className="h-4 w-4" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[90vw] space-y-3"
        data-testid={`${testId}-content`}
      >
        {renderedGuidance && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Why this step
            </div>
            <p
              className="text-sm whitespace-pre-wrap"
              data-testid={`${testId}-guidance`}
            >
              {renderedGuidance}
            </p>
          </div>
        )}
        {renderedScript && (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {scriptLabel}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCopy}
                data-testid={`${testId}-copy`}
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <div
              className="text-sm whitespace-pre-wrap rounded border bg-muted/40 p-2"
              data-testid={`${testId}-script`}
            >
              {renderedScript}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
