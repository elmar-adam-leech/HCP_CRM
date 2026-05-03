import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, RefreshCw, Link2Off, Zap } from "lucide-react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";

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

function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return "Never";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function isAutoRow(row: MediaSpend): boolean {
  return row.source === "facebook_ads" || row.source === "google_ads";
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
    const byMonth = new Map<string, MediaSpend[]>();
    for (const row of data) {
      const key = String(row.month).slice(0, 7);
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

  const deletingRow = data?.find((r) => r.id === deletingId) ?? null;

  const { data: currentUser } = useCurrentUser();
  const canManageConnections = isStrictAdmin(currentUser?.user?.role);

  return (
    <div className="space-y-6">
      {canManageConnections && <ConnectionsCard />}

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Ad Spend</CardTitle>
            <CardDescription>
              Track how much you spend on each advertising platform per month. The
              ROI by Source report uses these numbers to compute cost per lead and
              return on ad spend. Rows synced from Facebook Ads or Google Ads are
              labeled and refresh automatically.
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
                No ad spend entered yet. Add a monthly entry per platform or
                connect Facebook Ads / Google Ads above to auto-import.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map((group) => (
                <div key={group.month} data-testid={`group-month-${group.month}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
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
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Last synced</TableHead>
                          <TableHead>Note</TableHead>
                          <TableHead className="w-32 text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.rows.map((row) => {
                          const auto = isAutoRow(row);
                          return (
                            <TableRow key={row.id} data-testid={`row-spend-${row.id}`}>
                              <TableCell className="font-medium">
                                {platformLabel(row.platform)}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {row.campaign ?? <span className="italic">All campaigns</span>}
                              </TableCell>
                              <TableCell>
                                {auto ? (
                                  <Badge variant="secondary" data-testid={`badge-source-${row.id}`}>
                                    <Zap className="mr-1 h-3 w-3" />
                                    Auto
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" data-testid={`badge-source-${row.id}`}>
                                    Manual
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatCurrency(row.amount)}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {auto ? formatRelativeTime(row.lastSyncedAt) : "—"}
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
                                    disabled={auto}
                                    data-testid={`button-edit-${row.id}`}
                                    aria-label={auto ? "Auto-synced rows are read-only" : "Edit"}
                                    title={auto ? "Auto-synced from the ad platform" : "Edit"}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => setDeletingId(row.id)}
                                    disabled={auto}
                                    data-testid={`button-delete-${row.id}`}
                                    aria-label={auto ? "Auto-synced rows are read-only" : "Delete"}
                                    title={auto ? "Auto-synced from the ad platform" : "Delete"}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
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
              onClick={() => deletingRow && !isAutoRow(deletingRow) && deleteMutation.mutate(deletingRow.id)}
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

// ---------------------- Connections (task #702) ----------------------

interface ConnectionStatus {
  source: "facebook_ads" | "google_ads";
  integrationName: string;
  isEnabled: boolean;
  hasCredentials: boolean;
  maskedCredentials: Record<string, string>;
  lastSyncedAt: string | null;
}
interface ConnectionsResponse {
  facebook: ConnectionStatus;
  google: ConnectionStatus;
}

function ConnectionsCard() {
  const { data, isLoading } = useQuery<ConnectionsResponse>({
    queryKey: ["/api/ad-spend/connections"],
  });
  const [openDialog, setOpenDialog] = useState<"facebook" | "google" | null>(null);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Auto-import ad spend</CardTitle>
          <CardDescription>
            Connect your Facebook Ads or Google Ads account to pull monthly
            spend automatically. Auto-synced numbers are clearly labeled, and
            any manual entry you've made for a given month is preserved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || !data ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <div className="space-y-3">
              <ConnectionRow
                label="Facebook Ads"
                status={data.facebook}
                onConnect={() => setOpenDialog("facebook")}
              />
              <ConnectionRow
                label="Google Ads"
                status={data.google}
                onConnect={() => setOpenDialog("google")}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <FacebookConnectDialog
        open={openDialog === "facebook"}
        onOpenChange={(open) => { if (!open) setOpenDialog(null); }}
      />
      <GoogleConnectDialog
        open={openDialog === "google"}
        onOpenChange={(open) => { if (!open) setOpenDialog(null); }}
      />
    </>
  );
}

function ConnectionRow({
  label, status, onConnect,
}: {
  label: string;
  status: ConnectionStatus;
  onConnect: () => void;
}) {
  const { toast } = useToast();
  const sourceParam = status.source === "facebook_ads" ? "facebook" : "google";

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/ad-spend/connections/${sourceParam}/sync`);
      return res.json();
    },
    onSuccess: (result: { upserted?: number; skippedManual?: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/media-spend"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ad-spend/connections"] });
      toast({
        title: `${label} sync complete`,
        description: `${result.upserted ?? 0} months updated, ${result.skippedManual ?? 0} preserved as manual.`,
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Sync failed";
      toast({ title: `${label} sync failed`, description: message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/ad-spend/connections/${sourceParam}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ad-spend/connections"] });
      toast({ title: `${label} disconnected` });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Disconnect failed";
      toast({ title: "Error", description: message, variant: "destructive" });
    },
  });

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`connection-${sourceParam}`}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {status.isEnabled ? (
            <Badge variant="secondary" data-testid={`badge-status-${sourceParam}`}>Connected</Badge>
          ) : (
            <Badge variant="outline" data-testid={`badge-status-${sourceParam}`}>Not connected</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {status.isEnabled
            ? `Last synced ${formatRelativeTime(status.lastSyncedAt)}`
            : "Connect to auto-import the trailing 6 months of spend."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {status.isEnabled ? (
          <>
            <Button
              variant="outline"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              data-testid={`button-sync-${sourceParam}`}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
              Sync now
            </Button>
            <Button
              variant="outline"
              onClick={onConnect}
              data-testid={`button-update-${sourceParam}`}
            >
              Update credentials
            </Button>
            <Button
              variant="ghost"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              data-testid={`button-disconnect-${sourceParam}`}
            >
              <Link2Off className="mr-2 h-4 w-4" />
              Disconnect
            </Button>
          </>
        ) : (
          <Button onClick={onConnect} data-testid={`button-connect-${sourceParam}`}>
            Connect {label}
          </Button>
        )}
      </div>
    </div>
  );
}

const facebookSchema = z.object({
  access_token: z.string().min(10, "Required"),
  ad_account_id: z.string().regex(/^act_\d+$/, "Looks like act_1234567890"),
});
type FacebookValues = z.infer<typeof facebookSchema>;

function FacebookConnectDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const form = useForm<FacebookValues>({
    resolver: zodResolver(facebookSchema),
    defaultValues: { access_token: "", ad_account_id: "" },
  });
  const mutation = useMutation({
    mutationFn: async (values: FacebookValues) => {
      const res = await apiRequest("POST", "/api/ad-spend/connections/facebook", values);
      return res.json();
    },
    onSuccess: (result: { initialSync?: { upserted?: number; error?: string } }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ad-spend/connections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/media-spend"] });
      const sync = result.initialSync;
      toast({
        title: "Facebook Ads connected",
        description: sync?.error
          ? `Saved, but initial sync failed: ${sync.error}`
          : `Imported ${sync?.upserted ?? 0} months of spend.`,
        variant: sync?.error ? "destructive" : undefined,
      });
      onOpenChange(false);
      form.reset();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Could not save credentials";
      toast({ title: "Error", description: message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Facebook Ads</DialogTitle>
          <DialogDescription>
            Paste a long-lived access token with <code>ads_read</code> scope and
            the ad account id you want to import from. Credentials are
            encrypted at rest and never shown again.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="access_token"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Access token</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="off" {...field} data-testid="input-fb-token" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ad_account_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ad account id</FormLabel>
                  <FormControl>
                    <Input placeholder="act_1234567890" {...field} data-testid="input-fb-account" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending} data-testid="button-save-fb">
                {mutation.isPending ? "Saving..." : "Save & connect"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const googleSchema = z.object({
  developer_token: z.string().min(5, "Required"),
  client_id: z.string().min(5, "Required"),
  client_secret: z.string().min(5, "Required"),
  refresh_token: z.string().min(5, "Required"),
  customer_id: z.string().regex(/^\d{6,}$/, "Numeric customer id, no dashes"),
  login_customer_id: z.string().regex(/^\d{6,}$/, "Numeric, no dashes").optional().or(z.literal("")),
});
type GoogleValues = z.infer<typeof googleSchema>;

function GoogleConnectDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const form = useForm<GoogleValues>({
    resolver: zodResolver(googleSchema),
    defaultValues: {
      developer_token: "", client_id: "", client_secret: "",
      refresh_token: "", customer_id: "", login_customer_id: "",
    },
  });
  const mutation = useMutation({
    mutationFn: async (values: GoogleValues) => {
      const payload = { ...values };
      if (!payload.login_customer_id) delete (payload as Partial<GoogleValues>).login_customer_id;
      const res = await apiRequest("POST", "/api/ad-spend/connections/google", payload);
      return res.json();
    },
    onSuccess: (result: { initialSync?: { upserted?: number; error?: string } }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ad-spend/connections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/media-spend"] });
      const sync = result.initialSync;
      toast({
        title: "Google Ads connected",
        description: sync?.error
          ? `Saved, but initial sync failed: ${sync.error}`
          : `Imported ${sync?.upserted ?? 0} months of spend.`,
        variant: sync?.error ? "destructive" : undefined,
      });
      onOpenChange(false);
      form.reset();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Could not save credentials";
      toast({ title: "Error", description: message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect Google Ads</DialogTitle>
          <DialogDescription>
            We use the Google Ads REST API. Paste your developer token, OAuth
            client credentials, refresh token, and the numeric customer id of
            the account to query. Credentials are encrypted at rest.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
          >
            {([
              ["developer_token", "Developer token", "password"],
              ["client_id", "OAuth client id", "text"],
              ["client_secret", "OAuth client secret", "password"],
              ["refresh_token", "Refresh token", "password"],
              ["customer_id", "Customer id", "text"],
              ["login_customer_id", "Login customer id (manager, optional)", "text"],
            ] as const).map(([name, label, type]) => (
              <FormField
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl>
                      <Input
                        type={type}
                        autoComplete="off"
                        {...field}
                        value={field.value ?? ""}
                        data-testid={`input-google-${name}`}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending} data-testid="button-save-google">
                {mutation.isPending ? "Saving..." : "Save & connect"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------- Manual entry dialog ----------------------

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
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
