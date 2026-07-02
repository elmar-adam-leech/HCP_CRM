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
import { useCurrentUser, isAdminUser } from "@/hooks/useCurrentUser";

export function IntegrationsTab() {
  const { data: currentUser } = useCurrentUser();
  const user = currentUser?.user;

  const canView = (integrationKey: string): boolean => {
    if (!user) return false;
    if (isAdminUser(user.role)) return true;
    if (!user.canManageIntegrations) return false;
    const allowed = user.allowedIntegrations;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(integrationKey);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {canView('gmail') && <GmailConnectionCard />}
      <GoogleCalendarConnectionCard />
      {canView('shared-email') && <SharedEmailCard />}
      {canView('lead-capture') && <LeadCaptureCard />}
      {canView('dialpad') && <DialpadCard />}
      {canView('twilio') && <TwilioCard />}
      {canView('sendgrid') && <SendGridCard />}
      {canView('housecall-pro') && <HousecallProCard />}
      {canView('housecall-pro') && <HcpEmployeeMappingCard />}
      {canView('facebook-leads') && <FacebookLeadsCard />}
      {canView('google-local-services') && <GoogleLocalServicesCard />}
    </div>
  );
}
