import { useState, useEffect, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import { LeadCard } from "@/components/LeadCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Contact } from "@shared/schema";

interface KanbanColumn {
  id: string;
  title: string;
  status: "new" | "contacted" | "scheduled" | "disqualified" | "lost";
  leads: Contact[];
}

type UnreadCountsMap = Record<string, { text: number; email: number }>;

interface LeadKanbanBoardProps {
  leads: Contact[];
  onStatusChange: (leadId: string, newStatus: string) => void;
  onViewDetails: (leadId: string) => void;
  onEdit: (leadId: string) => void;
  onSchedule: (leadId: string) => void;
  onSendEmail?: (lead: Contact) => void;
  onEditStatus?: (leadId: string) => void;
  onSetFollowUp?: (lead: Contact) => void;
  onDelete?: (leadId: string) => void;
  onTextSent?: (leadId: string) => void;
  onCallCompleted?: (leadId: string) => void;
  unreadCounts?: UnreadCountsMap;
}

function SortableLeadCard({
  lead,
  onViewDetails,
  onEdit,
  onSchedule,
  onSendEmail,
  onEditStatus,
  onSetFollowUp,
  onDelete,
  onTextSent,
  onCallCompleted,
  hasUnreadText,
  hasUnreadEmail,
}: {
  lead: Contact;
  onViewDetails: (leadId: string) => void;
  onEdit: (leadId: string) => void;
  onSchedule: (leadId: string) => void;
  onSendEmail?: (lead: Contact) => void;
  onEditStatus?: (leadId: string) => void;
  onSetFollowUp?: (lead: Contact) => void;
  onDelete?: (leadId: string) => void;
  onTextSent?: (leadId: string) => void;
  onCallCompleted?: (leadId: string) => void;
  hasUnreadText?: boolean;
  hasUnreadEmail?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: lead.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="mb-3"
    >
      <LeadCard
        lead={lead}
        onViewDetails={onViewDetails}
        onEdit={onEdit}
        onSchedule={onSchedule}
        onSendEmail={onSendEmail}
        onEditStatus={onEditStatus}
        onSetFollowUp={onSetFollowUp}
        onDelete={onDelete}
        selectable={false}
        onTextSent={onTextSent ? () => onTextSent(lead.id) : undefined}
        onCallCompleted={onCallCompleted ? () => onCallCompleted(lead.id) : undefined}
        hasUnreadText={hasUnreadText}
        hasUnreadEmail={hasUnreadEmail}
      />
    </div>
  );
}

function KanbanColumnComponent({
  column,
  onViewDetails,
  onEdit,
  onSchedule,
  onSendEmail,
  onEditStatus,
  onSetFollowUp,
  onDelete,
  onTextSent,
  onCallCompleted,
  unreadCounts,
}: {
  column: KanbanColumn;
  onViewDetails: (leadId: string) => void;
  onEdit: (leadId: string) => void;
  onSchedule: (leadId: string) => void;
  onSendEmail?: (lead: Contact) => void;
  onEditStatus?: (leadId: string) => void;
  onSetFollowUp?: (lead: Contact) => void;
  onDelete?: (leadId: string) => void;
  onTextSent?: (leadId: string) => void;
  onCallCompleted?: (leadId: string) => void;
  unreadCounts?: UnreadCountsMap;
}) {
  const { setNodeRef: setDropRef } = useDroppable({ id: column.id });

  return (
    <Card className="flex flex-col h-[calc(100vh-20rem)] min-w-[320px]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{column.title}</CardTitle>
          <Badge variant="secondary">{column.leads.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-full px-4 pb-4">
          <div ref={setDropRef} className="min-h-full">
            <SortableContext
              items={column.leads.map((lead) => lead.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-3">
                {column.leads.map((lead) => (
                  <SortableLeadCard
                    key={lead.id}
                    lead={lead}
                    onViewDetails={onViewDetails}
                    onEdit={onEdit}
                    onSchedule={onSchedule}
                    onSendEmail={onSendEmail}
                    onEditStatus={onEditStatus}
                    onSetFollowUp={onSetFollowUp}
                    onDelete={onDelete}
                    onTextSent={onTextSent}
                    onCallCompleted={onCallCompleted}
                    hasUnreadText={(unreadCounts?.[lead.id]?.text ?? 0) > 0}
                    hasUnreadEmail={(unreadCounts?.[lead.id]?.email ?? 0) > 0}
                  />
                ))}
              </div>
            </SortableContext>
            {column.leads.length === 0 && (
              <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
                No leads
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

const COLUMN_DEFINITIONS: Array<{ id: string; title: string; status: KanbanColumn["status"] }> = [
  { id: "new", title: "New Leads", status: "new" },
  { id: "contacted", title: "Contacted", status: "contacted" },
  { id: "scheduled", title: "Scheduled", status: "scheduled" },
  { id: "disqualified", title: "Disqualified", status: "disqualified" },
  { id: "lost", title: "Lost", status: "lost" },
];

function createEmptyColumns(): KanbanColumn[] {
  return COLUMN_DEFINITIONS.map((def) => ({ ...def, leads: [] }));
}

export function LeadKanbanBoard({
  leads,
  onStatusChange,
  onViewDetails,
  onEdit,
  onSchedule,
  onSendEmail,
  onEditStatus,
  onSetFollowUp,
  onDelete,
  onTextSent,
  onCallCompleted,
  unreadCounts,
}: LeadKanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [columns, setColumns] = useState<KanbanColumn[]>(createEmptyColumns);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const organizeLeadsByStatus = useCallback(() => {
    const organized = createEmptyColumns();

    leads.forEach((lead) => {
      const column = organized.find((col) => col.status === lead.status);
      if (column) {
        column.leads.push(lead);
      }
    });

    setColumns(organized);
  }, [leads]);

  useEffect(() => {
    organizeLeadsByStatus();
  }, [organizeLeadsByStatus]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  // Two-phase drag approach:
  // handleDragOver speculatively moves the lead between columns for visual
  // feedback while dragging. handleDragEnd commits the status change via
  // onStatusChange if the lead landed in a different column, then resets
  // columns from the source-of-truth `leads` prop. If the drop target is
  // invalid (no `over`), the speculative move is reverted.
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeLeadId = active.id as string;
    const overColumnId = over.id as string;

    const activeColumn = columns.find((col) =>
      col.leads.some((lead) => lead.id === activeLeadId)
    );
    const overColumn = columns.find(
      (col) => col.id === overColumnId || col.leads.some((lead) => lead.id === overColumnId)
    );

    if (!activeColumn || !overColumn) return;
    if (activeColumn.id === overColumn.id) return;

    const activeLead = activeColumn.leads.find((lead) => lead.id === activeLeadId);
    if (!activeLead) return;

    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === activeColumn.id) {
          return {
            ...col,
            leads: col.leads.filter((lead) => lead.id !== activeLeadId),
          };
        }
        if (col.id === overColumn.id) {
          return {
            ...col,
            leads: [...col.leads, activeLead],
          };
        }
        return col;
      })
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) {
      organizeLeadsByStatus();
      return;
    }

    const activeLeadId = active.id as string;
    const newColumn = columns.find(
      (col) => col.id === over.id || col.leads.some((lead) => lead.id === over.id)
    );

    if (newColumn) {
      const lead = leads.find((l) => l.id === activeLeadId);
      if (lead && lead.status !== newColumn.status) {
        onStatusChange(activeLeadId, newColumn.status);
      }
    }

    organizeLeadsByStatus();
  };

  const activeLead = activeId ? leads.find((lead) => lead.id === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => (
          <div key={column.id} className="flex-shrink-0">
            <KanbanColumnComponent
              column={column}
              onViewDetails={onViewDetails}
              onEdit={onEdit}
              onSchedule={onSchedule}
              onSendEmail={onSendEmail}
              onEditStatus={onEditStatus}
              onSetFollowUp={onSetFollowUp}
              onDelete={onDelete}
              onTextSent={onTextSent}
              onCallCompleted={onCallCompleted}
              unreadCounts={unreadCounts}
            />
          </div>
        ))}
      </div>
      <DragOverlay>
        {activeLead ? (
          <div className="opacity-90">
            <LeadCard
              lead={activeLead}
              onViewDetails={onViewDetails}
              onEdit={onEdit}
              onSchedule={onSchedule}
              onSendEmail={onSendEmail}
              onEditStatus={onEditStatus}
              onSetFollowUp={onSetFollowUp}
              onDelete={onDelete}
              selectable={false}
              onTextSent={onTextSent ? () => onTextSent(activeLead.id) : undefined}
              onCallCompleted={onCallCompleted ? () => onCallCompleted(activeLead.id) : undefined}
              hasUnreadText={(unreadCounts?.[activeLead.id]?.text ?? 0) > 0}
              hasUnreadEmail={(unreadCounts?.[activeLead.id]?.email ?? 0) > 0}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
