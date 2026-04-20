import { apiRequest, queryClient } from "@/lib/queryClient";

export type StatusColorCategory = "gray" | "yellow" | "orange" | "green" | "red";

export function getStatusColorCategory(
  entityType: "lead" | "estimate" | "job",
  status: string
): StatusColorCategory {
  if (entityType === "lead") {
    switch (status) {
      case "contacted": return "orange";
      case "scheduled": return "green";
      case "disqualified": return "red";
      default: return "gray";
    }
  }
  if (entityType === "estimate") {
    switch (status) {
      case "in_progress": return "yellow";
      case "sent": return "orange";
      case "approved": return "green";
      case "rejected":
      case "declined": return "red";
      default: return "gray";
    }
  }
  switch (status) {
    case "in_progress": return "orange";
    case "completed": return "green";
    case "cancelled": return "red";
    default: return "gray";
  }
}

export function getStatusBorderColor(
  entityType: "lead" | "estimate" | "job",
  status: string
): string {
  const category = getStatusColorCategory(entityType, status);
  switch (category) {
    case "yellow": return "border-l-4 border-l-yellow-500";
    case "orange": return "border-l-4 border-l-orange-500";
    case "green": return "border-l-4 border-l-green-600";
    case "red": return "border-l-4 border-l-destructive";
    default: return "border-l-4 border-l-gray-400 dark:border-l-gray-500";
  }
}

export function getStatusRowBorderColor(
  entityType: "lead" | "estimate" | "job",
  status: string
): string {
  const category = getStatusColorCategory(entityType, status);
  switch (category) {
    case "yellow": return "border-l-2 border-l-yellow-500";
    case "orange": return "border-l-2 border-l-orange-500";
    case "green": return "border-l-2 border-l-green-600";
    case "red": return "border-l-2 border-l-destructive";
    default: return "border-l-2 border-l-gray-400 dark:border-l-gray-500";
  }
}

export function getStatusBadgeClasses(
  entityType: "lead" | "estimate" | "job",
  status: string
): string {
  const category = getStatusColorCategory(entityType, status);
  switch (category) {
    case "yellow": return "bg-yellow-500 text-white";
    case "orange": return "bg-orange-500 text-white";
    case "green": return "bg-green-600 text-white";
    case "red": return "";
    default: return "";
  }
}

export async function updateContactTags(
  contactId: string,
  newTags: string[]
): Promise<void> {
  await apiRequest('PATCH', `/api/contacts/${contactId}`, { tags: newTags });
  queryClient.invalidateQueries({ queryKey: [`/api/contacts/${contactId}`] });
  queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
}
