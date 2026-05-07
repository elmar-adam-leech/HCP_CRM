import { memo } from "react";
import { Calendar, Phone, Mail, AlertCircle, FileText, User, CalendarDays, MoreHorizontal, Edit, Clock, CalendarClock, CalendarX, Briefcase } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActivityList } from "@/components/ActivityList";
import { TextButton } from "@/components/TextButton";
import { CallButton } from "@/components/CallButton";
import { StepCoachingPopover, hasCoaching, renderTemplate } from "@/components/StepCoachingPopover";
import { useState } from "react";
import { isPast, isToday, isThisWeek } from "date-fns";

export interface FollowUpItem {
  id: string;
  type: 'lead' | 'estimate' | 'job';
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  address?: string;
  value?: string | number;
  notes?: string;
  followUpDate: string;
  followUpReason: string;
  source?: string;
  amount?: string | number;
  status?: string;
  customerId?: string;
  contactId?: string;
  // Optional coaching pulled from the next pending sales-process step task
  // for this lead/estimate. Hidden when empty. Task #729.
  stepActionType?: 'call' | 'text' | 'email';
  stepGuidance?: string | null;
  stepCallScript?: string | null;
  stepMessageTemplate?: string | null;
}

export function buildFollowUpVars(item: FollowUpItem): Record<string, string> {
  const [first, ...rest] = (item.name || "").split(/\s+/);
  return {
    first_name: first ?? "",
    last_name: rest.join(" "),
    full_name: item.name ?? "",
    email: item.email ?? "",
    phone: item.phone ?? "",
    lead_source: item.source ?? "",
  };
}

export function getFollowUpStatus(followUpDate: string) {
  const date = new Date(followUpDate);
  if (isPast(date) && !isToday(date)) {
    return { label: "Overdue", variant: "destructive" as const, icon: AlertCircle };
  } else if (isToday(date)) {
    return { label: "Today", variant: "default" as const, icon: Clock };
  } else if (isThisWeek(date)) {
    return { label: "This Week", variant: "secondary" as const, icon: Calendar };
  }
  return { label: "Upcoming", variant: "outline" as const, icon: Calendar };
}

interface FollowUpCardProps {
  item: FollowUpItem;
  onSetFollowUp: (item: FollowUpItem) => void;
  onContact: (item: FollowUpItem, method: 'phone' | 'email') => void;
  onSchedule: (item: FollowUpItem) => void;
  onEdit: (item: FollowUpItem) => void;
  onRemoveFollowUp: (item: FollowUpItem) => void;
}

