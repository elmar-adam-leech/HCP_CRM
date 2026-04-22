import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { storage } from "../storage";
import { users, userContractors, contractors } from "@shared/schema";
import { db } from "../db";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";

import { requireManagerOrAdmin, requireAdmin } from "../auth-service";
import { cacheInvalidation } from "../services/cache";
import bcrypt from "bcrypt";
import { parseBody } from "../utils/validate-body";

async function generateUniqueUsername(email: string): Promise<string> {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '_');
  let candidate = base;
  let existing = await storage.getUserByUsername(candidate);
  while (existing) {
    candidate = `${base}_${crypto.randomBytes(3).toString('hex')}`;
    existing = await storage.getUserByUsername(candidate);
  }
  return candidate;
}

const createUserBodySchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Invalid email format").max(500),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role: z.enum(['user', 'manager', 'admin']).optional(),
});

export function registerUserRoutes(app: Express): void {
  app.get("/api/users", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const contractorUsers = await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        email: users.email,
        role: userContractors.role,
        contractorId: userContractors.contractorId,
        dialpadDefaultNumber: userContractors.dialpadDefaultNumber,
        canManageIntegrations: userContractors.canManageIntegrations,
        allowedIntegrations: userContractors.allowedIntegrations,
        mfaEnabled: users.mfaEnabled,
        createdAt: users.createdAt
      })
      .from(userContractors)
      .innerJoin(users, eq(userContractors.userId, users.id))
      .where(eq(userContractors.contractorId, req.user.contractorId));

    res.json(contractorUsers);
  }));

  app.post("/api/users", requireAdmin, asyncHandler(async (req, res) => {
    const parseResult = parseBody(createUserBodySchema, req, res);
    if (!parseResult) return;
    const { name, email, password, role } = parseResult;

    if ((role as string) === 'super_admin' && req.user.role !== 'super_admin') {
      res.status(403).json({ message: "Only super admins can create super admin accounts" });
      return;
    }

    const existingUserForContractor = await storage.getUserByEmailAndContractor(email, req.user.contractorId);
    if (existingUserForContractor) {
      res.status(400).json({ message: "User with this email already exists in your organization" });
      return;
    }

    const existingGlobalUser = await storage.getUserByEmail(email);

    if (existingGlobalUser) {
      const isPasswordValid = await bcrypt.compare(password, existingGlobalUser.password);
      if (!isPasswordValid) {
        res.status(401).json({ message: "Invalid password for existing account" });
        return;
      }
      await storage.addUserToContractor({
        userId: existingGlobalUser.id,
        contractorId: req.user.contractorId,
        role: role || 'user',
        canManageIntegrations: role === 'admin' || (role as string) === 'super_admin',
      });
      cacheInvalidation.invalidateUser(existingGlobalUser.id);
      res.status(201).json({
        id: existingGlobalUser.id,
        name: existingGlobalUser.name,
        email: existingGlobalUser.email,
        role: role || 'user',
        contractorId: req.user.contractorId,
        createdAt: existingGlobalUser.createdAt,
        message: "Existing user added to organization"
      });
      return;
    }

    const username = await generateUniqueUsername(email);
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await db.insert(users).values({
      name,
      email,
      username,
      password: hashedPassword,
      role: role || 'user',
      contractorId: req.user.contractorId
    }).returning().then(result => result[0]);

    await storage.addUserToContractor({
      userId: newUser.id,
      contractorId: req.user.contractorId,
      role: role || 'user',
      canManageIntegrations: role === 'admin' || (role as string) === 'super_admin',
    });

    cacheInvalidation.invalidateUser(newUser.id);

    res.status(201).json({
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: role || 'user',
      contractorId: req.user.contractorId,
      createdAt: newUser.createdAt
    });
  }));

  app.patch("/api/users/:userId/role", requireAdmin, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { role } = req.body;

    const isSuperAdmin = req.user.role === 'super_admin';
    const allowedRoles = isSuperAdmin ? ['user', 'manager', 'admin', 'super_admin'] : ['user', 'manager', 'admin'];

    if (!role || !allowedRoles.includes(role)) {
      const rolesDescription = isSuperAdmin ? 'user, manager, admin, or super_admin' : 'user, manager, or admin';
      res.status(400).json({ message: `Invalid role. Must be ${rolesDescription}` });
      return;
    }

    const userContractor = await db.select().from(userContractors)
      .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, req.user.contractorId)))
      .limit(1);

    if (userContractor.length === 0) {
      res.status(404).json({ message: "User not found in your organization" });
      return;
    }

    const updated = await db.update(userContractors)
      .set({ role })
      .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, req.user.contractorId)))
      .returning();

    // Bump tokenVersion so existing JWTs for this user are immediately rejected.
    // This ensures a demoted/promoted user cannot retain stale privileges via
    // a cached token — the very next request will fail the tokenVersion check.
    await db.update(users)
      .set({ tokenVersion: sql`token_version + 1` })
      .where(eq(users.id, userId));

    // Immediately evict the affected user's entries from the in-process cache
    // so the new role and tokenVersion are visible on the very next request,
    // rather than after the 5-minute cache TTL expires.
    cacheInvalidation.invalidateUserContractor(userId, req.user.contractorId);
    cacheInvalidation.invalidateUser(userId);

    res.json({
      userId: updated[0].userId,
      role: updated[0].role,
      contractorId: updated[0].contractorId,
      message: "User role updated successfully"
    });
  }));

  app.patch("/api/users/:userId/dialpad-number", requireAdmin, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const dialpadNumberSchema = z.object({
      dialpadDefaultNumber: z.string().nullable().optional(),
    });
    const parsed = parseBody(dialpadNumberSchema, req, res);
    if (!parsed) return;
    const { dialpadDefaultNumber } = parsed;

    const targetUser = await db.select().from(users)
      .where(and(eq(users.id, userId), eq(users.contractorId, req.user.contractorId)))
      .limit(1);

    if (!targetUser[0]) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const updated = await db.update(users)
      .set({ dialpadDefaultNumber })
      .where(eq(users.id, userId))
      .returning();

    cacheInvalidation.invalidateUser(userId);

    if (dialpadDefaultNumber && targetUser[0].role !== 'admin' && targetUser[0].role !== 'manager') {
      const phoneNumber = await storage.getDialpadPhoneNumberByNumber(req.user.contractorId, dialpadDefaultNumber);
      if (phoneNumber) {
        const existingPermission = await storage.getUserPhoneNumberPermission(userId, phoneNumber.id);
        if (existingPermission) {
          await storage.updateUserPhoneNumberPermission(existingPermission.id, {
            canSendSms: true,
            canMakeCalls: true,
            isActive: true
          });
        } else {
          await storage.createUserPhoneNumberPermission({
            contractorId: req.user.contractorId,
            userId: userId,
            phoneNumberId: phoneNumber.id,
            canSendSms: true,
            canMakeCalls: true,
            isActive: true
          });
        }
      }
    }

    res.json({
      id: updated[0].id,
      username: updated[0].username,
      name: updated[0].name,
      email: updated[0].email,
      role: updated[0].role,
      contractorId: updated[0].contractorId,
      dialpadDefaultNumber: updated[0].dialpadDefaultNumber,
      message: "Dialpad phone number updated successfully"
    });
  }));

  app.get("/api/users/:userId", asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const contractorId = req.user.contractorId;

    const user = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
      .from(users)
      .where(and(
        eq(users.id, userId),
        eq(users.contractorId, contractorId)
      ))
      .limit(1);

    if (user.length === 0) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json(user[0]);
  }));

  app.get("/api/users/gmail-connected", asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;

    const gmailUsers = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
      .from(users)
      .where(and(
        eq(users.contractorId, contractorId),
        isNotNull(users.gmailRefreshToken)
      ));

    res.json(gmailUsers);
  }));

  app.patch("/api/users/:userId", requireAdmin, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { role, canManageIntegrations, allowedIntegrations } = req.body;

    const isSuperAdmin = req.user.role === 'super_admin';
    const allowedRoles = isSuperAdmin ? ['user', 'manager', 'admin', 'super_admin'] : ['user', 'manager', 'admin'];

    if (role !== undefined && !allowedRoles.includes(role)) {
      const rolesDescription = isSuperAdmin ? 'user, manager, admin, or super_admin' : 'user, manager, or admin';
      res.status(400).json({ message: `Invalid role. Must be ${rolesDescription}` });
      return;
    }

    if (canManageIntegrations !== undefined && typeof canManageIntegrations !== 'boolean') {
      res.status(400).json({ message: "canManageIntegrations must be a boolean" });
      return;
    }

    if (allowedIntegrations !== undefined && allowedIntegrations !== null && !Array.isArray(allowedIntegrations)) {
      res.status(400).json({ message: "allowedIntegrations must be an array or null" });
      return;
    }

    const userContractor = await db.select().from(userContractors)
      .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, req.user.contractorId)))
      .limit(1);

    if (userContractor.length === 0) {
      res.status(404).json({ message: "User not found in your organization" });
      return;
    }

    const updateFields: Record<string, unknown> = {};
    if (role !== undefined) updateFields.role = role;
    if (canManageIntegrations !== undefined) updateFields.canManageIntegrations = canManageIntegrations;
    if (allowedIntegrations !== undefined) updateFields.allowedIntegrations = allowedIntegrations;

    const updated = await db.update(userContractors)
      .set(updateFields)
      .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, req.user.contractorId)))
      .returning();

    cacheInvalidation.invalidateUserContractor(userId, req.user.contractorId);
    cacheInvalidation.invalidateUser(userId);

    res.json({
      userId,
      role: updated[0].role,
      canManageIntegrations: updated[0].canManageIntegrations,
      allowedIntegrations: updated[0].allowedIntegrations ?? null,
      message: "User updated successfully",
    });
  }));

  app.patch("/api/users/:userId/integration-permission", requireAdmin, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { canManageIntegrations } = req.body;

    if (typeof canManageIntegrations !== 'boolean') {
      res.status(400).json({ message: "canManageIntegrations must be a boolean" });
      return;
    }

    const existing = await db.select().from(userContractors)
      .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, req.user.contractorId)))
      .limit(1);

    if (!existing[0]) {
      res.status(404).json({ message: "User not found in your organization" });
      return;
    }

    const updated = await db.update(userContractors)
      .set({ canManageIntegrations })
      .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, req.user.contractorId)))
      .returning();

    cacheInvalidation.invalidateUserContractor(userId, req.user.contractorId);
    cacheInvalidation.invalidateUser(userId);

    res.json({
      userId,
      canManageIntegrations: updated[0].canManageIntegrations,
      message: "Integration permission updated successfully"
    });
  }));

  app.get("/api/users/me/dialpad-default-number", asyncHandler(async (req, res) => {
    const user = await db.select().from(users).where(eq(users.id, req.user.userId)).limit(1);
    if (!user[0]) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ dialpadDefaultNumber: user[0].dialpadDefaultNumber || null });
  }));

  app.put("/api/users/me/dialpad-default-number", asyncHandler(async (req, res) => {
    const { dialpadDefaultNumber } = req.body;

    if (dialpadDefaultNumber !== null && typeof dialpadDefaultNumber !== 'string') {
      res.status(400).json({ message: "Invalid phone number format" });
      return;
    }

    const result = await db
      .update(users)
      .set({ dialpadDefaultNumber: dialpadDefaultNumber || null })
      .where(eq(users.id, req.user.userId))
      .returning();

    if (!result[0]) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    cacheInvalidation.invalidateUser(req.user.userId);

    res.json({
      dialpadDefaultNumber: result[0].dialpadDefaultNumber,
      message: dialpadDefaultNumber ? "Default number updated successfully" : "Default number cleared successfully"
    });
  }));

  app.put("/api/users/:userId/dialpad-default-number", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { dialpadDefaultNumber } = req.body;

    if (dialpadDefaultNumber !== null && typeof dialpadDefaultNumber !== 'string') {
      res.status(400).json({ message: "Invalid phone number format" });
      return;
    }

    const targetUser = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!targetUser[0]) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    if (targetUser[0].contractorId !== req.user.contractorId) {
      res.status(403).json({ message: "Cannot modify users from other contractors" });
      return;
    }

    const result = await db
      .update(users)
      .set({ dialpadDefaultNumber: dialpadDefaultNumber || null })
      .where(eq(users.id, userId))
      .returning();

    cacheInvalidation.invalidateUser(userId);

    res.json({
      dialpadDefaultNumber: result[0].dialpadDefaultNumber,
      message: dialpadDefaultNumber ? "Default number updated successfully" : "Default number cleared successfully"
    });
  }));

  app.get("/api/contractor/dialpad-default-number", asyncHandler(async (req, res) => {
    const contractor = await db.select().from(contractors)
      .where(eq(contractors.id, req.user.contractorId))
      .limit(1);

    if (!contractor[0]) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }

    res.json({ defaultDialpadNumber: contractor[0].defaultDialpadNumber || null });
  }));

  app.put("/api/contractor/dialpad-default-number", requireAdmin, asyncHandler(async (req, res) => {
    const { defaultDialpadNumber } = req.body;

    if (defaultDialpadNumber !== null && typeof defaultDialpadNumber !== 'string') {
      res.status(400).json({ message: "Invalid phone number format" });
      return;
    }

    const result = await db
      .update(contractors)
      .set({ defaultDialpadNumber: defaultDialpadNumber || null })
      .where(eq(contractors.id, req.user.contractorId))
      .returning();

    if (!result[0]) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }

    res.json({
      defaultDialpadNumber: result[0].defaultDialpadNumber,
      message: defaultDialpadNumber ? "Organization default number updated successfully" : "Organization default number cleared successfully"
    });
  }));

  app.patch("/api/user/call-preference", asyncHandler(async (req, res) => {
    const { callPreference } = req.body;
    if (callPreference !== 'integration' && callPreference !== 'personal') {
      res.status(400).json({ message: "callPreference must be 'integration' or 'personal'" });
      return;
    }

    const result = await db
      .update(userContractors)
      .set({ callPreference })
      .where(and(
        eq(userContractors.userId, req.user.userId),
        eq(userContractors.contractorId, req.user.contractorId)
      ))
      .returning();

    if (!result[0]) {
      res.status(404).json({ message: "User contractor record not found" });
      return;
    }

    cacheInvalidation.invalidateUserContractor(req.user.userId, req.user.contractorId);

    res.json({ callPreference: result[0].callPreference, message: "Call preference updated" });
  }));
}
