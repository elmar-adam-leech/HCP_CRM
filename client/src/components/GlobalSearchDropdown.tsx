import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search, Users, Briefcase, Calendar, ArrowRight, Contact as ContactIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";
import type { Contact, Job, Estimate } from "@shared/schema";
import { formatEntityTitle, cn } from "@/lib/utils";

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

const HIGHLIGHT_CLASS = "bg-accent text-accent-foreground";

export function GlobalSearchDropdown({ onSearch }: GlobalSearchDropdownProps) {
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
  // duplicate the Leads section above. The paginated endpoint accepts a
  // comma-separated `type` list, so both types ride on a single request and
  // are filtered server-side (the wire payload stays at 5 rows, not 10).
  const { data: contactsData, isLoading: contactsLoading } = useQuery<PaginatedResponse<Contact>>({
    queryKey: ["/api/contacts/paginated", { search: debouncedQuery, limit: 5, type: "customer,inactive" }],
    queryFn: () =>
      fetch(
        `/api/contacts/paginated?search=${encodeURIComponent(debouncedQuery)}&limit=5&type=${encodeURIComponent("customer,inactive")}`,
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
  const contactItems = contactsData?.data ?? [];

  const anyLoading = leadsLoading || jobsLoading || estimatesLoading || contactsLoading;

  const visibleLeads = leads.slice(0, 3);
  const visibleContacts = contactItems.slice(0, 3);
  const visibleEstimates = estimateItems.slice(0, 3);
  const visibleJobs = jobs.slice(0, 3);

  const navigate = (path: string) => {
    onSearch?.("");
    setLocation(path);
    setIsOpen(false);
    setInputValue("");
    setDebouncedQuery("");
    setActiveIndex(-1);
  };

  // Flat list of activation handlers, in visual order.
  const flatActivators = useMemo<Array<() => void>>(() => {
    const list: Array<() => void> = [];
    for (const l of visibleLeads) list.push(() => navigate(`/leads?open=${l.id}`));
    for (const c of visibleContacts) list.push(() => navigate(`/contacts?open=${c.id}`));
    for (const e of visibleEstimates) list.push(() => navigate(`/estimates?open=${e.id}`));
    for (const j of visibleJobs) list.push(() => navigate(`/jobs?open=${j.id}`));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleLeads, visibleContacts, visibleEstimates, visibleJobs]);

  // Compute starting flat-index per section for highlight lookups.
  const leadsStart = 0;
  const contactsStart = leadsStart + visibleLeads.length;
  const estimatesStart = contactsStart + visibleContacts.length;
  const jobsStart = estimatesStart + visibleEstimates.length;

  // Resize the refs array to match the flat row count each render so stale
  // refs from a previous, longer result set never linger.
  rowRefs.current.length = flatActivators.length;

  // Reset highlight whenever the result set changes (new query, new data, or
  // the dropdown closes).
  useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedQuery, isOpen, flatActivators.length]);

  // Scroll the highlighted row into view when it changes.
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = rowRefs.current[activeIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (isOpen) {
        e.preventDefault();
        setIsOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (!isOpen || flatActivators.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((idx) => (idx + 1) % flatActivators.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((idx) =>
        idx <= 0 ? flatActivators.length - 1 : idx - 1
      );
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < flatActivators.length) {
        e.preventDefault();
        flatActivators[activeIndex]();
      }
    }
  };

  const hasAnyResults = leads.length > 0 || jobs.length > 0 || estimateItems.length > 0 || contactItems.length > 0;
  const showEmpty = !anyLoading && !hasAnyResults && enabled;

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
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={isOpen}
        aria-controls="global-search-listbox"
        aria-activedescendant={
          activeIndex >= 0 ? `global-search-row-${activeIndex}` : undefined
        }
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
            <div
              id="global-search-listbox"
              role="listbox"
              className="max-h-96 overflow-y-auto"
            >

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
                ) : visibleLeads.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No leads found</div>
                ) : (
                  visibleLeads.map((lead, i) => {
                    const flatIdx = leadsStart + i;
                    const isActive = activeIndex === flatIdx;
                    return (
                      <button
                        key={lead.id}
                        id={`global-search-row-${flatIdx}`}
                        ref={(el) => { rowRefs.current[flatIdx] = el; }}
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveIndex(flatIdx)}
                        onClick={() => navigate(`/leads?open=${lead.id}`)}
                        className={cn(
                          "w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors",
                          isActive && HIGHLIGHT_CLASS
                        )}
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
                    );
                  })
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
                ) : visibleContacts.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No contacts found</div>
                ) : (
                  visibleContacts.map((contact, i) => {
                    const flatIdx = contactsStart + i;
                    const isActive = activeIndex === flatIdx;
                    return (
                      <button
                        key={contact.id}
                        id={`global-search-row-${flatIdx}`}
                        ref={(el) => { rowRefs.current[flatIdx] = el; }}
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveIndex(flatIdx)}
                        onClick={() => navigate(`/contacts?open=${contact.id}`)}
                        className={cn(
                          "w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors",
                          isActive && HIGHLIGHT_CLASS
                        )}
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
                    );
                  })
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
                ) : visibleEstimates.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No estimates found</div>
                ) : (
                  visibleEstimates.map((est, i) => {
                    const flatIdx = estimatesStart + i;
                    const isActive = activeIndex === flatIdx;
                    return (
                      <button
                        key={est.id}
                        id={`global-search-row-${flatIdx}`}
                        ref={(el) => { rowRefs.current[flatIdx] = el; }}
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveIndex(flatIdx)}
                        onClick={() => navigate(`/estimates?open=${est.id}`)}
                        className={cn(
                          "w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors",
                          isActive && HIGHLIGHT_CLASS
                        )}
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
                    );
                  })
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
                ) : visibleJobs.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">No jobs found</div>
                ) : (
                  visibleJobs.map((job, i) => {
                    const flatIdx = jobsStart + i;
                    const isActive = activeIndex === flatIdx;
                    return (
                      <button
                        key={job.id}
                        id={`global-search-row-${flatIdx}`}
                        ref={(el) => { rowRefs.current[flatIdx] = el; }}
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveIndex(flatIdx)}
                        onClick={() => navigate(`/jobs?open=${job.id}`)}
                        className={cn(
                          "w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover-elevate active-elevate-2 transition-colors",
                          isActive && HIGHLIGHT_CLASS
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{formatEntityTitle('job', job.title)}</div>
                          {job.contactName && (
                            <div className="text-xs text-muted-foreground truncate">{job.contactName}</div>
                          )}
                        </div>
                        <StatusBadge status={job.status} entityType="job" />
                      </button>
                    );
                  })
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
