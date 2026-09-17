import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-other";

const listPendingMock = vi.fn();
const getParseFailureMock = vi.fn();
const getLeadCaptureInboxMock = vi.fn();
const syncLeadCaptureInboxMock = vi.fn();
const getSpamAuditEntryMock = vi.fn();
const markSpamAuditRecoveredMock = vi.fn();
const parseEmailWithAIMock = vi.fn();
const normalizePhoneForStorageMock = vi.fn();
const ingestLeadMock = vi.fn();

// email-parse-failures normally imports the live database at module evaluation
// time. Keep this endpoint test isolated from database configuration.
vi.mock("../db", () => ({ db: {} }));

vi.mock("../storage/email-parse-failures", () => ({
  emailParseFailureStore: {
    listPending: (...args: unknown[]) => listPendingMock(...args),
    get: (...args: unknown[]) => getParseFailureMock(...args),
    record: vi.fn(),
    resolve: vi.fn(),
  },
}));

vi.mock("../storage", () => ({
  storage: {
    getLeadCaptureInbox: (...args: unknown[]) => getLeadCaptureInboxMock(...args),
    getSpamAuditEntry: (...args: unknown[]) => getSpamAuditEntryMock(...args),
    markSpamAuditRecovered: (...args: unknown[]) => markSpamAuditRecoveredMock(...args),
    deleteLeadCaptureInbox: vi.fn(),
    disableTenantIntegration: vi.fn(),
    updateLeadCaptureInboxSpamFilter: vi.fn(),
    getSenderRules: vi.fn(),
    addSenderRule: vi.fn(),
    deleteSenderRule: vi.fn(),
    updateSpamConfidenceThreshold: vi.fn(),
    getSpamAuditLog: vi.fn(),
    deleteSpamAuditLogEntry: vi.fn(),
    deleteAllUnrecoveredSpamAuditLog: vi.fn(),
  },
}));

vi.mock("../gmail-service", () => ({
  gmailService: {
    isConfigured: () => false,
    validateEncryptionKey: () => {},
    validateHost: () => true,
    generateAuthUrl: () => "",
  },
}));

vi.mock("../auth-service", () => ({
  requireManagerOrAdmin: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(req as any).user) {
      res.status(401).json({ message: "unauthorized" });
      return;
    }
    next();
  },
}));

vi.mock("../services/lead-capture-sync", () => ({
  syncLeadCaptureInbox: (...args: unknown[]) => syncLeadCaptureInboxMock(...args),
}));

vi.mock("../services/email-ai-parser", () => ({
  parseEmailWithAI: (...args: unknown[]) => parseEmailWithAIMock(...args),
}));

vi.mock("../utils/phone-normalizer", () => ({
  normalizePhoneForStorage: (...args: unknown[]) => normalizePhoneForStorageMock(...args),
}));

vi.mock("../services/lead-ingestion", () => ({
  ingestLead: (...args: unknown[]) => ingestLeadMock(...args),
}));

vi.mock("../sync-scheduler", () => ({
  syncScheduler: { onIntegrationDisabled: vi.fn() },
}));

vi.mock("../utils/async-handler", () => ({
  asyncHandler: (fn: express.RequestHandler) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    },
}));

import { registerLeadCaptureRoutes } from "../routes/lead-capture";

let server: http.Server | undefined;
let baseUrl = "";

const email = {
  id: "gmail-message-1",
  threadId: "thread-1",
  from: "Customer <customer@example.com>",
  subject: "Broken furnace",
  body: "Please repair my furnace.",
  date: "2026-01-02T03:04:05.000Z",
};

function parseFailure(overrides: Record<string, unknown> = {}) {
  return {
    id: "failure-1",
    contractorId: TENANT,
    inboxId: "inbox-1",
    messageId: email.id,
    email,
    errorCode: "api_error",
    errorMessage: "Parser unavailable",
    attempts: 1,
    resolvedAt: null,
    ...overrides,
  };
}

function spamAuditEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    contractorId: TENANT,
    senderEmail: "sender@example.com",
    subject: "New HVAC request",
    body: "My furnace is broken.",
    recoveredAt: null,
    ...overrides,
  };
}

