import { useState } from "react";
import type { Contact } from "@shared/schema";
import { DetailsModal } from "@/components/DetailsModal";
import { ActivityList } from "@/components/ActivityList";
import { LeadSubmissionHistory } from "@/components/LeadSubmissionHistory";
import { BookingHistory } from "@/components/BookingHistory";
import { CommunicationActionButtons } from "@/components/CommunicationActionButtons";
import { Mail, Phone, MapPin, Globe, StickyNote, Plus, User, FileText, Calendar, MoreHorizontal, Edit, Settings, CalendarClock } from "lucide-react";
import { WorkflowEnrollmentBadges } from "./WorkflowEnrollmentBadges";
import { LeadSalesProcessTasks } from "./LeadSalesProcessTasks";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { format } from "date-fns";

interface LeadDetailsModalProps {
  isOpen: boolean;
  contact: Contact | undefined;
  onClose: () => void;
  onSendEmail?: () => void;
  onSchedule?: () => void;
  onEdit?: () => void;
  onEditStatus?: () => void;
  onSetFollowUp?: () => void;
  onTextSent?: () => void;
  onCallCompleted?: () => void;
}

interface Activity {
  id: string;
  type: string;
  content: string;
  userId?: string;
  userName?: string;
  createdAt: string;
}

function NotesSection({ contactId }: { contactId: string }) {
  const [isAdding, setIsAdding] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const { toast } = useToast();

  const { data: allActivities = [], isLoading } = useQuery<Activity[]>({
    queryKey: ['/api/activities', { contactId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.append('contactId', contactId);
      const response = await fetch(`/api/activities?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch activities');
      return response.json();
    },
  });

  const notes = allActivities.filter(a => a.type === 'note');

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const response = await apiRequest('POST', '/api/activities', {
        type: 'note',
        content,
        contactId,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      setNoteContent("");
      setIsAdding(false);
      toast({ title: "Note added", description: "Your note has been saved successfully." });
    },
    onError: () => {
      toast({ title: "Failed to add note", description: "Please try again.", variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!noteContent.trim()) {
      toast({ title: "Note content required", description: "Please enter some content for your note.", variant: "destructive" });
      return;
    }
    addNoteMutation.mutate(noteContent);
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Notes
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setIsAdding(true)}
          data-testid="button-add-note-inline"
        >
          <Plus className="w-4 h-4 mr-1" />
          Add Note
        </Button>
      </div>

      {isAdding && (
        <div className="mb-4 space-y-2">
          <Textarea
            placeholder="Enter your note here..."
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            rows={3}
            className="resize-none"
            data-testid="textarea-inline-note"
            autoFocus
          />
          <div className="flex gap-2 justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setIsAdding(false); setNoteContent(""); }}
              data-testid="button-cancel-inline-note"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={addNoteMutation.isPending}
              data-testid="button-save-inline-note"
            >
              {addNoteMutation.isPending ? "Saving..." : "Save Note"}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="h-14 bg-muted rounded-md" />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground" data-testid="text-no-notes">
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No notes yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map(note => (
            <div
              key={note.id}
              className="rounded-md border bg-muted/30 p-3 space-y-1.5"
              data-testid={`note-item-${note.id}`}
            >
              <p className="text-sm whitespace-pre-wrap break-all" data-testid={`note-content-${note.id}`}>
                {note.content}
              </p>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <User className="w-3 h-3" />
                {note.userName && <span>{note.userName} •</span>}
                <span data-testid={`note-timestamp-${note.id}`}>
                  {format(new Date(note.createdAt), "MMM d, yyyy 'at' h:mm a")}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LeadDetailsContent({ contact, onSendEmail, onSchedule, onEdit, onEditStatus, onSetFollowUp, onTextSent, onCallCompleted }: { contact: Contact; onSendEmail?: () => void; onSchedule?: () => void; onEdit?: () => void; onEditStatus?: () => void; onSetFollowUp?: () => void; onTextSent?: () => void; onCallCompleted?: () => void }) {
  const leadName = contact.name || '';
  const leadEmail = (contact.emails && contact.emails.length > 0) ? contact.emails[0] : '';
  const leadPhone = (contact.phones && contact.phones.length > 0) ? contact.phones[0] : '';
  const leadAddress = contact.address || '';

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Actions
        </h3>
        <div className="space-y-2">
          <CommunicationActionButtons
            recipientName={leadName}
            recipientEmail={leadEmail}
            recipientPhone={leadPhone}
            onSendEmail={() => onSendEmail?.()}
            leadId={contact.id}
            recipientAddress={leadAddress}
            contactId={contact.id}
            status={contact.status ?? undefined}
            source={contact.source ?? undefined}
            notes={contact.notes ?? undefined}
            followUpDate={contact.followUpDate ? new Date(contact.followUpDate).toLocaleDateString() : undefined}
            onTextSent={onTextSent}
            onCallCompleted={onCallCompleted}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSchedule?.()}
              data-testid="button-schedule-from-details"
            >
              <Calendar className="h-4 w-4 mr-1" />
              Schedule
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" data-testid="button-more-actions-details">
                  <MoreHorizontal className="h-4 w-4 mr-1" />
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => onEdit?.()} data-testid="menu-edit-from-details">
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Lead
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEditStatus?.()} data-testid="menu-edit-status-from-details">
                  <Settings className="h-4 w-4 mr-2" />
                  Edit Status
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSetFollowUp?.()} data-testid="menu-set-followup-from-details">
                  <CalendarClock className="h-4 w-4 mr-2" />
                  Set Follow Up
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </section>

      <div className="border-t" />

      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Submission History
        </h3>
        <LeadSubmissionHistory contactId={contact.id} />
      </section>

      <div className="border-t" />

      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Contact Information
        </h3>
        <div className="space-y-2.5 min-w-0">
          {contact.emails && contact.emails.length > 0 && (
            <div className="flex items-start gap-2.5 text-sm min-w-0">
              <Mail className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <span className="break-all min-w-0">{contact.emails[0]}</span>
            </div>
          )}
          {contact.phones && contact.phones.length > 0 && (
            <div className="flex items-start gap-2.5 text-sm">
              <Phone className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <span>{contact.phones[0]}</span>
            </div>
          )}
          {contact.address && (
            <div className="flex items-start gap-2.5 text-sm">
              <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <span>{contact.address}</span>
            </div>
          )}
          {contact.source && (
            <div className="flex items-start gap-2.5 text-sm">
              <Globe className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <span className="capitalize">{contact.source}</span>
            </div>
          )}
          {contact.notes && (
            <div className="flex items-start gap-2.5 text-sm min-w-0">
              <StickyNote className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <p className="whitespace-pre-wrap break-all text-muted-foreground min-w-0">{contact.notes}</p>
            </div>
          )}
        </div>
      </section>

      <div className="border-t" />

      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Active Workflows
        </h3>
        <WorkflowEnrollmentBadges contactId={contact.id} variant="full" />
      </section>

      <div className="border-t" />

      <NotesSection contactId={contact.id} />

      <div className="border-t" />

      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Booking History
        </h3>
        <BookingHistory contactId={contact.id} />
      </section>

      <div className="border-t" />

      <ActivityList leadId={contact.id} excludeNotes />
    </div>
  );
}

export function LeadDetailsModal({ isOpen, contact, onClose, onSendEmail, onSchedule, onEdit, onEditStatus, onSetFollowUp, onTextSent, onCallCompleted }: LeadDetailsModalProps) {
  const title = contact ? `${contact.name} — Lead Details` : 'Lead Details';
  const description = 'View detailed information and activity history for this lead.';

  return (
    <DetailsModal isOpen={isOpen} onClose={onClose} title={title} description={description}>
      {contact && (
        <LeadDetailsContent
          contact={contact}
          onSendEmail={onSendEmail}
          onSchedule={onSchedule}
          onEdit={onEdit}
          onEditStatus={onEditStatus}
          onSetFollowUp={onSetFollowUp}
          onTextSent={onTextSent}
          onCallCompleted={onCallCompleted}
        />
      )}
    </DetailsModal>
  );
}
