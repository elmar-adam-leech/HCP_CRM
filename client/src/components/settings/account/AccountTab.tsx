import { AccountInfoCard } from "./AccountInfoCard";
import { InstallAppCard } from "./InstallAppCard";
import { CallingPreferenceCard } from "./CallingPreferenceCard";
import { BookingPageCard } from "./BookingPageCard";
import { TeamManagementCard } from "./TeamManagementCard";
import { TerminologyCard } from "./TerminologyCard";
import { CompanyBrandingCard } from "./CompanyBrandingCard";

export function AccountTab() {
  return (
    <div className="space-y-6">
      <CompanyBrandingCard />
      <AccountInfoCard />
      <InstallAppCard />
      <CallingPreferenceCard />
      <BookingPageCard />
      <TeamManagementCard />
      <TerminologyCard />
    </div>
  );
}
