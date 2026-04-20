import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, MessageSquare, Mail } from "lucide-react";
import { UseFormReturn } from "react-hook-form";
import { z } from "zod";

export const templateFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  type: z.enum(["text", "email"], { required_error: "Type is required" }),
  subject: z.string().optional(),
  content: z.string().min(1, "Content is required"),
});

export type TemplateFormData = z.infer<typeof templateFormSchema>;

const TEMPLATE_VARIABLES = [
  {
    group: "Contact",
    vars: [
      { key: "contact.name", label: "Name" },
      { key: "contact.emails", label: "Email" },
      { key: "contact.phones", label: "Phone" },
      { key: "contact.address", label: "Address" },
      { key: "contact.id", label: "Contact ID" },
    ],
  },
  {
    group: "Lead",
    vars: [
      { key: "name", label: "Lead Name" },
      { key: "status", label: "Status" },
      { key: "source", label: "Source" },
      { key: "followUpDate", label: "Follow-up Date" },
      { key: "notes", label: "Notes" },
    ],
  },
  {
    group: "Job",
    vars: [
      { key: "title", label: "Job Title" },
      { key: "status", label: "Status" },
      { key: "scheduledDate", label: "Scheduled Date" },
      { key: "value", label: "Value" },
    ],
  },
  {
    group: "Estimate",
    vars: [
      { key: "title", label: "Estimate Title" },
      { key: "amount", label: "Amount" },
      { key: "status", label: "Status" },
      { key: "validUntil", label: "Valid Until" },
    ],
  },
];

interface TemplateFormModalProps {
  isOpen: boolean;
  mode: "create" | "edit";
  form: UseFormReturn<TemplateFormData>;
  onSubmit: (data: TemplateFormData) => void;
  onClose: () => void;
  isSubmitting: boolean;
}

export function TemplateFormModal({
  isOpen,
  mode,
  form,
  onSubmit,
  onClose,
  isSubmitting,
}: TemplateFormModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const watchedType = form.watch("type");

  const insertVariable = (key: string) => {
    const textarea = textareaRef.current;
    const snippet = `{{${key}}}`;
    if (!textarea) {
      form.setValue("content", form.getValues("content") + snippet, { shouldDirty: true });
      return;
    }
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const current = form.getValues("content");
    form.setValue("content", current.slice(0, start) + snippet + current.slice(end), { shouldDirty: true, shouldValidate: true });
    requestAnimationFrame(() => {
      const newPos = start + snippet.length;
      textarea.selectionStart = newPos;
      textarea.selectionEnd = newPos;
      textarea.focus();
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]" data-testid="modal-template">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Create Template" : "Edit Template"}
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter template title..." {...field} data-testid="input-template-title" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-template-type">
                        <SelectValue placeholder="Select template type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="text" data-testid="select-type-text">
                        <div className="flex items-center gap-2">
                          <MessageSquare className="h-4 w-4" />
                          Text Message
                        </div>
                      </SelectItem>
                      <SelectItem value="email" data-testid="select-type-email">
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4" />
                          Email
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {watchedType === "email" && (
              <FormField
                control={form.control}
                name="subject"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Subject</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Email subject line..."
                        {...field}
                        value={field.value ?? ""}
                        data-testid="input-template-subject"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between gap-2">
                    <FormLabel>Content</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 text-xs"
                          data-testid="button-insert-variable"
                        >
                          <Plus className="h-3 w-3" />
                          Insert Variable
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-64 p-2">
                        <p className="text-xs font-medium text-muted-foreground px-1 pb-2">
                          Click a variable to insert it at the cursor
                        </p>
                        <ScrollArea className="max-h-72">
                          <div className="space-y-3">
                            {TEMPLATE_VARIABLES.map((group) => (
                              <div key={group.group}>
                                <p className="text-xs font-semibold text-foreground px-1 pb-1">{group.group}</p>
                                <div className="space-y-0.5">
                                  {group.vars.map((v) => (
                                    <button
                                      key={v.key}
                                      type="button"
                                      onClick={() => insertVariable(v.key)}
                                      className="w-full flex items-center justify-between rounded px-2 py-1.5 text-sm hover-elevate"
                                      data-testid={`variable-${v.key}`}
                                    >
                                      <span>{v.label}</span>
                                      <code className="text-xs text-muted-foreground font-mono">{`{{${v.key}}}`}</code>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <FormControl>
                    <Textarea
                      placeholder="Enter template content..."
                      rows={6}
                      {...field}
                      ref={(el) => {
                        field.ref(el);
                        textareaRef.current = el;
                      }}
                      data-testid="textarea-template-content"
                    />
                  </FormControl>
                  <FormDescription>
                    Variables are replaced with real values when sent. Format: <code className="text-xs font-mono">{`{{variableName}}`}</code>
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={isSubmitting} data-testid="button-save-template">
                {mode === "create" ? "Create Template" : "Update Template"}
              </Button>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
