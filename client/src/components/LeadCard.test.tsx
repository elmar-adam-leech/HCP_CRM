// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Contact } from "@shared/schema";

vi.stubGlobal("React", React);

vi.mock("@/hooks/useContactMutations", () => ({
  useContactMutations: () => ({
    updateContact: { mutate: vi.fn() },
    unscheduleContact: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("./CommunicationActionButtons", () => ({
  CommunicationActionButtons: () => null,
}));

vi.mock("./TagsDialog", () => ({
  TagsDialog: () => null,
}));

vi.mock("./WorkflowEnrollmentBadges", () => ({
  WorkflowEnrollmentBadges: () => null,
}));

import { LeadCard } from "./LeadCard";

const LEAD_ID = "lead-remount-1";
const SAVED_EMAIL = "riley@example.com";
const SAVED_PHONE = "+1 (555) 010-0200";

const baseLead = {
  id: LEAD_ID,
  name: "Riley Remount",
  // Keep emails/phones out of this shared object so each fixture below really
  // exercises a different persisted property order.
  address: null,
  street: null,
  city: null,
  state: null,
  zip: null,
  type: "lead",
  status: "new",
  source: "website",
  notes: null,
  noteSubmissionKeys: [],
  submissionCreationKey: null,
  tags: [],
  followUpDate: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  pageUrl: null,
  housecallProCustomerId: null,
  housecallProEstimateId: null,
  scheduledAt: null,
  scheduledEmployeeId: null,
  isScheduled: false,
  contactedAt: null,
  contactedByUserId: null,
  scheduledByUserId: null,
  externalId: null,
  externalSource: null,
  normalizedPhone: null,
  bookingCode: null,
  contractorId: "contractor-1",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  lastActivityAt: new Date("2024-01-01T00:00:00.000Z"),
  erasedAt: null,
  anonymized: false,
  retentionFlaggedAt: null,
} as Omit<Contact, "emails" | "phones">;

const remountFixtures = [
  {
    label: "email field before phone field",
    original: {
      ...baseLead,
      emails: [],
      phones: [SAVED_PHONE],
    },
    persisted: {
      ...baseLead,
      emails: [SAVED_EMAIL],
      phones: [SAVED_PHONE],
    },
  },
  {
    label: "phone field before email field",
    original: {
      ...baseLead,
      phones: [SAVED_PHONE],
      emails: [],
    },
    persisted: {
      ...baseLead,
      phones: [SAVED_PHONE],
      emails: [SAVED_EMAIL],
    },
  },
] satisfies Array<{ label: string; original: Contact; persisted: Contact }>;

afterEach(() => cleanup());

describe("LeadCard persisted contact remount", () => {
  it.each(remountFixtures)(
    "shows richer saved contact details after an unmount/reload-style remount ($label)",
    ({ original, persisted }) => {
      const firstMount = render(<LeadCard lead={original} />);
      const originalCard = screen.getByTestId(`card-lead-${LEAD_ID}`);

      expect(originalCard.textContent).toContain("No email");
      expect(originalCard.textContent).toContain(SAVED_PHONE);

      firstMount.unmount();
      render(<LeadCard lead={persisted} />);

      const reloadedCard = screen.getByTestId(`card-lead-${LEAD_ID}`);
      expect(reloadedCard.getAttribute("data-testid")).toBe(`card-lead-${LEAD_ID}`);
      expect(reloadedCard.textContent).toContain(SAVED_EMAIL);
      expect(reloadedCard.textContent).toContain(SAVED_PHONE);
      expect(reloadedCard.textContent).not.toContain("No email");
    },
  );
});