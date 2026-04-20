import type { Contact } from "@shared/schema";

export type LeadActiveModal =
  | { type: "details"; contact: Contact }
  | { type: "edit"; contact: Contact }
  | { type: "editStatus"; contact: Contact }
  | { type: "followUp"; contact: Contact }
  | { type: "delete"; contactId: string; contactName: string }
  | null;

export type LeadViewType = "cards" | "spreadsheet" | "kanban";
