import { useEffect, useState, type ReactNode, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Calendar, Building2, Inbox, Phone, Plus, Blocks } from "lucide-react";
import { SiFacebook, SiGoogle } from "react-icons/si";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialpadCard } from "./DialpadCard";
import { TwilioCard } from "./TwilioCard";
import { SendGridCard } from "./SendGridCard";
import { HousecallProCard } from "./HousecallProCard";
import { HcpEmployeeMappingCard } from "./HcpEmployeeMappingCard";
import { FacebookLeadsCard } from "./FacebookLeadsCard";
import { GoogleLocalServicesCard } from "./GoogleLocalServicesCard";
import { GmailConnectionCard } from "./GmailConnectionCard";
import { GoogleCalendarConnectionCard } from "./GoogleCalendarConnectionCard";
import { LeadCaptureCard } from "./LeadCaptureCard";
import { SharedEmailCard } from "./SharedEmailCard";
import { useCurrentUser, isAdminUser, type CurrentUser } from "@/hooks/useCurrentUser";

interface CatalogEntry {
  key: string;
  name: string;
  description: string;
  icon: ReactNode;
  iconBg?: string;
  Component: ComponentType;
  /** Rendered unconditionally, ignoring integration permission gating (parity with prior behavior). */
  alwaysVisible?: boolean;
  /** Sub-setting cards that only render (nested under the parent) when the parent is connected. */
  subCards?: ComponentType[];
}

const CATALOG: CatalogEntry[] = [
  {
    key: "gmail",
    name: "Gmail Connection",
    description: "Connect your Gmail account to send and receive emails from the CRM",
    icon: <Mail className="h-5 w-5" />,
    Component: GmailConnectionCard,
  },
  {
    key: "google-calendar",
    name: "Google Calendar",
    description: "Sync booked appointments and let busy times block your availability",
    icon: <Calendar className="h-5 w-5" />,
    Component: GoogleCalendarConnectionCard,
    alwaysVisible: true,
  },
  {
    key: "shared-email",
    name: "Shared Company Email",
    description: "Connect a company Gmail account for team-wide outbound email",
    icon: <Building2 className="h-5 w-5" />,
    Component: SharedEmailCard,
  },
  {
    key: "lead-capture",
    name: "Lead Capture Inbox",
    description: "Auto-create leads from emails sent to a designated Gmail inbox",
    icon: <Inbox className="h-5 w-5" />,
    Component: LeadCaptureCard,
  },
  {
    key: "dialpad",
    name: "Dialpad",
    description: "SMS and calling services for customer communication",
    icon: <Phone className="h-5 w-5" />,
    Component: DialpadCard,
  },
  {
    key: "twilio",
    name: "Twilio",
    description: "SMS and calling services for customer communication",
    icon: <Phone className="h-5 w-5" />,
    Component: TwilioCard,
  },
  {
    key: "sendgrid",
    name: "SendGrid",
    description: "Email delivery for customer communication via SendGrid",
    icon: <Mail className="h-5 w-5" />,
    Component: SendGridCard,
  },
  {
    key: "housecall-pro",
    name: "Housecall Pro",
    description: "Business management and scheduling integration",
    icon: <Calendar className="h-5 w-5" />,
    Component: HousecallProCard,
    subCards: [HcpEmployeeMappingCard],
  },
  {
    key: "facebook-leads",
    name: "Facebook Lead Management",
    description: "Pull leads from Facebook Lead Ads directly into the CRM",
    icon: <SiFacebook className="h-5 w-5 text-white" />,
    iconBg: "#1877F2",
    Component: FacebookLeadsCard,
  },
  {
    key: "google-local-services",
    name: "Google Local Services",
    description: "Pull leads from your Google Local Services Ads account into the CRM",
    icon: <SiGoogle className="h-5 w-5 text-white" />,
    iconBg: "#4285F4",
    Component: GoogleLocalServicesCard,
  },
];

/**
 * Determines which integrations are already connected so the tab can split them
 * into the "Connected" zone vs. the "Add integration" catalog. Every query here
 * shares a cache key with the query the corresponding card runs internally, so
 * TanStack Query dedupes them — no extra network requests are introduced. Status
 * queries are gated by `enabled` so we never fetch state for integrations the
 * user cannot view.
 */
