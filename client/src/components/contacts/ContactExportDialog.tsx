import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Eye, Copy, Download } from "lucide-react";

type JsonToken = { text: string; type: "key" | "string" | "number" | "boolean" | "null" | "plain" };

function tokenizeJson(json: string): JsonToken[] {
  if (!json) return [];
  const tokens: JsonToken[] = [];
  const re = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(true|false)|(null)|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|([^":\w-]+|[{}[\],])/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(json)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: json.slice(lastIndex, match.index), type: "plain" });
    }
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], type: "key" });
      tokens.push({ text: ":", type: "plain" });
    } else if (match[2] !== undefined) {
      tokens.push({ text: match[2], type: "string" });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], type: "boolean" });
    } else if (match[4] !== undefined) {
      tokens.push({ text: match[4], type: "null" });
    } else if (match[5] !== undefined) {
      tokens.push({ text: match[5], type: "number" });
    } else if (match[6] !== undefined) {
      tokens.push({ text: match[6], type: "plain" });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < json.length) {
    tokens.push({ text: json.slice(lastIndex), type: "plain" });
  }
  return tokens;
}

const TOKEN_COLORS: Record<string, string> = {
  key: "hsl(var(--primary))",
  string: "hsl(142 71% 45%)",
  number: "hsl(221 83% 53%)",
  boolean: "hsl(25 95% 53%)",
  null: "hsl(0 84% 60%)",
};

interface ContactExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exportJson: string;
  exportContactId: string;
  exportLoading: boolean;
  onCopy: () => void;
  onDownload: () => void;
}

export function ContactExportDialog({
  open,
  onOpenChange,
  exportJson,
  exportContactId: _exportContactId,
  exportLoading,
  onCopy,
  onDownload,
}: ContactExportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Contact Data Export
          </DialogTitle>
          <DialogDescription>
            Full personal data bundle for this contact. You can copy or download the JSON.
          </DialogDescription>
        </DialogHeader>
        {exportLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0 max-h-[50vh]">
            <pre className="text-xs font-mono p-4 rounded-md bg-muted overflow-x-auto whitespace-pre-wrap break-all">
              {tokenizeJson(exportJson).map((token, i) =>
                token.type === "plain" ? token.text : (
                  <span key={i} style={{ color: TOKEN_COLORS[token.type] }}>{token.text}</span>
                )
              )}
            </pre>
          </ScrollArea>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onCopy} disabled={exportLoading || !exportJson}>
            <Copy className="h-4 w-4 mr-2" />
            Copy to Clipboard
          </Button>
          <Button size="sm" onClick={onDownload} disabled={exportLoading || !exportJson}>
            <Download className="h-4 w-4 mr-2" />
            Download JSON
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
