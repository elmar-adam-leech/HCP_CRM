import type { Express, Response } from "express";
import { storage } from "../storage";
import { updateEmployeeRolesSchema } from "@shared/schema";
import { requireManagerOrAdmin, type AuthedRequest } from "../auth-service";
type AuthenticatedRequest = AuthedRequest;
import { asyncHandler } from "../utils/async-handler";
import { parseBody } from "../utils/validate-body";

export function registerEmployeeRoutes(app: Express): void {
  app.get("/api/employees", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const employees = await storage.getEmployees(req.user.contractorId);
    res.json(employees);
  }));

  app.patch("/api/employees/:id/roles", requireManagerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    
    const validation = parseBody(updateEmployeeRolesSchema, req, res);
    if (!validation) return;

    const { roles } = validation;
    
    // Update employee roles
    const updatedEmployee = await storage.updateEmployeeRoles(id, roles, req.user.contractorId);
    if (!updatedEmployee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    res.json(updatedEmployee);
  }));

  // Message routes for texting functionality
}
