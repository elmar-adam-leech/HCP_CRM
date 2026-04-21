import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardSkeleton } from "@/components/CardSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { Mail, Phone, Users, Briefcase, FileText, BookUser, Check, ShieldOff, Clock } from "lucide-react";
import { getInitials } from "@/lib/utils";
import type { Contact } from "@shared/schema";

type ContactWithCounts = Contact & {
  leadCount: number;
  estimateCount: number;
  jobCount: number;
  allLeadsArchived?: boolean;
  anyLeadAged?: boolean;
};

interface ContactGridProps {
  contacts: ContactWithCounts[];
  isLoading: boolean;
  isError: boolean;
  pageSize: number;
  mergeMode: boolean;
  retentionView: boolean;
  isAdmin: boolean;
  searchQuery: string;
  isSelectedForMerge: (id: string) => boolean;
  onCardClick: (contact: ContactWithCounts) => void;
  onPurge: (contact: ContactWithCounts) => void;
}

export function ContactGrid({
  contacts,
  isLoading,
  isError,
  pageSize,
  mergeMode,
  retentionView,
  isAdmin,
  searchQuery,
  isSelectedForMerge,
  onCardClick,
  onPurge,
}: ContactGridProps) {
  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: pageSize }, (_, i) => <CardSkeleton key={i} />)}
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={BookUser}
        title="Could not load contacts"
        description="There was a problem connecting to the server. Please try refreshing the page."
      />
    );
  }

  if (contacts.length === 0) {
    return (
      <EmptyState
        icon={retentionView ? Clock : BookUser}
        title={retentionView ? "No contacts flagged for retention review" : "No contacts found"}
        description={
          retentionView
            ? "All contacts are within the configured retention period"
            : searchQuery
            ? "Try a different search term"
            : "Contacts are created automatically when leads, estimates, or jobs are added"
        }
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {contacts.map((contact) => {
        const selected = isSelectedForMerge(contact.id);
        return (
          <Card
            key={contact.id}
            className={`hover-elevate cursor-pointer ${mergeMode && selected ? "ring-2 ring-primary" : ""}`}
            onClick={() => onCardClick(contact)}
            data-testid={`card-contact-${contact.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="relative">
                  <Avatar className="h-10 w-10 shrink-0">
                    <AvatarFallback>{getInitials(contact.name)}</AvatarFallback>
                  </Avatar>
                  {mergeMode && (
                    <div
                      className={`absolute -top-1 -right-1 h-5 w-5 rounded-full border-2 flex items-center justify-center ${
                        selected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "bg-background border-muted-foreground/40"
                      }`}
                    >
                      {selected && <Check className="h-3 w-3" />}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{contact.name}</div>
                  {contact.emails?.[0] && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5 truncate">
                      <Mail className="h-3 w-3 shrink-0" />
                      <span className="truncate">{contact.emails[0]}</span>
                    </div>
                  )}
                  {contact.phones?.[0] && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                      <Phone className="h-3 w-3 shrink-0" />
                      <span>{contact.phones[0]}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                {contact.status === 'disqualified' && (
                  <Badge variant="destructive" className="text-xs" data-testid={`badge-disqualified-${contact.id}`}>
                    Disqualified
                  </Badge>
                )}
                {contact.allLeadsArchived && (
                  <Badge variant="secondary" className="text-xs" data-testid={`badge-archived-${contact.id}`}>
                    Archived
                  </Badge>
                )}
                {contact.anyLeadAged && (
                  <Badge variant="secondary" className="text-xs" data-testid={`badge-aged-${contact.id}`}>
                    Aged
                  </Badge>
                )}
                {contact.leadCount > 0 && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Users className="h-3 w-3" />
                    {contact.leadCount} lead{contact.leadCount !== 1 ? "s" : ""}
                  </Badge>
                )}
                {contact.estimateCount > 0 && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <FileText className="h-3 w-3" />
                    {contact.estimateCount} estimate{contact.estimateCount !== 1 ? "s" : ""}
                  </Badge>
                )}
                {contact.jobCount > 0 && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Briefcase className="h-3 w-3" />
                    {contact.jobCount} job{contact.jobCount !== 1 ? "s" : ""}
                  </Badge>
                )}
                {retentionView && (
                  <>
                    <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-300">
                      <Clock className="h-3 w-3" />
                      Flagged
                    </Badge>
                    {isAdmin && !contact.anonymized && (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="ml-auto"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPurge(contact);
                        }}
                        data-testid={`button-purge-${contact.id}`}
                      >
                        <ShieldOff className="h-3 w-3 mr-1" />
                        Purge
                      </Button>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
