import type { Express, Response } from "express";
import { z } from "zod";
import { db } from "../../db";
import { employees, userContractors, users } from "@shared/schema";
import { and, eq, asc } from "drizzle-orm";
import { requireIntegrationAccess, type AuthedRequest } from "../../auth-service";
import { asyncHandler } from "../../utils/async-handler";
import { parseBody } from "../../utils/validate-body";
import { logger } from "../../utils/logger";
import {
  backfillEstimateSalespeople,
  backfillJobSalespeople,
} from "../../sync/hcp-backfill-foundation";

const log = logger("HcpEmployeeMapping");

const linkBodySchema = z.object({
  userContractorId: z.string().min(1).nullable(),
});

export function registerHcpEmployeeMappingRoutes(app: Express): void {
  // List HCP-sourced employees for the current tenant, with their current
  // user_contractor link (if any) and the linked user's display info.
  app.get(
    "/api/integrations/hcp/employees",
    requireIntegrationAccess('housecall-pro'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const tenantId = req.user.contractorId;
      const rows = await db
        .select({
          id: employees.id,
          externalId: employees.externalId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          email: employees.email,
          isActive: employees.isActive,
          userContractorId: employees.userContractorId,
          linkedUserId: userContractors.userId,
          linkedName: users.name,
          linkedEmail: users.email,
          linkedIsSalesperson: userContractors.isSalesperson,
        })
        .from(employees)
        .leftJoin(userContractors, eq(userContractors.id, employees.userContractorId))
        .leftJoin(users, eq(users.id, userContractors.userId))
        .where(and(
          eq(employees.contractorId, tenantId),
          eq(employees.externalSource, "housecall-pro"),
        ))
        .orderBy(asc(employees.lastName), asc(employees.firstName));
      res.json(rows);
    }),
  );

  // List the user_contractor rows that admins can link an HCP employee to.
  // Filtered to is_salesperson = true so the dropdown matches the rest of the
  // app's salesperson selectors and prevents linking estimates to non-sales
  // users.
  app.get(
    "/api/integrations/hcp/salesperson-options",
    requireIntegrationAccess('housecall-pro'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const tenantId = req.user.contractorId;
      const rows = await db
        .select({
          userContractorId: userContractors.id,
          userId: userContractors.userId,
          name: users.name,
          email: users.email,
          isSalesperson: userContractors.isSalesperson,
          role: userContractors.role,
        })
        .from(userContractors)
        .innerJoin(users, eq(users.id, userContractors.userId))
        .where(and(
          eq(userContractors.contractorId, tenantId),
          eq(userContractors.isSalesperson, true),
        ))
        .orderBy(asc(users.name));
      res.json(rows);
    }),
  );

  // Link / unlink an HCP employee to a user_contractor in this tenant. Pass
  // userContractorId: null to clear the link.
  app.patch(
    "/api/integrations/hcp/employees/:id",
    requireIntegrationAccess('housecall-pro'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const tenantId = req.user.contractorId;
      const employeeId = req.params.id;
      const body = parseBody(linkBodySchema, req, res);
      if (!body) return;

      // Confirm the employee belongs to this tenant and is HCP-sourced.
      const empRows = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(
          eq(employees.id, employeeId),
          eq(employees.contractorId, tenantId),
          eq(employees.externalSource, "housecall-pro"),
        ))
        .limit(1);
      if (empRows.length === 0) {
        res.status(404).json({ message: "HCP employee not found for this tenant" });
        return;
      }

      // If a userContractorId was supplied, confirm it lives under this tenant.
      if (body.userContractorId) {
        const ucRows = await db
          .select({ id: userContractors.id })
          .from(userContractors)
          .where(and(
            eq(userContractors.id, body.userContractorId),
            eq(userContractors.contractorId, tenantId),
          ))
          .limit(1);
        if (ucRows.length === 0) {
          res.status(400).json({ message: "userContractorId does not belong to this tenant" });
          return;
        }
      }

      const updated = await db
        .update(employees)
        .set({ userContractorId: body.userContractorId, updatedAt: new Date() })
        .where(and(
          eq(employees.id, employeeId),
          eq(employees.contractorId, tenantId),
        ))
        .returning({
          id: employees.id,
          userContractorId: employees.userContractorId,
        });
      res.json(updated[0] ?? null);
    }),
  );

  // Backfill salesperson assignments for existing estimates and jobs in this
  // tenant. Returns the count of rows updated for each entity.
  app.post(
    "/api/integrations/hcp/backfill-assignments",
    requireIntegrationAccess('housecall-pro'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const tenantId = req.user.contractorId;
      log.info(`[backfill-assignments] starting for tenant=${tenantId}`);
      const estimatesUpdated = await backfillEstimateSalespeople(tenantId);
      const jobsUpdated = await backfillJobSalespeople(tenantId);
      log.info(`[backfill-assignments] tenant=${tenantId} estimates=${estimatesUpdated} jobs=${jobsUpdated}`);
      res.json({ estimatesUpdated, jobsUpdated });
    }),
  );
}