export function FollowUpCard({
  item,
  onSetFollowUp,
  onContact,
  onSchedule,
  onEdit,
  onRemoveFollowUp,
}: FollowUpCardProps) {
  const status = getFollowUpStatus(item.followUpDate);
  const StatusIcon = status.icon;
  const TypeIcon = item.type === 'lead' ? User : item.type === 'estimate' ? FileText : Briefcase;
  const coachingActionType = item.stepActionType ?? 'call';
  const showCoachingPopover = hasCoaching({
    actionType: coachingActionType,
    guidance: item.stepGuidance,
    callScript: item.stepCallScript,
    messageTemplate: item.stepMessageTemplate,
  });
  const coachingVars = buildFollowUpVars(item);
  // When the rep clicks Call on a follow-up that has a sales-process call
  // script, reveal an inline talk-track panel so the script stays visible
  // beside the dialer. Hidden until call is initiated. Task #729.
  const [showCallTrack, setShowCallTrack] = useState(false);
  const renderedCallTrack = item.stepCallScript
    ? renderTemplate(item.stepCallScript, coachingVars)
    : "";
  const renderedMessageTemplate = item.stepMessageTemplate
    ? renderTemplate(item.stepMessageTemplate, coachingVars)
    : "";

  const typeLabel = item.type === 'lead' ? 'Lead' : item.type === 'estimate' ? 'Estimate' : 'Job';
  const editLabel = item.type === 'lead' ? 'Edit Lead' : item.type === 'estimate' ? 'Edit Estimate' : 'Edit Job';

  return (
    <Card key={`${item.type}-${item.id}`} className="hover-elevate" data-testid={`card-followup-${item.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <TypeIcon className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-lg" data-testid={`text-item-name-${item.id}`}>
              {item.name}
            </CardTitle>
            {(item.type === 'estimate' || item.type === 'job') && item.title && (
              <span className="text-sm text-muted-foreground">{item.title}</span>
            )}
            <Badge variant="secondary" className="text-xs">
              {typeLabel}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status.variant} className="flex items-center gap-1" data-testid={`badge-status-${item.id}`}>
              <StatusIcon className="h-3 w-3" />
              {status.label}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" data-testid={`button-menu-${item.id}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onEdit(item)} data-testid={`menu-edit-${item.id}`}>
                  <Edit className="h-4 w-4 mr-2" />
                  {editLabel}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSetFollowUp(item)} data-testid={`menu-followup-${item.id}`}>
                  <CalendarClock className="h-4 w-4 mr-2" />
                  Reschedule
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRemoveFollowUp(item)} data-testid={`menu-remove-followup-${item.id}`}>
                  <CalendarX className="h-4 w-4 mr-2" />
                  Remove Follow-Up
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-4 w-4" />
          <span data-testid={`text-followup-date-${item.id}`}>
            {item.followUpReason}
          </span>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        <div className="grid gap-2 text-sm">
          {item.email && (
            <div className="flex items-center gap-2" data-testid={`text-email-${item.id}`}>
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span>{item.email}</span>
            </div>
          )}
          {item.phone && (
            <div className="flex items-center gap-2" data-testid={`text-phone-${item.id}`}>
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span>{item.phone}</span>
            </div>
          )}
          {item.address && (
            <div className="text-muted-foreground" data-testid={`text-address-${item.id}`}>
              {item.address}
            </div>
          )}
          {item.value && (
            <div className="font-medium text-green-600" data-testid={`text-value-${item.id}`}>
              {item.type === 'lead' ? 'Estimated Value:' : 'Amount:'} ${item.value}
            </div>
          )}
          {item.status && item.type === 'estimate' && (
            <div className="text-sm">
              <Badge variant="outline">
                {item.status}
              </Badge>
            </div>
          )}
          {item.notes && (
            <div className="text-sm text-muted-foreground bg-muted/50 p-2 rounded" data-testid={`text-notes-${item.id}`}>
              {item.notes}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-2 flex-wrap">
          {showCoachingPopover && (
            <StepCoachingPopover
              actionType={coachingActionType}
              guidance={item.stepGuidance}
              callScript={item.stepCallScript}
              messageTemplate={item.stepMessageTemplate}
              vars={coachingVars}
              testId={`followup-script-${item.id}`}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSchedule(item)}
            data-testid={`button-schedule-${item.id}`}
          >
            <CalendarDays className="h-4 w-4 mr-2" />
            Schedule
          </Button>
          {item.phone && (
            <CallButton
              recipientName={item.name}
              recipientPhone={item.phone}
              leadId={item.type === 'lead' ? item.id : undefined}
              estimateId={item.type === 'estimate' ? item.id : undefined}
              variant="outline"
              size="sm"
              onClickBeforeCall={() => {
                if (coachingActionType === 'call' && renderedCallTrack) setShowCallTrack(true);
              }}
            />
          )}
          {item.email && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onContact(item, 'email')}
              data-testid={`button-email-${item.id}`}
            >
              <Mail className="h-4 w-4 mr-2" />
              Email
            </Button>
          )}
          {item.phone && (
            <TextButton
              recipientName={item.name}
              recipientPhone={item.phone}
              leadId={item.type === 'lead' ? item.id : (item.contactId ?? undefined)}
              estimateId={item.type === 'estimate' ? item.id : undefined}
              variant="outline"
              size="sm"
              recipientEmail={item.email}
              recipientAddress={item.address}
              contactId={item.contactId ?? (item.type === 'lead' ? item.id : undefined)}
              status={item.status}
              source={item.source}
              notes={item.notes}
              followUpDate={item.followUpDate}
              guidance={item.stepGuidance}
              initialMessage={
                coachingActionType === 'text' && renderedMessageTemplate
                  ? renderedMessageTemplate
                  : undefined
              }
            />
          )}
        </div>

        {coachingActionType === 'call' && showCallTrack && renderedCallTrack && (
          <div
            className="text-sm rounded-md border bg-muted/40 p-2 whitespace-pre-wrap"
            data-testid={`followup-call-track-${item.id}`}
          >
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
              Call talk track
            </div>
            {renderedCallTrack}
          </div>
        )}

        <div className="mt-4">
          <ActivityList
            leadId={item.type === 'lead' ? item.id : undefined}
            estimateId={item.type === 'estimate' ? item.id : undefined}
            jobId={item.type === 'job' ? item.id : undefined}
            limit={1}
            showAddButton={false}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default memo(FollowUpCard);
