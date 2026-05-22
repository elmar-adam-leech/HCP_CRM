import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search, Users, Briefcase, Calendar, ArrowRight, Contact as ContactIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";
import type { Contact, Job, Estimate } from "@shared/schema";
import { formatEntityTitle } from "@/lib/utils";

interface PaginatedResponse<T> {
  data: T[];
  pagination: { total: number; hasMore: boolean; nextCursor: string | null };
}

type JobWithContact = Job & { contactName?: string };
type EstimateWithContact = Estimate & { contactName?: string };

interface GlobalSearchDropdownProps {
  onSearch?: (query: string) => void;
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2 animate-pulse">
      <div className="h-3 bg-muted rounded w-2/5" />
      <div className="h-3 bg-muted rounded w-1/4 ml-auto" />
    </div>
  );
}

export function GlobalSearchDropdown({ onSearch }: GlobalSearchDropdownProps) {
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [, setLocation] = useLocation();

  // 300ms debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(inputValue);
    }, 300);
    return () => clearTimeout(timer);
  }, [inputValue]);

  // Open dropdown when there's a valid debounced query
  useEffect(() => {
    if (debouncedQuery.length >= 2) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  }, [debouncedQuery]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const enabled = debouncedQuery.length >= 2;

  const { data: leadsData, isLoading: leadsLoading } = useQuery<PaginatedResponse<Contact>>({
    queryKey: ["/api/contacts/paginated", { search: debouncedQuery, limit: 5, type: "lead" }],
    queryFn: () =>
      fetch(
        `/api/contacts/paginated?search=${encodeURIComponent(debouncedQuery)}&limit=5&type=lead`,
        { credentials: "include" }
      ).then((r) => r.json()),
    enabled,
    staleTime: 10_000,
  });

  // Contacts section: non-lead types only (customers + inactive), so we don't
   // duplicate the Leads section above. Fetch both in one round trip per type
   // since the paginated endpoint takes a single `type` filter; cap to 5 each
   // and merge client-side, dedup'd by id.
  const { data: customersData, isLoading: customersLoading } = useQuery<PaginatedResponse<Contact>>({
    queryKey: ["/api/contacts/paginated", { search: debouncedQuery, limit: 5, type: "customer" }],
    queryFn: () =>
      fetch(
        `/api/contacts/paginated?search=${encodeURIComponent(debouncedQuery)}&limit=5&type=customer`,
        { credentials: "include" }
      ).then((r) => r.json()),
    enabled,
    staleTime: 10_000,
  });

  const { data: inactiveData, isLoading: inactiveLoading } = useQuery<PaginatedResponse<Contact>>({
    queryKey: ["/api/contacts/paginated", { search: debouncedQuery, limit: 5, type: "inactive" }],
    queryFn: () =>
      fetch(
        `/api/contacts/paginated?search=${encodeURIComponent(debouncedQuery)}&limit=5&type=inactive`,
        { credentials: "include" }
      ).then((r) => r.json()),
    enabled,
    staleTime: 10_000,
  });

  const { data: jobsData, isLoading: jobsLoading } = useQuery<PaginatedResponse<JobWithContact>>({
    queryKey: ["/api/jobs/paginated", { search: debouncedQuery, limit: 5 }],
    queryFn: () =>
      fetch(
        `/api/jobs/paginated?search=${encodeURIComponent(debouncedQuery)}&limit=5`,
        { credentials: "include" }
      ).then((r) => r.json()),
    enabled,
    staleTime: 10_000,
  });

  const { data: estimatesData, isLoading: estimatesLoading } = useQuery<PaginatedResponse<EstimateWithContact>>({
    queryKey: ["/api/estimates/paginated", { search: debouncedQuery, limit: 5 }],
    queryFn: () =>
      fetch(
        `/api/estimates/paginated?search=${encodeURIComponent(debouncedQuery)}&limit=5`,
        { credentials: "include" }
      ).then((r) => r.json()),
    enabled,
    staleTime: 10_000,
  });

  const leads = leadsData?.data ?? [];
  const jobs = jobsData?.data ?? [];
  const estimateItems = estimatesData?.data ?? [];
  const contactItems = (() => {
    const seen = new Set<string>();
    const merged: Contact[] = [];
    for (const c of [...(customersData?.data ?? []), ...(inactiveData?.data ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
    }
    return merged;
  })();

  const contactsLoading = customersLoading || inactiveLoading;
  const anyLoading = leadsLoading || jobsLoading || estimatesLoading || contactsLoading;
  const hasAnyResults = leads.length > 0 || jobs.length > 0 || estimateItems.length > 0 || contactItems.length > 0;
  const showEmpty = !anyLoading && !hasAnyResults && enabled;

  const navigate = (path: string) => {
    onSearch?.("");
    setLocation(path);
    setIsOpen(false);
    setInputValue("");
    setDebouncedQuery("");
  };

  const handleViewAll = (path: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const dest = debouncedQuery
      ? `${path}?search=${encodeURIComponent(debouncedQuery)}`
      : path;
    navigate(dest);
  };

  return (
    <div ref={containerRef} className="relative flex-1 max-w-xs sm:max-w-md">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none z-10" />
      <Input
        placeholder="Search leads, contacts, estimates, jobs..."
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={() => {
          if (debouncedQuery.length >= 2) setIsOpen(true);
        }}
        className="pl-8"
        data-testid="input-search"
      />

      {isOpen && (
        <Card className="absolute top-full left-0 right-0 mt-1 z-50 overflow-hidden shadow-md py-0">
          {showEmpty ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results for &ldquo;{debouncedQuery}&rdquo;
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto">

              {/* Leads section */}
              <div>
                <div className="flex items-center justify-between px-3 pt-3 pb-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <Users className="h-3 w-3" />
                    Leads
                  </div>
                  <button
                    onClick={handleViewAll("/leads")}
                    className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View all <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
                {leadsLoading ? (
                  <>
                    <SkeletonRow />
                    <SkeletonRow />
                  </>
                ) : leads.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No leads found</div>
                ) : (
                  leads.slice(0, 3).map((lead) => (
                    <button
                      key={lead.id}
                      onClick={() => navigate(`/leads?open=${lead.id}`)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{lead.name}</div>
                        {lead.emails?.[0] && (
                          <div className="text-xs text-muted-foreground truncate">{lead.emails[0]}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {lead.allLeadsArchived && (
                          <Badge variant="secondary" className="text-xs" data-testid={`badge-archived-${lead.id}`}>
                            Archived
                          </Badge>
                        )}
                        {lead.anyLeadAged && (
                          <Badge variant="secondary" className="text-xs" data-testid={`badge-aged-${lead.id}`}>
                            Aged
                          </Badge>
                        )}
                        <StatusBadge status={(lead.status ?? "new") as Parameters<typeof StatusBadge>[0]['status']} entityType="lead" />
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="border-t my-1" />

              {/* Contacts section (customers + inactive — leads live in the section above) */}
              <div>
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <ContactIcon className="h-3 w-3" />
                    Contacts
                  </div>
                  <button
                    onClick={handleViewAll("/contacts")}
                    className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View all <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
                {contactsLoading ? (
                  <>
                    <SkeletonRow />
                    <SkeletonRow />
                  </>
                ) : contactItems.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No contacts found</div>
                ) : (
                  contactItems.slice(0, 3).map((contact) => (
                    <button
                      key={contact.id}
                      onClick={() => navigate(`/contacts?open=${contact.id}`)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors"
                      data-testid={`row-contact-${contact.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{contact.name}</div>
                        {(contact.emails?.[0] || contact.phones?.[0]) && (
                          <div className="text-xs text-muted-foreground truncate">
                            {contact.emails?.[0] ?? contact.phones?.[0]}
                          </div>
                        )}
                      </div>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {contact.type === "inactive" ? "Inactive" : "Customer"}
                      </Badge>
                    </button>
                  ))
                )}
              </div>

              <div className="border-t my-1" />

              {/* Estimates section */}
              <div>
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <Calendar className="h-3 w-3" />
                    Estimates
                  </div>
                  <button
                    onClick={handleViewAll("/estimates")}
                    className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View all <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
                {estimatesLoading ? (
                  <>
                    <SkeletonRow />
                    <SkeletonRow />
                  </>
                ) : estimateItems.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No estimates found</div>
                ) : (
                  estimateItems.slice(0, 3).map((est) => (
                    <button
                      key={est.id}
                      onClick={() => navigate(`/estimates?open=${est.id}`)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{est.title}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {est.contactName}
                          {est.amount != null && (
                            <span className="ml-1">
                              &middot; ${Number(est.amount).toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <StatusBadge status={est.status} entityType="estimate" />
                    </button>
                  ))
                )}
              </div>
              
              <div className="border-t my-1" />
              
              {/* Jobs section */}
              <div>
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <Briefcase className="h-3 w-3" />
                    Jobs
                  </div>
                  <button
                    onClick={handleViewAll("/jobs")}
                    className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View all <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
                {jobsLoading ? (
                  <>
                    <SkeletonRow />
                    <SkeletonRow />
                  </>
                ) : jobs.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No jobs found</div>
                ) : (
                  jobs.slice(0, 3).map((job) => (
                    <button
                      key={job.id}
                      onClick={() => navigate(`/jobs?open=${job.id}`)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{formatEntityTitle('job', job.title)}</div>
                        {job.contactName && (
                          <div className="text-xs text-muted-foreground truncate">{job.contactName}</div>
                        )}
                      </div>
                      <StatusBadge status={job.status} entityType="job" />
                    </button>
                  ))
                )}
              </div>

              <div className="pb-2" />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