function useConnectionStates(
  user: CurrentUser | undefined,
  canView: (key: string) => boolean,
): { states: Record<string, boolean>; isLoading: boolean } {
  const gmailConnected = !!(user?.gmailConnected || user?.gmailEmail);
  const calendarConnected = !!(user?.googleCalendarConnected || user?.googleCalendarEmail);

  const viewIntegrationsList =
    canView("dialpad") || canView("twilio") || canView("sendgrid") || canView("housecall-pro");

  const integrationsQ = useQuery<{
    integrations: { name: string; hasCredentials: boolean; isEnabled: boolean }[];
  }>({
    queryKey: ["/api/integrations"],
    enabled: viewIntegrationsList,
  });
  const hasCreds = (name: string) =>
    !!integrationsQ.data?.integrations?.find((i) => i.name === name)?.hasCredentials;

  const sharedEmailQ = useQuery<{ connected: boolean }>({
    queryKey: ["/api/settings/shared-email"],
    enabled: canView("shared-email"),
  });
  const leadCaptureQ = useQuery<{ id: string } | null>({
    queryKey: ["/api/settings/lead-capture-inbox"],
    enabled: canView("lead-capture"),
  });
  const facebookQ = useQuery<{ connected: boolean }>({
    queryKey: ["/api/integrations/facebook/status"],
    enabled: canView("facebook-leads"),
  });
  const glsQ = useQuery<{ connected: boolean }>({
    queryKey: ["/api/integrations/google-local-services/status"],
    enabled: canView("google-local-services"),
  });

  const states: Record<string, boolean> = {
    gmail: gmailConnected,
    "google-calendar": calendarConnected,
    "shared-email": !!sharedEmailQ.data?.connected,
    "lead-capture": !!leadCaptureQ.data,
    dialpad: hasCreds("dialpad"),
    twilio: hasCreds("twilio"),
    sendgrid: hasCreds("sendgrid"),
    "housecall-pro": hasCreds("housecall-pro"),
    "facebook-leads": !!facebookQ.data?.connected,
    "google-local-services": !!glsQ.data?.connected,
  };

  const isLoading =
    integrationsQ.isLoading ||
    sharedEmailQ.isLoading ||
    leadCaptureQ.isLoading ||
    facebookQ.isLoading ||
    glsQ.isLoading;

  return { states, isLoading };
}

function IconBox({ entry }: { entry: CatalogEntry }) {
  return (
    <div
      className={`flex h-10 w-10 items-center justify-center rounded-lg shrink-0 ${entry.iconBg ? "" : "bg-muted"}`}
      style={entry.iconBg ? { backgroundColor: entry.iconBg } : undefined}
    >
      {entry.icon}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-md border border-dashed p-8 text-center" data-testid="integrations-empty-state">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
        <Blocks className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="font-medium">No integrations connected yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect your tools to sync leads, calls, email, and scheduling.
      </p>
      <Button className="mt-4" onClick={onAdd} data-testid="button-empty-add-integration">
        <Plus className="h-4 w-4 mr-2" />
        Add integration
      </Button>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-md border p-6">
          <div className="h-5 w-32 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-4 w-48 animate-pulse rounded bg-muted" />
          <div className="mt-6 h-8 w-full animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function IntegrationsTab() {
  const { data: currentUser } = useCurrentUser();
  const user = currentUser?.user;
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const canView = (key: string): boolean => {
    const entry = CATALOG.find((e) => e.key === key);
    if (entry?.alwaysVisible) return true;
    if (!user) return false;
    if (isAdminUser(user.role)) return true;
    if (!user.canManageIntegrations) return false;
    const allowed = user.allowedIntegrations;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(key);
  };

  const { states, isLoading } = useConnectionStates(user, canView);

  // Once the integration being set up flips to connected, drop the inline setup
  // zone — it moves to the "Connected" grid automatically.
  const addingConnected = addingKey ? !!states[addingKey] : false;
  useEffect(() => {
    if (addingKey && addingConnected) setAddingKey(null);
  }, [addingKey, addingConnected]);

  const visible = CATALOG.filter((e) => canView(e.key));
  const connectedEntries = visible.filter((e) => states[e.key]);
  const availableEntries = visible.filter((e) => !states[e.key] && e.key !== addingKey);
  const addingEntry = addingKey ? CATALOG.find((e) => e.key === addingKey) ?? null : null;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-base font-semibold">Connected</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCatalogOpen(true)}
            data-testid="button-add-integration"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add integration
          </Button>
        </div>

        {!user || isLoading ? (
          <SkeletonGrid />
        ) : connectedEntries.length === 0 && !addingEntry ? (
          <EmptyState onAdd={() => setCatalogOpen(true)} />
        ) : connectedEntries.length === 0 ? null : (
          <div className="grid gap-4 lg:grid-cols-2">
            {connectedEntries.flatMap((e) => {
              const { Component } = e;
              const items: ReactNode[] = [<Component key={e.key} />];
              e.subCards?.forEach((Sub, idx) => {
                items.push(<Sub key={`${e.key}-sub-${idx}`} />);
              });
              return items;
            })}
          </div>
        )}
      </section>

      {addingEntry && (
        <section className="space-y-3" data-testid="integration-setup-zone">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="text-base font-semibold">Set up {addingEntry.name}</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAddingKey(null)}
              data-testid="button-cancel-add"
            >
              Cancel
            </Button>
          </div>
          <div className="grid gap-4">
            <addingEntry.Component />
          </div>
        </section>
      )}

      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add an integration</DialogTitle>
            <DialogDescription>Connect a service to extend your CRM.</DialogDescription>
          </DialogHeader>
          {availableEntries.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              All available integrations are already connected.
            </div>
          ) : (
            <div className="space-y-2">
              {availableEntries.map((e) => (
                <div
                  key={e.key}
                  className="flex items-center justify-between gap-3 rounded-md border p-3 flex-wrap"
                  data-testid={`catalog-item-${e.key}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <IconBox entry={e} />
                    <div className="min-w-0">
                      <div className="font-medium">{e.name}</div>
                      <div className="text-sm text-muted-foreground">{e.description}</div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setAddingKey(e.key);
                      setCatalogOpen(false);
                    }}
                    data-testid={`button-add-${e.key}`}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
