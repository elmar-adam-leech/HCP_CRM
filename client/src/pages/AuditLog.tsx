import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { format } from "date-fns";
import { useCurrentUser } from "@/hooks/useCurrentUser";

type AuditLogEntry = {
  id: string;
  userId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  user: { name: string; email: string } | null;
};

type AuditLogResponse = {
  data: AuditLogEntry[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

const ACTION_COLORS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  login: "default",
  login_failed: "destructive",
  logout: "secondary",
  "mfa.enable": "default",
  "mfa.disable": "destructive",
  "mfa.verify_failed": "destructive",
  "mfa.recovery_code_used": "outline",
};

function getActionBadgeVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  return ACTION_COLORS[action] ?? "secondary";
}

export default function AuditLog() {
  const { data: currentUser } = useCurrentUser();
  const [page, setPage] = useState(1);
  const [filterAction, setFilterAction] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ action: "", dateFrom: "", dateTo: "" });

  const role = currentUser?.user?.role;
  const isAdmin = role === 'admin' || role === 'super_admin';

  const params = new URLSearchParams({
    page: page.toString(),
    limit: '50',
    ...(appliedFilters.action ? { action: appliedFilters.action } : {}),
    ...(appliedFilters.dateFrom ? { dateFrom: appliedFilters.dateFrom } : {}),
    ...(appliedFilters.dateTo ? { dateTo: appliedFilters.dateTo } : {}),
  });

  const { data, isLoading, error } = useQuery<AuditLogResponse>({
    queryKey: ['/api/audit-logs', page, appliedFilters],
    queryFn: async () => {
      const res = await fetch(`/api/audit-logs?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Failed to fetch audit logs: ${res.statusText}`);
      return res.json();
    },
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return (
      <PageLayout>
        <PageHeader title="Audit Log" description="Access denied" />
        <p className="text-muted-foreground">You need admin access to view the audit log.</p>
      </PageLayout>
    );
  }

  const handleApplyFilters = () => {
    setPage(1);
    setAppliedFilters({ action: filterAction, dateFrom: filterDateFrom, dateTo: filterDateTo });
  };

  const handleClearFilters = () => {
    setFilterAction("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setAppliedFilters({ action: "", dateFrom: "", dateTo: "" });
    setPage(1);
  };

  const hasFilters = appliedFilters.action || appliedFilters.dateFrom || appliedFilters.dateTo;

  return (
    <PageLayout>
      <PageHeader
        title="Audit Log"
        description="SOC 2 evidence store — track all user actions in your account"
      />

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1 min-w-[180px]">
              <Label htmlFor="filter-action">Action keyword</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="filter-action"
                  placeholder="e.g. login, mfa"
                  value={filterAction}
                  onChange={(e) => setFilterAction(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="filter-from">From date</Label>
              <Input
                id="filter-from"
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="filter-to">To date</Label>
              <Input
                id="filter-to"
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleApplyFilters}>Apply</Button>
              {hasFilters && (
                <Button variant="outline" onClick={handleClearFilters}>Clear</Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-10 bg-muted rounded animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <p className="text-destructive">Failed to load audit logs. You may not have admin access.</p>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>IP Address</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No audit log entries found.
                    </TableCell>
                  </TableRow>
                ) : data?.data.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(entry.createdAt), "MMM d, yyyy HH:mm:ss")}
                    </TableCell>
                    <TableCell>
                      {entry.user ? (
                        <div>
                          <p className="text-sm font-medium">{entry.user.name}</p>
                          <p className="text-xs text-muted-foreground">{entry.user.email}</p>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getActionBadgeVariant(entry.action)}>
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.entityType ? (
                        <span className="text-muted-foreground">
                          {entry.entityType}
                          {entry.entityId ? ` #${entry.entityId.slice(0, 8)}` : ''}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {entry.ipAddress ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {data && data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Showing page {data.pagination.page} of {data.pagination.totalPages} ({data.pagination.total} entries)
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">{page}</span>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page >= data.pagination.totalPages}
                  onClick={() => setPage(p => p + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </PageLayout>
  );
}
