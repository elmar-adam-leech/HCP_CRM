/**
 * AI SMS scheduling agent state-machine tests.
 *
 * The agent itself is integration-heavy (LLM, providers, db, websocket),
 * so these tests mock the surrounding modules and assert the high-level
 * decisions: when to skip, when to hand off, when to create a conversation,
 * how the handoff fan-out works, and what gets passed to bookAppointment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  contractorRowRef,
  inboundMessageRef,
  openConvRef,
  triggerConvRef,
  callCountsRef,
  triggerMsgRef,
  contactRef,
  llmResponseRef,
  availabilityRef,
  selectSalespersonRef,
  bookAppointmentRef,
  placesTextSearchRef,
  salespeopleRef,
  insertConvSpy,
  updateConvSpy,
  sendSmsSpy,
  createMessageSpy,
  broadcastSpy,
  createActivitySpy,
  createNotificationSpy,
  bookAppointmentSpy,
  selectSalespersonSpy,
  placesSpy,
  isAiAvailable,
} = vi.hoisted(() => ({
  // Mutable fixture refs — typed as Record<string, unknown> so individual
  // tests can substitute partial shapes without forcing every field.
  contractorRowRef: { current: { aiSchedulingEnabled: true, aiSchedulingWindowHours: 72, name: "Test Co", timezone: "America/New_York", defaultDialpadNumber: "+15551231234" } as Record<string, unknown> },
  inboundMessageRef: { current: { id: "msg-1", direction: "inbound", content: "Tomorrow at 2pm works at 123 Main St, Salem, MA 01970" } as Record<string, unknown> | null },
  openConvRef: { current: null as Record<string, unknown> | null },
  triggerConvRef: { current: null as Record<string, unknown> | null },
  callCountsRef: { current: {} as Record<string, number> },
  triggerMsgRef: { current: { id: "trigger-1" } as { id: string } | null },
  contactRef: { current: { id: "contact-1", name: "Jane Doe", phones: ["+15555550100"], emails: ["jane@example.com"], address: "123 Main St, Salem, MA 01970", assignedToUserId: null } as Record<string, unknown> },
  llmResponseRef: { current: '{"intent":"propose_time","confidence":0.9,"startTimeIso":"2099-01-01T19:00:00.000Z","address":"123 Main St, Salem, MA 01970","reply":"Got it"}' },
  availabilityRef: { current: [{ start: new Date("2099-01-01T19:00:00.000Z"), end: new Date("2099-01-01T20:00:00.000Z"), availableSalespersonIds: ["sp-1"] }] as Array<{ start: Date; end: Date; availableSalespersonIds: string[] }> },
  selectSalespersonRef: { current: { userId: "sp-1", name: "Sam Sales" } as { userId: string; name: string } | null },
  bookAppointmentRef: { current: { success: true, bookingId: "bk-1" } as { success: boolean; bookingId?: string; error?: string } },
  placesTextSearchRef: { current: "123 Main Street, Salem, MA 01970, USA" as string | undefined },
  salespeopleRef: { current: [{ userId: "sp-1" }, { userId: "sp-2" }] as Array<{ userId: string }> },
  insertConvSpy: vi.fn(),
  updateConvSpy: vi.fn(),
  sendSmsSpy: vi.fn(async () => ({ success: true, messageId: "ext-1" })),
  createMessageSpy: vi.fn(async () => ({ id: "out-1" })),
  broadcastSpy: vi.fn(),
  createActivitySpy: vi.fn(async () => ({ id: "act-1" })),
  createNotificationSpy: vi.fn(async () => ({ id: "notif-1" })),
  bookAppointmentSpy: vi.fn(),
  selectSalespersonSpy: vi.fn(),
  placesSpy: vi.fn(),
  isAiAvailable: { current: true },
}));

vi.mock("../db", () => {
  const buildSelectChain = (rows: any[]) => {
    const chain: any = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain;
  };
  // Track per-table call ordering so the FIRST select on
  // ai_scheduling_conversations returns the open conversation (if any) and
  // the SECOND select returns the trigger lookup (used for restart
  // suppression). Stored on a hoisted ref so beforeEach can reset.
  return {
    db: {
      select: vi.fn(() => ({
        from: (tbl: any) => {
          const tblName = String((tbl && tbl[Symbol.for("drizzle:Name")]) || tbl?._?.name || tbl);
          if (tblName.includes("contractor")) return buildSelectChain(contractorRowRef.current ? [contractorRowRef.current] : []);
          if (tblName.includes("ai_scheduling_conversations") || tblName.includes("aiSchedulingConversations")) {
            const n = (callCountsRef.current[tblName] = (callCountsRef.current[tblName] ?? 0) + 1);
            if (n === 1) return buildSelectChain(openConvRef.current ? [openConvRef.current] : []);
            return buildSelectChain(triggerConvRef.current ? [triggerConvRef.current] : []);
          }
          if (tblName.includes("messages")) return buildSelectChain(triggerMsgRef.current ? [triggerMsgRef.current] : []);
          if (tblName.includes("users")) return buildSelectChain([{ name: "Sam Sales" }]);
          return buildSelectChain([]);
        },
      })),
      insert: vi.fn(() => ({ values: (v: any) => { insertConvSpy(v); return { returning: async () => [{ id: "conv-1", ...v }] }; } })),
      update: vi.fn(() => ({ set: (v: any) => { updateConvSpy(v); return { where: async () => undefined }; } })),
    },
  };
});

vi.mock("@shared/schema", () => ({
  aiSchedulingConversations: { [Symbol.for("drizzle:Name")]: "ai_scheduling_conversations", id: { name: "id" }, contractorId: { name: "contractor_id" }, contactId: { name: "contact_id" }, status: { name: "status" } },
  contractors: { [Symbol.for("drizzle:Name")]: "contractors", id: { name: "id" }, defaultDialpadNumber: { name: "default_dialpad_number" }, timezone: { name: "timezone" } },
  messages: { [Symbol.for("drizzle:Name")]: "messages", id: { name: "id" }, contractorId: { name: "contractor_id" }, contactId: { name: "contact_id" }, direction: { name: "direction" }, isSchedulingIntent: { name: "is_scheduling_intent" }, createdAt: { name: "created_at" }, fromNumber: { name: "from_number" } },
  users: { [Symbol.for("drizzle:Name")]: "users", id: { name: "id" }, name: { name: "name" } },
}));

vi.mock("../storage", () => ({
  storage: {
    getMessage: vi.fn(async () => inboundMessageRef.current),
    getContact: vi.fn(async () => contactRef.current),
    createMessage: createMessageSpy,
    createActivity: createActivitySpy,
    createNotification: createNotificationSpy,
  },
}));

vi.mock("../providers/provider-service", () => ({
  providerService: { sendSms: sendSmsSpy },
}));

vi.mock("../websocket", () => ({
  broadcastToContractor: broadcastSpy,
}));

vi.mock("../ai-service", () => ({
  aiService: {
    isAvailable: () => isAiAvailable.current,
    generateContent: async () => llmResponseRef.current,
  },
}));

vi.mock("../scheduling/availability", () => ({
  getUnifiedAvailability: async () => availabilityRef.current,
  selectNextAvailableSalesperson: async (...args: any[]) => {
    selectSalespersonSpy(...args);
    return selectSalespersonRef.current;
  },
}));

vi.mock("../scheduling/booking", () => ({
  bookAppointment: async (...args: any[]) => {
    bookAppointmentSpy(...args);
    return bookAppointmentRef.current;
  },
}));

vi.mock("../scheduling/queries", () => ({
  getSalespeople: async () => salespeopleRef.current,
}));

vi.mock("../utils/places-client", () => ({
  placesTextSearch: async (...args: any[]) => {
    placesSpy(...args);
    return placesTextSearchRef.current;
  },
}));

vi.mock("../utils/phone-normalizer", () => ({
  normalizePhoneForStorage: (s: string) => s,
}));

beforeEach(() => {
  vi.clearAllMocks();
  contractorRowRef.current = { aiSchedulingEnabled: true, aiSchedulingWindowHours: 72, name: "Test Co", timezone: "America/New_York", defaultDialpadNumber: "+15551231234" };
  openConvRef.current = null;
  triggerConvRef.current = null;
  callCountsRef.current = {};
  triggerMsgRef.current = { id: "trigger-1" };
  inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "Tomorrow at 2pm works at 123 Main St, Salem, MA 01970" };
  contactRef.current = { id: "contact-1", name: "Jane Doe", phones: ["+15555550100"], emails: ["jane@example.com"], address: "123 Main St, Salem, MA 01970", assignedToUserId: null };
  llmResponseRef.current = '{"intent":"propose_time","confidence":0.9,"startTimeIso":"2099-01-01T19:00:00.000Z","address":"123 Main St, Salem, MA 01970","reply":"Got it"}';
  availabilityRef.current = [{ start: new Date("2099-01-01T19:00:00.000Z"), end: new Date("2099-01-01T20:00:00.000Z"), availableSalespersonIds: ["sp-1"] }];
  selectSalespersonRef.current = { userId: "sp-1", name: "Sam Sales" };
  bookAppointmentRef.current = { success: true, bookingId: "bk-1" };
  placesTextSearchRef.current = "123 Main Street, Salem, MA 01970, USA";
  salespeopleRef.current = [{ userId: "sp-1" }, { userId: "sp-2" }];
  isAiAvailable.current = true;
});

describe("aiSchedulingAgent.handleInbound — gating", () => {
  it("skips when the contractor has the AI agent disabled", async () => {
    contractorRowRef.current = { ...contractorRowRef.current, aiSchedulingEnabled: false };
    const { handleInbound } = await import("./ai-scheduling-agent");
    const handled = await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(handled).toBe(false);
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(insertConvSpy).not.toHaveBeenCalled();
  });

  it("STOP keyword aborts and never engages the LLM", async () => {
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "STOP" };
    const { handleInbound } = await import("./ai-scheduling-agent");
    const handled = await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(handled).toBe(false);
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(bookAppointmentSpy).not.toHaveBeenCalled();
  });

  it("skips when there is no open conversation and no recent scheduling-intent outreach", async () => {
    triggerMsgRef.current = null;
    const { handleInbound } = await import("./ai-scheduling-agent");
    const handled = await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(handled).toBe(false);
    expect(insertConvSpy).not.toHaveBeenCalled();
  });

  it("creates a new conversation when an inbound reply follows a scheduling-intent SMS", async () => {
    const { handleInbound } = await import("./ai-scheduling-agent");
    const handled = await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(handled).toBe(true);
    expect(insertConvSpy).toHaveBeenCalledTimes(1);
    expect(insertConvSpy.mock.calls[0][0]).toMatchObject({
      contractorId: "c1",
      contactId: "ct1",
      status: "active",
    });
  });
});

describe("aiSchedulingAgent.handleInbound — handoffs", () => {
  it("hands off when the LLM detects request_human", async () => {
    llmResponseRef.current = '{"intent":"request_human","confidence":0.95,"reply":"Connecting you to a human."}';
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    const handoffUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "handed_off");
    expect(handoffUpdate).toBeTruthy();
    expect(createActivitySpy).toHaveBeenCalled();
    const activityArg = createActivitySpy.mock.calls[0][0];
    expect(activityArg.externalSource).toBe("ai_agent");
  });

  it("hands off after MAX_EXCHANGES with no booking", async () => {
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 6 };
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    const handoffUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "handed_off");
    expect(handoffUpdate).toBeTruthy();
  });

  it("hands off when the LLM confidence is below threshold", async () => {
    llmResponseRef.current = '{"intent":"unclear","confidence":0.1,"reply":"sorry, what?"}';
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    const handoffUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "handed_off");
    expect(handoffUpdate).toBeTruthy();
    expect(handoffUpdate?.[0]?.handoffReason).toMatch(/low confidence/i);
  });

  it("hands off and notifies every salesperson when the lead has no assignee", async () => {
    llmResponseRef.current = '{"intent":"request_human","confidence":0.95,"reply":"ok"}';
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    contactRef.current = { ...contactRef.current, assignedToUserId: null };
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    const recipientUserIds = createNotificationSpy.mock.calls.map((c) => c[0]?.userId);
    expect(recipientUserIds).toEqual(expect.arrayContaining(["sp-1", "sp-2"]));
  });

  it("hands off only to the assignee when one is set", async () => {
    llmResponseRef.current = '{"intent":"request_human","confidence":0.95,"reply":"ok"}';
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    contactRef.current = { ...contactRef.current, assignedToUserId: "user-assignee" };
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(createNotificationSpy).toHaveBeenCalledTimes(1);
    expect(createNotificationSpy.mock.calls[0][0].userId).toBe("user-assignee");
  });

  it("hands off when bookAppointment fails on YES confirmation", async () => {
    bookAppointmentRef.current = { success: false, error: "HCP rejected the slot" };
    openConvRef.current = {
      id: "conv-existing",
      contractorId: "c1",
      contactId: "ct1",
      status: "awaiting_confirmation",
      exchangeCount: 2,
      proposedStartTime: new Date("2099-01-01T19:00:00.000Z"),
      proposedSalespersonUserId: "sp-1",
      proposedAddress: "123 Main St, Salem, MA 01970",
    };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "YES" };
    llmResponseRef.current = '{"intent":"confirm","confidence":0.95,"reply":"Booking now"}';
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(bookAppointmentSpy).toHaveBeenCalled();
    const handoffUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "handed_off");
    expect(handoffUpdate).toBeTruthy();
    expect(handoffUpdate?.[0]?.handoffReason).toMatch(/HCP rejected/);
  });
});

describe("aiSchedulingAgent.handleInbound — booking flow", () => {
  it("books with scheduleSource='ai_agent' and resolved Places address on YES", async () => {
    openConvRef.current = {
      id: "conv-existing",
      contractorId: "c1",
      contactId: "ct1",
      status: "awaiting_confirmation",
      exchangeCount: 2,
      proposedStartTime: new Date("2099-01-01T19:00:00.000Z"),
      proposedSalespersonUserId: "sp-1",
      proposedAddress: "123 Main St, Salem, MA 01970",
    };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "yes" };
    llmResponseRef.current = '{"intent":"confirm","confidence":0.95,"reply":"Booking"}';
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(bookAppointmentSpy).toHaveBeenCalledTimes(1);
    const [tenantId, request] = bookAppointmentSpy.mock.calls[0];
    expect(tenantId).toBe("c1");
    expect(request.scheduleSource).toBe("ai_agent");
    expect(request.salespersonId).toBe("sp-1");
    expect(request.customerAddress).toBe("123 Main Street, Salem, MA 01970, USA");
    expect(request.customerAddressComponents?.street).toBeTruthy();
    // Booked-by-AI activity is written for the activity feed.
    const bookingActivity = createActivitySpy.mock.calls.find((c) => c[0]?.title?.includes("Booked"));
    expect(bookingActivity).toBeTruthy();
    expect(bookingActivity?.[0]?.externalSource).toBe("ai_agent");
  });

  it("hands off (does NOT confirm) when bookAppointment returns success with scheduleError", async () => {
    bookAppointmentRef.current = { success: true, bookingId: "bk-1", scheduleError: "HCP rejected slot" } as { success: boolean; bookingId?: string; error?: string; scheduleError?: string };
    openConvRef.current = {
      id: "conv-existing",
      contractorId: "c1",
      contactId: "ct1",
      status: "awaiting_confirmation",
      exchangeCount: 2,
      proposedStartTime: new Date("2099-01-01T19:00:00.000Z"),
      proposedSalespersonUserId: "sp-1",
      proposedAddress: "123 Main St, Salem, MA 01970",
    };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "yes" };
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(bookAppointmentSpy).toHaveBeenCalled();
    const handoffUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "handed_off");
    expect(handoffUpdate).toBeTruthy();
    expect(handoffUpdate?.[0]?.handoffReason).toMatch(/HCP scheduling failed/);
    const bookedUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "booked");
    expect(bookedUpdate).toBeFalsy();
    const confirmSms = sendSmsSpy.mock.calls.find((c) => /You're booked/i.test(c[0]?.message ?? ""));
    expect(confirmSms).toBeFalsy();
  });

  it("texts the AI reply to the inbound sender's number, not the first contact phone", async () => {
    contactRef.current = { id: "ct1", name: "Jane", phones: ["+15555550100", "+15555550999"], emails: [], address: "123 Main St, Salem, MA 01970", assignedToUserId: null };
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "Tomorrow at 2pm works at 123 Main St, Salem, MA 01970", fromNumber: "+15555550999" };
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    const sentTo = sendSmsSpy.mock.calls[0]?.[0]?.to;
    expect(sentTo).toBe("+15555550999");
    expect(sentTo).not.toBe("+15555550100");
  });

  it("re-validates the slot at YES and falls back to cascade when the proposed salesperson is no longer free", async () => {
    selectSalespersonRef.current = { userId: "sp-2", name: "Other Rep" };
    openConvRef.current = {
      id: "conv-existing",
      contractorId: "c1",
      contactId: "ct1",
      status: "awaiting_confirmation",
      exchangeCount: 2,
      proposedStartTime: new Date("2099-01-01T19:00:00.000Z"),
      proposedSalespersonUserId: "sp-1",
      proposedAddress: "123 Main St, Salem, MA 01970",
    };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "yes" };
    llmResponseRef.current = '{"intent":"confirm","confidence":0.95,"reply":"Booking"}';
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    const [, request] = bookAppointmentSpy.mock.calls[0];
    expect(request.salespersonId).toBe("sp-2");
  });

  it("offers nearby alternatives when the requested time is unavailable", async () => {
    availabilityRef.current = [
      { start: new Date("2099-01-02T15:00:00.000Z"), end: new Date("2099-01-02T16:00:00.000Z"), availableSalespersonIds: ["sp-1"] },
      { start: new Date("2099-01-02T18:00:00.000Z"), end: new Date("2099-01-02T19:00:00.000Z"), availableSalespersonIds: ["sp-1"] },
      { start: new Date("2099-01-03T14:00:00.000Z"), end: new Date("2099-01-03T15:00:00.000Z"), availableSalespersonIds: ["sp-1"] },
    ];
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    // 1st call (requested time) returns null; subsequent calls (for the
    // chosen alternative) return sp-1.
    let n = 0;
    selectSalespersonSpy.mockImplementation(() => {
      n++;
      selectSalespersonRef.current = n === 1 ? null : { userId: "sp-1", name: "Sam Sales" };
    });
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    const smsBody = sendSmsSpy.mock.calls[0]?.[0]?.message;
    expect(smsBody).toMatch(/taken/i);
    expect(smsBody).toMatch(/Other openings/i);
  });
});

describe("aiSchedulingAgent.handleInbound — restart suppression", () => {
  it("does NOT restart from a trigger that already has a handed_off conversation", async () => {
    openConvRef.current = null;
    triggerConvRef.current = { id: "conv-prior", contractorId: "c1", contactId: "ct1", status: "handed_off", triggeringMessageId: "trigger-1" };
    const { handleInbound } = await import("./ai-scheduling-agent");
    const handled = await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(handled).toBe(false);
    expect(insertConvSpy).not.toHaveBeenCalled();
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });

  it("does NOT restart from a trigger that already has a booked conversation (post-booking customer follow-up)", async () => {
    openConvRef.current = null;
    triggerConvRef.current = { id: "conv-prior", contractorId: "c1", contactId: "ct1", status: "booked", triggeringMessageId: "trigger-1" };
    inboundMessageRef.current = { id: "msg-2", direction: "inbound", content: "thanks!" };
    const { handleInbound } = await import("./ai-scheduling-agent");
    const handled = await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m2" });
    expect(handled).toBe(false);
    expect(insertConvSpy).not.toHaveBeenCalled();
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });
});

describe("aiSchedulingAgent.handleInbound — multi-turn state", () => {
  it("persists requested startTime when address is missing, then completes the proposal on the next turn", async () => {
    // Turn 1: customer offers a time but no address; contact has no address on file.
    contactRef.current = { id: "ct1", name: "Jane", phones: ["+15555550100"], emails: [], address: null, assignedToUserId: null };
    openConvRef.current = { id: "conv-1", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 0, proposedStartTime: null, proposedAddress: null };
    inboundMessageRef.current = { id: "m-time", direction: "inbound", content: "Tuesday 3pm" };
    llmResponseRef.current = '{"intent":"propose_time","confidence":0.9,"startTimeIso":"2099-01-06T20:00:00.000Z","reply":"What\'s your address?"}';
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m-time" });
    // The fall-through update must persist proposedStartTime.
    const stateUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.proposedStartTime instanceof Date);
    expect(stateUpdate).toBeTruthy();
    const persistedStart = stateUpdate?.[0]?.proposedStartTime as Date;
    expect(persistedStart.toISOString()).toBe("2099-01-06T20:00:00.000Z");

    // Turn 2: customer supplies the address only — agent must reuse the
    // persisted startTime and propose the slot.
    updateConvSpy.mockClear();
    sendSmsSpy.mockClear();
    callCountsRef.current = {};
    openConvRef.current = { id: "conv-1", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1, proposedStartTime: persistedStart, proposedAddress: null };
    inboundMessageRef.current = { id: "m-addr", direction: "inbound", content: "123 Main St, Salem, MA 01970" };
    llmResponseRef.current = '{"intent":"propose_time","confidence":0.9,"address":"123 Main St, Salem, MA 01970","reply":"Got it"}';
    availabilityRef.current = [{ start: persistedStart, end: new Date(persistedStart.getTime() + 60 * 60 * 1000), availableSalespersonIds: ["sp-1"] }];
    selectSalespersonRef.current = { userId: "sp-1", name: "Sam Sales" };
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m-addr" });
    const proposalUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "awaiting_confirmation");
    expect(proposalUpdate).toBeTruthy();
    expect((proposalUpdate?.[0]?.proposedStartTime as Date)?.toISOString()).toBe(persistedStart.toISOString());
  });
});

describe("aiSchedulingAgent.handleInbound — safety guards", () => {
  it("does NOT book on a qualified reply like 'ok can we do Friday instead?' — strict whole-message YES", async () => {
    openConvRef.current = {
      id: "conv-existing",
      contractorId: "c1",
      contactId: "ct1",
      status: "awaiting_confirmation",
      exchangeCount: 2,
      proposedStartTime: new Date("2099-01-01T19:00:00.000Z"),
      proposedSalespersonUserId: "sp-1",
      proposedAddress: "123 Main St, Salem, MA 01970",
    };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "ok can we do Friday instead?" };
    llmResponseRef.current = '{"intent":"propose_time","confidence":0.9,"reply":"Sure, what time Friday?"}';
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(bookAppointmentSpy).not.toHaveBeenCalled();
    const bookedUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "booked");
    expect(bookedUpdate).toBeFalsy();
  });

  it("rejects (and asks again) when the parsed startTime is in the past", async () => {
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "Yesterday at 2pm at 123 Main St, Salem, MA 01970" };
    // LLM hallucinates a past startTimeIso.
    llmResponseRef.current = '{"intent":"propose_time","confidence":0.9,"startTimeIso":"2000-01-01T19:00:00.000Z","address":"123 Main St, Salem, MA 01970","reply":"Got it"}';
    const { handleInbound } = await import("./ai-scheduling-agent");
    await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(bookAppointmentSpy).not.toHaveBeenCalled();
    const sms = sendSmsSpy.mock.calls[0]?.[0]?.message ?? "";
    expect(sms).toMatch(/already passed|past/i);
    const proposalUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "awaiting_confirmation");
    expect(proposalUpdate).toBeFalsy();
  });

  it("ignores HELP carrier-compliance keyword (no AI dispatch)", async () => {
    openConvRef.current = { id: "conv-existing", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    inboundMessageRef.current = { id: "msg-1", direction: "inbound", content: "HELP" };
    const { handleInbound } = await import("./ai-scheduling-agent");
    const handled = await handleInbound({ contractorId: "c1", contactId: "ct1", messageId: "m1" });
    expect(handled).toBe(false);
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(bookAppointmentSpy).not.toHaveBeenCalled();
  });
});

describe("aiSchedulingAgent.takeOverConversation", () => {
  it("returns false when no open conversation exists", async () => {
    openConvRef.current = null;
    const { takeOverConversation } = await import("./ai-scheduling-agent");
    const ok = await takeOverConversation("c1", "ct1", "user-1");
    expect(ok).toBe(false);
  });

  it("flips an open conversation to handed_off and credits the user in the reason", async () => {
    openConvRef.current = { id: "conv-1", contractorId: "c1", contactId: "ct1", status: "active", exchangeCount: 1 };
    const { takeOverConversation } = await import("./ai-scheduling-agent");
    const ok = await takeOverConversation("c1", "ct1", "user-1");
    expect(ok).toBe(true);
    const handoffUpdate = updateConvSpy.mock.calls.find((c) => c[0]?.status === "handed_off");
    expect(handoffUpdate).toBeTruthy();
    expect(handoffUpdate?.[0]?.handoffReason).toContain("user-1");
  });
});
