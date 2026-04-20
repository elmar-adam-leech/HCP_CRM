import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-other";

const deleteSpamAuditLogEntryMock = vi.fn();
const deleteAllUnrecoveredSpamAuditLogMock = vi.fn();

vi.mock("../storage", () => ({
  storage: {
    deleteSpamAuditLogEntry: (cid: string, id: string) => deleteSpamAuditLogEntryMock(cid, id),
    deleteAllUnrecoveredSpamAuditLog: (cid: string) => deleteAllUnrecoveredSpamAuditLogMock(cid),
    getLeadCaptureInbox: vi.fn(),
    deleteLeadCaptureInbox: vi.fn(),
    disableTenantIntegration: vi.fn(),
    updateLeadCaptureInboxSpamFilter: vi.fn(),
    getSenderRules: vi.fn(),
    addSenderRule: vi.fn(),
    deleteSenderRule: vi.fn(),
    updateSpamConfidenceThreshold: vi.fn(),
    getSpamAuditLog: vi.fn(),
    getSpamAuditEntry: vi.fn(),
    markSpamAuditRecovered: vi.fn(),
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
  syncLeadCaptureInbox: vi.fn(),
}));

vi.mock("../sync-scheduler", () => ({
  syncScheduler: { onIntegrationDisabled: vi.fn() },
}));

vi.mock("../services/lead-ingestion", () => ({
  ingestLead: vi.fn(),
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
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ message: err.message });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => {
  deleteSpamAuditLogEntryMock.mockReset();
  deleteAllUnrecoveredSpamAuditLogMock.mockReset();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
});

describe("DELETE /api/settings/lead-capture-inbox/spam-audit-log/:id", () => {
  it("requires authentication", async () => {
    await startApp({ user: null });
    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log/abc`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    expect(deleteSpamAuditLogEntryMock).not.toHaveBeenCalled();
  });

  it("scopes the delete by the authed contractor and returns deleted=1", async () => {
    deleteSpamAuditLogEntryMock.mockResolvedValue(1);
    await startApp();
    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log/entry-1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(deleteSpamAuditLogEntryMock).toHaveBeenCalledWith(TENANT, "entry-1");
  });

  it("returns 404 when the entry does not belong to the requesting contractor", async () => {
    deleteSpamAuditLogEntryMock.mockResolvedValue(0);
    await startApp({ user: { contractorId: OTHER_TENANT, userId: "u2" } });
    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log/entry-1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(deleteSpamAuditLogEntryMock).toHaveBeenCalledWith(OTHER_TENANT, "entry-1");
  });
});

describe("DELETE /api/settings/lead-capture-inbox/spam-audit-log", () => {
  it("requires authentication", async () => {
    await startApp({ user: null });
    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    expect(deleteAllUnrecoveredSpamAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns the deleted count and is scoped to the authed contractor", async () => {
    deleteAllUnrecoveredSpamAuditLogMock.mockResolvedValue(7);
    await startApp();
    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 7 });
    expect(deleteAllUnrecoveredSpamAuditLogMock).toHaveBeenCalledTimes(1);
    expect(deleteAllUnrecoveredSpamAuditLogMock).toHaveBeenCalledWith(TENANT);
  });

  it("uses the requesting contractor id (cross-tenant isolation)", async () => {
    deleteAllUnrecoveredSpamAuditLogMock.mockResolvedValue(0);
    await startApp({ user: { contractorId: OTHER_TENANT, userId: "u2" } });
    const res = await fetch(`${baseUrl}/api/settings/lead-capture-inbox/spam-audit-log`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(deleteAllUnrecoveredSpamAuditLogMock).toHaveBeenCalledWith(OTHER_TENANT);
  });
});
