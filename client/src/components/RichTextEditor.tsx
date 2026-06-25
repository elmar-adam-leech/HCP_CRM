import { useCallback, useEffect, useId, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Bold, Italic, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Strict allowlist — must mirror the server-side allowlist in
// server/utils/email-html.ts. The server re-sanitizes on send (the real
// security boundary); this keeps the stored/preview HTML clean too.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["b", "strong", "i", "em", "a", "br", "p"],
  ALLOWED_ATTR: ["href", "target", "rel"],
};

export function sanitizeRichText(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/**
 * Returns true when the HTML has no meaningful text content (only empty tags,
 * <br>, or whitespace). Used to drive Send button enable/disable + validation.
 */
export function richTextIsEmpty(html: string): boolean {
  if (!html) return true;
  const text = html
    .replace(/<br\s*\/?>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "");
  return text.length === 0;
}

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  dataTestId?: string;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  disabled,
  className,
  ariaLabel,
  dataTestId,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const paragraphSeparatorSet = useRef(false);
  const [isEmpty, setIsEmpty] = useState(richTextIsEmpty(value));
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const savedSelection = useRef<Range | null>(null);
  const linkInputId = useId();

  // Sync external value into the DOM only when it diverges from what the user
  // is currently looking at, to avoid clobbering the caret while typing.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    // Chrome wraps each Enter line in <div> by default; our allowlist strips
    // <div>, which would collapse line breaks. Force <p> separators (which the
    // allowlist permits) so paragraph breaks survive sanitization. Best-effort:
    // unsupported in some engines (Firefox uses <br>, also allowlisted).
    if (!paragraphSeparatorSet.current) {
      paragraphSeparatorSet.current = true;
      try {
        document.execCommand("defaultParagraphSeparator", false, "p");
      } catch {
        /* ignore — engine without execCommand support */
      }
    }
    const incoming = value ?? "";
    if (el.innerHTML !== incoming) {
      el.innerHTML = incoming;
    }
    setIsEmpty(richTextIsEmpty(incoming));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = sanitizeRichText(el.innerHTML);
    setIsEmpty(richTextIsEmpty(html));
    onChange(html);
  }, [onChange]);

  const exec = useCallback(
    (command: string, arg?: string) => {
      if (disabled) return;
      editorRef.current?.focus();
      document.execCommand(command, false, arg);
      emitChange();
    },
    [disabled, emitChange],
  );

  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedSelection.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const range = savedSelection.current;
    if (!range) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  const openLinkDialog = useCallback(() => {
    if (disabled) return;
    saveSelection();
    const sel = window.getSelection();
    setLinkText(sel ? sel.toString() : "");
    setLinkUrl("");
    setLinkOpen(true);
  }, [disabled, saveSelection]);

  const applyLink = useCallback(() => {
    const rawUrl = linkUrl.trim();
    if (!rawUrl) {
      setLinkOpen(false);
      return;
    }
    // Default bare URLs to https:// so execCommand produces a usable href.
    const href = /^(https?:|mailto:)/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

    editorRef.current?.focus();
    restoreSelection();

    const sel = window.getSelection();
    const hasSelectedText = sel && sel.toString().length > 0;

    if (!hasSelectedText) {
      // No selection: insert the (optional) link text, falling back to the URL.
      const label = (linkText.trim() || href)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const anchor = `<a href="${href.replace(/"/g, "&quot;")}">${label}</a>&nbsp;`;
      document.execCommand("insertHTML", false, anchor);
    } else {
      document.execCommand("createLink", false, href);
    }

    setLinkOpen(false);
    setLinkUrl("");
    setLinkText("");
    emitChange();
  }, [linkUrl, linkText, restoreSelection, emitChange]);

  return (
    <div
      className={cn(
        "rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0",
        disabled && "opacity-60",
        className,
      )}
      data-testid={dataTestId}
    >
      {/* Formatting toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1">
        <Toggle
          size="sm"
          aria-label="Bold"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onPressedChange={() => exec("bold")}
          data-testid="button-format-bold"
        >
          <Bold className="h-4 w-4" />
        </Toggle>
        <Toggle
          size="sm"
          aria-label="Italic"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onPressedChange={() => exec("italic")}
          data-testid="button-format-italic"
        >
          <Italic className="h-4 w-4" />
        </Toggle>
        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openLinkDialog}
              data-testid="button-format-link"
            >
              <LinkIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 space-y-2" align="start">
            <div className="grid gap-1.5">
              <Label htmlFor={`${linkInputId}-url`} className="text-xs">
                Link URL
              </Label>
              <Input
                id={`${linkInputId}-url`}
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyLink();
                  }
                }}
                data-testid="input-link-url"
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${linkInputId}-text`} className="text-xs">
                Text to display
              </Label>
              <Input
                id={`${linkInputId}-text`}
                placeholder="Optional — defaults to the URL"
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyLink();
                  }
                }}
                data-testid="input-link-text"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setLinkOpen(false)}
                data-testid="button-link-cancel"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={applyLink}
                data-testid="button-link-apply"
              >
                Add link
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Editable surface */}
      <div className="relative">
        {isEmpty && placeholder && (
          <div
            className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground"
            aria-hidden="true"
          >
            {placeholder}
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable={!disabled}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          spellCheck
          onInput={emitChange}
          onBlur={emitChange}
          className={cn(
            "prose prose-sm dark:prose-invert max-w-none min-h-[100px] max-h-[200px] overflow-y-auto px-3 py-2 text-sm leading-relaxed focus:outline-none",
            "[&_a]:text-primary [&_a]:underline",
          )}
          data-testid={dataTestId ? `${dataTestId}-input` : undefined}
          suppressContentEditableWarning
        />
      </div>
    </div>
  );
}
