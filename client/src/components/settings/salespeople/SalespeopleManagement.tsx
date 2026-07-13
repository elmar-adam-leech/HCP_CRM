import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Users, RefreshCw, User, Calendar, Clock, ChevronLeft, ChevronRight, ArrowUp, ArrowDown } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Salesperson {
  userId: string;
  name: string;
  email: string;
  housecallProUserId: string | null;
  lastAssignmentAt: string | null;
  calendarColor: string | null;
  isSalesperson: boolean;
  workingDays: number[];
  workingHoursStart: string;
  workingHoursEnd: string;
  hasCustomSchedule: boolean;
  displayOrder: number | null;
  googleCalendarConnected?: boolean;
  googleCalendarEmail?: string;
}

interface SyncResult {
  synced: number;
  created: number;
  updated: number;
  errors: string[];
  hcpUsersFound?: number;
}

const PAGE_SIZE = 5;

export function SalespeopleManagement() {
  const { toast } = useToast();
  const [editingSchedule, setEditingSchedule] = useState<string | null>(null);
  const [scheduleData, setScheduleData] = useState<{
    workingDays: number[];
    workingHoursStart: string;
    workingHoursEnd: string;
  } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const { data: salespeople = [], isLoading: salespeopleLoading, refetch } = useQuery<Salesperson[]>({
    queryKey: ['/api/scheduling/salespeople'],
  });

  const sortedSalespeople = useMemo(() => {
    const activeSalespeople = salespeople.filter(p => p.isSalesperson);
    const inactiveSalespeople = salespeople.filter(p => !p.isSalesperson);

    activeSalespeople.sort((a, b) => {
      const aOrder = a.displayOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.displayOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });

    inactiveSalespeople.sort((a, b) => a.name.localeCompare(b.name));

    return [...activeSalespeople, ...inactiveSalespeople];
  }, [salespeople]);

  useEffect(() => {
    setCurrentPage(1);
  }, [salespeople.length]);

  const totalPages = Math.ceil(sortedSalespeople.length / PAGE_SIZE);
  const paginatedPeople = sortedSalespeople.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const syncUsersMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/scheduling/sync-users', {});
      return response.json() as Promise<SyncResult>;
    },
    onSuccess: (data) => {
      let description = `Found ${data.hcpUsersFound || 0} HCP users. `;
      if (data.synced > 0) {
        description += `Matched ${data.synced} to CRM (${data.created} created, ${data.updated} updated)`;
      } else {
        description += 'No matching email addresses found in CRM users.';
      }
      if (data.errors?.length) {
        description += ` Errors: ${data.errors.join(', ')}`;
      }
      toast({
        title: data.synced > 0 ? "Users Synced" : "Sync Complete",
        description,
        variant: data.errors?.length ? "destructive" : "default",
      });
      refetch();
    },
    onError: (error: any) => {
      toast({ title: "Sync Failed", description: error.message || "Failed to sync Housecall Pro users", variant: "destructive" });
    },
  });

  const toggleSalespersonMutation = useMutation({
    mutationFn: async ({ userId, isSalesperson }: { userId: string; isSalesperson: boolean }) => {
      const response = await apiRequest('PATCH', `/api/scheduling/salespeople/${userId}`, { isSalesperson });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Updated", description: "Salesperson status updated" });
      refetch();
    },
    onError: (error: any) => {
      toast({ title: "Update Failed", description: error.message || "Failed to update salesperson status", variant: "destructive" });
    },
  });

  const updateScheduleMutation = useMutation({
    mutationFn: async ({ userId, workingDays, workingHoursStart, workingHoursEnd }: {
      userId: string;
      workingDays: number[];
      workingHoursStart: string;
      workingHoursEnd: string;
    }) => {
      const response = await apiRequest('PATCH', `/api/scheduling/salespeople/${userId}`, {
        workingDays, workingHoursStart, workingHoursEnd, hasCustomSchedule: true
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Schedule Updated", description: "Working hours saved successfully" });
      setEditingSchedule(null);
      setScheduleData(null);
      refetch();
    },
    onError: (error: any) => {
      toast({ title: "Update Failed", description: error.message || "Failed to update schedule", variant: "destructive" });
    },
  });

  const revertScheduleMutation = useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      const response = await apiRequest('PATCH', `/api/scheduling/salespeople/${userId}`, { hasCustomSchedule: false });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Schedule Reverted", description: "Schedule will be managed by Housecall Pro sync" });
      setEditingSchedule(null);
      setScheduleData(null);
      refetch();
    },
    onError: (error: any) => {
      toast({ title: "Revert Failed", description: error.message || "Failed to revert schedule", variant: "destructive" });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (order: string[]) => {
      const response = await apiRequest('PATCH', '/api/scheduling/salespeople/order', { order });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/scheduling/salespeople'] });
    },
    onError: (error: any) => {
      toast({ title: "Reorder Failed", description: error.message || "Failed to update order", variant: "destructive" });
    },
  });

  const moveSalesperson = (userId: string, direction: 'up' | 'down') => {
    const activePeople = sortedSalespeople.filter(p => p.isSalesperson);
    const currentIndex = activePeople.findIndex(p => p.userId === userId);
    if (currentIndex === -1) return;
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= activePeople.length) return;

    const newOrder = [...activePeople];
    const [moved] = newOrder.splice(currentIndex, 1);
    newOrder.splice(newIndex, 0, moved);

    reorderMutation.mutate(newOrder.map(p => p.userId));
  };

  const startEditingSchedule = (person: Salesperson) => {
    setEditingSchedule(person.userId);
    setScheduleData({
      workingDays: person.workingDays || [1, 2, 3, 4, 5],
      workingHoursStart: person.workingHoursStart || "08:00",
      workingHoursEnd: person.workingHoursEnd || "17:00"
    });
  };

  const toggleDay = (day: number) => {
    if (!scheduleData) return;
    const newDays = scheduleData.workingDays.includes(day)
      ? scheduleData.workingDays.filter(d => d !== day)
      : [...scheduleData.workingDays, day].sort((a, b) => a - b);
    setScheduleData({ ...scheduleData, workingDays: newDays });
  };

  const activeSalespeopleCount = sortedSalespeople.filter(p => p.isSalesperson).length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Salespeople Management
              </CardTitle>
              <CardDescription>
                Manage which team members are available for appointment scheduling
              </CardDescription>
            </div>
            <Button
              onClick={() => syncUsersMutation.mutate()}
              disabled={syncUsersMutation.isPending}
              data-testid="button-sync-hcp-users"
              className="shrink-0"
            >
              {syncUsersMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Syncing...</>
              ) : (
                <><RefreshCw className="h-4 w-4 mr-2" />Sync from Housecall Pro</>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {salespeopleLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="animate-pulse h-16 bg-muted rounded-lg" />
              ))}
            </div>
          ) : sortedSalespeople.length === 0 ? (
            <div className="text-center py-8">
              <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Salespeople Configured</h3>
              <p className="text-muted-foreground mb-4">
                Click "Sync from Housecall Pro" to pull your team members and mark them as salespeople.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {paginatedPeople.map((person) => {
                  const activeIndex = sortedSalespeople.filter(p => p.isSalesperson).findIndex(p => p.userId === person.userId);
                  const isFirst = activeIndex === 0;
                  const isLast = activeIndex === activeSalespeopleCount - 1;

                  return (
                    <div
                      key={person.userId}
                      className="border rounded-lg"
                      data-testid={`salesperson-row-${person.userId}`}
                    >
                      <div className="p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            {person.isSalesperson && (
                              <div className="flex flex-col gap-0.5 shrink-0">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  disabled={isFirst || reorderMutation.isPending}
                                  onClick={() => moveSalesperson(person.userId, 'up')}
                                  data-testid={`button-move-up-${person.userId}`}
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  disabled={isLast || reorderMutation.isPending}
                                  onClick={() => moveSalesperson(person.userId, 'down')}
                                  data-testid={`button-move-down-${person.userId}`}
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            )}
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 shrink-0">
                              <User className="h-5 w-5 text-primary" />
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium truncate">{person.name}</div>
                              <div className="text-sm text-muted-foreground truncate">{person.email}</div>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEditingSchedule(person)}
                            data-testid={`button-edit-schedule-${person.userId}`}
                            className="shrink-0"
                          >
                            <Clock className="h-4 w-4 mr-1.5" />
                            Schedule
                          </Button>
                        </div>

                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            {person.housecallProUserId && (
                              <Badge variant="outline" className="gap-1">
                                <Calendar className="h-3 w-3" />
                                HCP Linked
                              </Badge>
                            )}
                            {person.googleCalendarConnected && (
                              <Badge variant="outline" className="gap-1">
                                <Calendar className="h-3 w-3" />
                                Google Calendar
                              </Badge>
                            )}
                            {person.hasCustomSchedule && (
                              <Badge variant="secondary" className="gap-1">
                                <Clock className="h-3 w-3" />
                                Custom Schedule
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Label htmlFor={`salesperson-${person.userId}`} className="text-sm text-muted-foreground cursor-pointer">
                              Salesperson
                            </Label>
                            <Switch
                              id={`salesperson-${person.userId}`}
                              checked={person.isSalesperson}
                              onCheckedChange={(checked) =>
                                toggleSalespersonMutation.mutate({ userId: person.userId, isSalesperson: checked })
                              }
                              disabled={toggleSalespersonMutation.isPending}
                              data-testid={`switch-salesperson-${person.userId}`}
                            />
                          </div>
                        </div>
                      </div>

                      {editingSchedule === person.userId && scheduleData && (
                        <div className="border-t p-4 bg-muted/30 space-y-4">
                          <div>
                            <Label className="text-sm font-medium mb-2 block">Working Days</Label>
                            <div className="flex gap-2 flex-wrap">
                              {dayNames.map((name, idx) => (
                                <Button
                                  key={idx}
                                  variant={scheduleData.workingDays.includes(idx) ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => toggleDay(idx)}
                                  data-testid={`button-day-${idx}`}
                                >
                                  {name}
                                </Button>
                              ))}
                            </div>
                          </div>

                          <div className="flex gap-4">
                            <div className="flex-1">
                              <Label className="text-sm font-medium mb-2 block">Start Time</Label>
                              <Input
                                type="time"
                                value={scheduleData.workingHoursStart}
                                onChange={(e) => setScheduleData({ ...scheduleData, workingHoursStart: e.target.value })}
                                data-testid="input-start-time"
                              />
                            </div>
                            <div className="flex-1">
                              <Label className="text-sm font-medium mb-2 block">End Time</Label>
                              <Input
                                type="time"
                                value={scheduleData.workingHoursEnd}
                                onChange={(e) => setScheduleData({ ...scheduleData, workingHoursEnd: e.target.value })}
                                data-testid="input-end-time"
                              />
                            </div>
                          </div>

                          <div className="flex justify-between gap-2">
                            <div>
                              {person.housecallProUserId && person.hasCustomSchedule && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => revertScheduleMutation.mutate({ userId: person.userId })}
                                  disabled={revertScheduleMutation.isPending}
                                  data-testid={`button-revert-schedule-${person.userId}`}
                                >
                                  {revertScheduleMutation.isPending ? 'Reverting...' : 'Revert to HCP Schedule'}
                                </Button>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { setEditingSchedule(null); setScheduleData(null); }}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => updateScheduleMutation.mutate({ userId: person.userId, ...scheduleData })}
                                disabled={updateScheduleMutation.isPending}
                              >
                                {updateScheduleMutation.isPending ? 'Saving...' : 'Save Schedule'}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4 border-t mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, sortedSalespeople.length)} of {sortedSalespeople.length}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => p - 1)}
                      disabled={currentPage === 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground px-1">
                      Page {currentPage} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => p + 1)}
                      disabled={currentPage === totalPages}
                      data-testid="button-next-page"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How It Works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="shrink-0">1</Badge>
            <p>Click "Sync from Housecall Pro" to pull your team members from HCP</p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="shrink-0">2</Badge>
            <p>Users are matched by email address between your CRM and Housecall Pro</p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="shrink-0">3</Badge>
            <p>Salespeople are automatically available for scheduling with 1-hour slots and 30-minute buffers</p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="shrink-0">4</Badge>
            <p>When appointments are booked, the system auto-assigns to the next available salesperson</p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="shrink-0">5</Badge>
            <p>Use the arrow buttons to reorder active salespeople — the order is saved automatically</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
