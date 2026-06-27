import { AccountInfoCard } from "./AccountInfoCard";
import { InstallAppCard } from "./InstallAppCard";
import { CallingPreferenceCard } from "./CallingPreferenceCard";
import { PhoneToRingCard } from "./PhoneToRingCard";
import { BookingPageCard } from "./BookingPageCard";
import { AiSchedulingAgentCard } from "./AiSchedulingAgentCard";
import { TeamManagementCard } from "./TeamManagementCard";
import { TerminologyCard } from "./TerminologyCard";
import { CompanyBrandingCard } from "./CompanyBrandingCard";
import { LegacyBookingLinksNotice } from "./LegacyBookingLinksNotice";

export function AccountTab() {
  return (
    <div className="space-y-6">
      <LegacyBookingLinksNotice />
      <CompanyBrandingCard />
      <AccountInfoCard />
      <InstallAppCard />
      <CallingPreferenceCard />
      <PhoneToRingCard />
      <BookingPageCard />
      <AiSchedulingAgentCard />
      <TeamManagementCard />
      <TerminologyCard />
    </div>
  );
}
