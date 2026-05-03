import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  LEAD_PLATFORMS, platformKey, platformFromKey, type LeadPlatform,
} from "@shared/lib/lead-platform";
import type { MediaSpend } from "@shared/schema";

const platformKeyValues = LEAD_PLATFORMS.map((p) => platformKey(p as LeadPlatform)) as [string, ...string[]];

const formSchema = z.object({
  platform: z.enum(platformKeyValues),
  month: z.string().regex(/^\d{4}-\d{2}$/, "Pick a month"),
  amount: z.coerce.number().min(0, "Amount must be 0 or more"),
  // Empty campaign means platform-level spend.
  campaign: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

type FormValues = z.infer<typeof formSchema>;

function monthLabel(monthIso: string): string {
  // monthIso like "2026-04-01" — show "April 2026"
  const [y, m] = monthIso.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function formatCurrency(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function platformLabel(key: string): string {
  return platformFromKey(key) ?? key;
}

function currentMonthInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function AdSpendTab() {
  const { toast } = useToast();
  const [editing, setEditing] = useState<MediaSpend | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<MediaSpend[]>({
    queryKey: ["/api/media-spend"],
  });

  const grouped = useMemo(() => {
    if (!data) return [];
    // Group by month (desc), and within a month sort by platform.
    const byMonth = new Map<string, MediaSpend[]>();
    for (const row of data) {
      const key = String(row.month).slice(0, 7); // YYYY-MM
      const list = byMonth.get(key) ?? [];
      list.push(row);
      byMonth.set(key, list);
    }
    return Array.from(byMonth.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([month, rows]) => ({
        month,
        rows: rows.sort((a, b) => a.platform.localeCompare(b.platform)),
        total: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      }));
  }, [data]);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/media-spend/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/media-spend"] });
      toast({ title: "Spend entry deleted" });
      setDeletingId(null);
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to delete spend entry";
      toast({ title: "Error", description: message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Ad Spend</CardTitle>
            <CardDescription>
              Track how much you spend on each advertising platform per month. The
              ROI by Source report uses these numbers to compute cost per lead and
              return on ad spend.
            </CardDescription>
          </div>
          <Button onClick={() => setCreating(true)} data-testid="button-add-spend">
            <Plus className="mr-2 h-4 w-4" />
            Add spend
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : grouped.length === 0 ? (
            <div className="rounded-md border p-6 text-center" data-testid="empty-ad-spend">
              <p className="text-sm text-muted-foreground">
                No ad spend entered yet. Add a monthly entry per platform to see
                ROI on the ROI by Source report.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map((group) => (
                <div key={group.month} data-testid={`group-month-${group.month}`}>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{monthLabel(`${group.month}-01`)}</h3>
                    <span className="text-xs text-muted-foreground">
                      Total {formatCurrency(group.total)}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Platform</TableHead>
                          <TableHead>Campaign</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Note</TableHead>
                          <TableHead className="w-32 text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.rows.map((row) => (
                          <TableRow key={row.id} data-testid={`row-spend-${row.id}`}>
                            <TableCell className="font-medium">
                              {platformLabel(row.platform)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {row.campaign ?? <span className="italic">All campaigns</span>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(row.amount)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {row.note ?? ""}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => setEditing(row)}
                                  data-testid={`button-edit-${row.id}`}
                                  aria-label="Edit"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => setDeletingId(row.id)}
                                  data-testid={`button-delete-${row.id}`}
                                  aria-label="Delete"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <SpendDialog
        open={creating}
        onOpenChange={setCreating}
        existing={null}
      />
      <SpendDialog
        open={editing !== null}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        existing={editing}
      />

      <AlertDialog open={deletingId !== null} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete spend entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the spend entry from the ROI by Source report.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingId && deleteMutation.mutate(deletingId)}
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SpendDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: MediaSpend | null;
}) {
  const { toast } = useToast();
  const isEdit = existing !== null;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: {
      platform: (existing?.platform ?? "facebook") as FormValues["platform"],
      month: existing
        ? String(existing.month).slice(0, 7)
        : currentMonthInput(),
      amount: existing ? Number(existing.amount) : 0,
      campaign: existing?.campaign ?? "",
      note: existing?.note ?? "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const body = {
        platform: values.platform,
        month: `${values.month}-01`,
        amount: String(values.amount),
        campaign: values.campaign?.trim() ? values.campaign.trim() : null,
        note: values.note?.trim() ? values.note.trim() : null,
      };
      if (isEdit && existing) {
        const res = await apiRequest("PATCH", `/api/media-spend/${existing.id}`, body);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/media-spend", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/media-spend"] });
      toast({ title: isEdit ? "Spend entry updated" : "Spend entry added" });
      onOpenChange(false);
      form.reset();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Could not save spend entry";
      toast({ title: "Error", description: message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit ad spend" : "Add ad spend"}</DialogTitle>
          <DialogDescription>
            One entry per platform + campaign per month. Leave the campaign
            blank for platform-level (Unattributed) spend.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="platform"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Platform</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isEdit}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-platform">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {LEAD_PLATFORMS.map((p) => (
                        <SelectItem
                          key={platformKey(p as LeadPlatform)}
                          value={platformKey(p as LeadPlatform)}
                        >
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="month"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Month</FormLabel>
                  <FormControl>
                    <Input
                      type="month"
                      value={field.value}
                      onChange={field.onChange}
                      disabled={isEdit}
                      data-testid="input-month"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="campaign"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Campaign (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Spring Promo — match utm_campaign"
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      data-testid="input-campaign"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (USD)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                      data-testid="input-amount"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      data-testid="input-note"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-spend"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={mutation.isPending}
                data-testid="button-save-spend"
              >
                {mutation.isPending ? "Saving..." : isEdit ? "Save changes" : "Add"}
              </Button>
            </DialogFooter>
            {(() => {
              const errors = form.formState.errors;
              const hasErr = Object.keys(errors).length > 0;
              if (!hasErr) return null;
              return null;
            })()}
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
