import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type LegacyEntry = {
  id: string;
  kind: "template" | "workflow_step";
  label: string;
  snippet: string;
  workflowId?: string;
};

type LegacyScanResponse = {
  count: number;
  templates: LegacyEntry[];
  workflowSteps: LegacyEntry[];
};

export function LegacyBookingLinksNotice() {
  const { data } = useQuery<LegacyScanResponse>({
    queryKey: ["/api/settings/legacy-booking-links"],
  });

  if (!data || data.count === 0) return null;

  return (
    <Alert data-testid="banner-legacy-booking-links">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {data.count} saved {data.count === 1 ? "template" : "templates"} still use
        an old booking link format
      </AlertTitle>
      <AlertDescription>
        <p className="mb-2 text-sm">
          These templates contain hand-typed booking URLs (
          <code>?contact=</code> / <code>?contactId=</code>). Customers who tap
          those links may create duplicate contact records. Edit each one and
          replace the link with the <code>{`{{booking_link}}`}</code>{" "}
          placeholder so the system fills in a fresh short-code link every time.
        </p>
        <ul className="space-y-1 text-sm">
          {[...data.templates, ...data.workflowSteps].slice(0, 10).map((entry) => (
            <li key={`${entry.kind}-${entry.id}`} className="flex gap-2">
              <span className="text-muted-foreground">
                {entry.kind === "template" ? "Template:" : "Workflow:"}
              </span>
              <span>{entry.label}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