async function startApp(opts?: { user?: { contractorId: string; userId: string } | null }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts?.user !== null) {
      (req as any).user = opts?.user ?? { contractorId: TENANT, userId: "u1" };
    }
    next();
  });
  registerLeadCaptureRoutes(app);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: err.message });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  normalizePhoneForStorageMock.mockImplementation((phone: string) => phone);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()),
    );
  }
  server = undefined;
});

describe("GET /api/settings/lead-capture-inbox/parse-failures", () => {
  it("requires authentication without querying pending failures", async () => {
    await startApp({ user: null });

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/parse-failures`);

    expect(res.status).toBe(401);
    expect(listPendingMock).not.toHaveBeenCalled();
  });

  it("returns pending entries scoped to the authenticated tenant", async () => {
    const entries = [parseFailure()];
    listPendingMock.mockResolvedValue(entries);
    await startApp({ user: { contractorId: OTHER_TENANT, userId: "u2" } });

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/parse-failures`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries, total: 1 });
    expect(listPendingMock).toHaveBeenCalledWith(OTHER_TENANT);
  });
});

describe("POST /api/settings/lead-capture-inbox/parse-failures/:id/retry", () => {
  it("returns 404 for a foreign id without looking up an inbox or processing", async () => {
    getParseFailureMock.mockResolvedValue(undefined);
    await startApp({ user: { contractorId: OTHER_TENANT, userId: "u2" } });

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/parse-failures/failure-1/retry`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Email needing review not found" });
    expect(getParseFailureMock).toHaveBeenCalledWith("failure-1", OTHER_TENANT);
    expect(getLeadCaptureInboxMock).not.toHaveBeenCalled();
    expect(syncLeadCaptureInboxMock).not.toHaveBeenCalled();
  });

  it("retries only against the matching inbox in the authenticated tenant", async () => {
    const entry = parseFailure();
    const inbox = { id: "inbox-1", contractorId: TENANT, emailAddress: "capture@example.com" };
    const stats = { processed: 1, skippedSpam: 0, skippedBlocked: 0, parseFailed: 0, errors: 0 };
    getParseFailureMock.mockResolvedValue(entry);
    getLeadCaptureInboxMock.mockResolvedValue(inbox);
    syncLeadCaptureInboxMock.mockResolvedValue(stats);
    await startApp();

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/parse-failures/failure-1/retry`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, ...stats });
    expect(getParseFailureMock).toHaveBeenCalledWith("failure-1", TENANT);
    expect(getLeadCaptureInboxMock).toHaveBeenCalledWith(TENANT);
    expect(syncLeadCaptureInboxMock).toHaveBeenCalledWith(inbox, email);
  });

  it.each([
    ["a disconnected inbox", null],
    ["a different current inbox", { id: "inbox-2", contractorId: TENANT }],
  ])("retains the failure and returns 409 for %s", async (_label, inbox) => {
    getParseFailureMock.mockResolvedValue(parseFailure());
    getLeadCaptureInboxMock.mockResolvedValue(inbox);
    await startApp();

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/parse-failures/failure-1/retry`, {
      method: "POST",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: "This email belongs to a disconnected inbox. Its contents are retained for manual review.",
    });
    expect(syncLeadCaptureInboxMock).not.toHaveBeenCalled();
  });

  it("returns alreadyResolved without looking up an inbox or processing", async () => {
    getParseFailureMock.mockResolvedValue(parseFailure({ resolvedAt: "2026-01-03T00:00:00.000Z" }));
    await startApp();

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/parse-failures/failure-1/retry`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, alreadyResolved: true });
    expect(getLeadCaptureInboxMock).not.toHaveBeenCalled();
    expect(syncLeadCaptureInboxMock).not.toHaveBeenCalled();
  });

  it("returns explicit 422 failure details and stats when parsing fails again", async () => {
    const inbox = { id: "inbox-1", contractorId: TENANT };
    const stats = { processed: 0, skippedSpam: 0, skippedBlocked: 0, parseFailed: 1, errors: 0 };
    getParseFailureMock.mockResolvedValue(parseFailure());
    getLeadCaptureInboxMock.mockResolvedValue(inbox);
    syncLeadCaptureInboxMock.mockResolvedValue(stats);
    await startApp();

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/parse-failures/failure-1/retry`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body).toEqual({
      ...stats,
      status: "failed",
      message: "AI parsing failed again. The email is still saved for review and has not been marked as spam.",
    });
    expect(syncLeadCaptureInboxMock).toHaveBeenCalledWith(inbox, email);
  });
});

describe("POST /api/settings/lead-capture-inbox/spam-audit-log/:id/recover", () => {
  it("reuses the original email identity for concurrent and recreated audit recoveries", async () => {
    getSpamAuditEntryMock.mockImplementation(async (id: string) =>
      spamAuditEntry({ id, messageId: "gmail-original-1", inboxId: "inbox-1" }));
    parseEmailWithAIMock.mockResolvedValue({
      status: "success", isSpam: false, name: "Taylor Homeowner", email: "taylor@example.com",
    });
    ingestLeadMock.mockResolvedValue({ lead: { id: "lead-original" } });
    await startApp();
    const results = await Promise.all(["audit-1", "audit-1", "audit-recreated"].map(id =>
      fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log/${id}/recover`, { method: "POST" })));
    expect(results.every(res => res.status === 200)).toBe(true);
    expect(ingestLeadMock).toHaveBeenCalledTimes(3);
    for (const [contractorId, input] of ingestLeadMock.mock.calls) {
      expect(contractorId).toBe(TENANT);
      expect(input).toMatchObject({
        submissionId: "gmail-original-1",
        activityExternalId: "gmail-original-1",
        identityPolicy: "two-field",
        source: "email_capture",
      });
    }
  });

  it("retains the audit entry when parsing fails without ingesting or marking it recovered", async () => {
    getSpamAuditEntryMock.mockResolvedValue(spamAuditEntry());
    parseEmailWithAIMock.mockResolvedValue({
      status: "failed",
      errorCode: "api_error",
      message: "AI parser unavailable.",
    });
    await startApp();

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log/audit-1/recover`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.status).toBe("failed");
    expect(body.errorCode).toBe("api_error");
    expect(body.message).toContain("still saved for review");
    expect(parseEmailWithAIMock).toHaveBeenCalledWith("New HVAC request", "My furnace is broken.");
    expect(ingestLeadMock).not.toHaveBeenCalled();
    expect(markSpamAuditRecoveredMock).not.toHaveBeenCalled();
  });

  it("uses stable submission and activity identities with the two-field identity policy", async () => {
    getSpamAuditEntryMock.mockResolvedValue(spamAuditEntry());
    parseEmailWithAIMock.mockResolvedValue({
      status: "success",
      isSpam: false,
      name: "Taylor Homeowner",
      email: "taylor@example.com",
      phone: "(555) 123-4567",
      serviceDescription: "Furnace repair",
    });
    normalizePhoneForStorageMock.mockReturnValue("+15551234567");
    ingestLeadMock.mockResolvedValue({ lead: { id: "lead-9" } });
    markSpamAuditRecoveredMock.mockResolvedValue(undefined);
    await startApp();

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log/audit-1/recover`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, leadId: "lead-9" });
    expect(ingestLeadMock).toHaveBeenCalledWith(TENANT, expect.objectContaining({
      name: "Taylor Homeowner",
      emails: ["taylor@example.com"],
      phones: ["+15551234567"],
      source: "email_capture",
      message: "Furnace repair",
      submissionId: "spam-audit:audit-1",
      identityPolicy: "two-field",
      activityExternalId: "spam-audit:audit-1",
      activityNote: "**Email Subject:** New HVAC request\n\nMy furnace is broken.",
      skipDuplicateLeadWithinHours: 0,
      skipAutoAssign: false,
      ipAddress: expect.any(String),
    }));
    expect(markSpamAuditRecoveredMock).toHaveBeenCalledWith("audit-1", TENANT, "lead-9");
  });

  it("does not parse or ingest an already recovered entry", async () => {
    getSpamAuditEntryMock.mockResolvedValue(spamAuditEntry({
      recoveredAt: "2026-01-03T00:00:00.000Z",
      recoveredLeadId: "lead-existing",
    }));
    await startApp();

    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log/audit-1/recover`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "This entry has already been recovered" });
    expect(parseEmailWithAIMock).not.toHaveBeenCalled();
    expect(ingestLeadMock).not.toHaveBeenCalled();
    expect(markSpamAuditRecoveredMock).not.toHaveBeenCalled();
  });
});