import {
  type Employee, type InsertEmployee,
  employees,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
import type { UpdateEmployee } from "../storage-types";
import { mapExternalRoleToInternalRoles } from "../utils/role-mapper";

async function getEmployees(contractorId: string): Promise<Employee[]> {
  return await db.select().from(employees)
    .where(eq(employees.contractorId, contractorId))
    .orderBy(asc(employees.lastName), asc(employees.firstName))
    .limit(500);
}

async function getEmployee(id: string, contractorId: string): Promise<Employee | undefined> {
  const result = await db.select().from(employees).where(and(eq(employees.id, id), eq(employees.contractorId, contractorId))).limit(1);
  return result[0];
}

async function getEmployeeByExternalId(externalId: string, externalSource: string, contractorId: string): Promise<Employee | undefined> {
  const result = await db.select().from(employees).where(and(
    eq(employees.externalId, externalId),
    eq(employees.externalSource, externalSource),
    eq(employees.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function upsertEmployees(employeeData: Omit<InsertEmployee, 'contractorId'>[], contractorId: string): Promise<Employee[]> {
  if (employeeData.length === 0) return [];

  const externalIds = employeeData
    .filter(e => e.externalId && e.externalSource)
    .map(e => e.externalId as string);

  const existingMap = new Map<string, Employee>();
  if (externalIds.length > 0) {
    const existing = await db.select().from(employees).where(
      and(
        eq(employees.contractorId, contractorId),
        inArray(employees.externalId, externalIds)
      )
    );
    for (const emp of existing) {
      if (emp.externalId) existingMap.set(emp.externalId, emp);
    }
  }

  const toInsert: (typeof employees.$inferInsert)[] = [];
  const toUpdate: { id: string; data: UpdateEmployee }[] = [];

  for (const empData of employeeData) {
    const existingEmployee = empData.externalId ? existingMap.get(empData.externalId) : undefined;
    if (existingEmployee) {
      toUpdate.push({
        id: existingEmployee.id,
        data: {
          firstName: empData.firstName,
          lastName: empData.lastName,
          email: empData.email,
          isActive: empData.isActive,
          externalRole: empData.externalRole,
          ...(existingEmployee.roles.length === 0 && empData.externalRole ? {
            roles: mapExternalRoleToInternalRoles(empData.externalRole)
          } : {})
        }
      });
    } else {
      toInsert.push({
        ...empData,
        contractorId,
        roles: empData.externalRole ? mapExternalRoleToInternalRoles(empData.externalRole) : [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  const results: Employee[] = [];

  if (toInsert.length > 0) {
    const inserted = await db.insert(employees).values(toInsert).returning();
    results.push(...inserted);
  }

  if (toUpdate.length > 0) {
    // Build a single bulk upsert instead of N sequential UPDATE calls.
    // All employees are written in one database round-trip regardless of list size.
    const upsertRows = toUpdate.map(({ id, data }) => ({
      id,
      contractorId,
      firstName: data.firstName ?? '',
      lastName: data.lastName ?? '',
      email: data.email ?? null,
      isActive: data.isActive ?? true,
      externalRole: data.externalRole ?? null,
      ...(data.roles ? { roles: data.roles } : {}),
      updatedAt: new Date(),
    }));
    const upserted = await db.insert(employees)
      .values(upsertRows)
      .onConflictDoUpdate({
        target: employees.id,
        set: {
          firstName: sql`excluded.first_name`,
          lastName: sql`excluded.last_name`,
          email: sql`excluded.email`,
          isActive: sql`excluded.is_active`,
          externalRole: sql`excluded.external_role`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();
    results.push(...upserted);
  }

  return results;
}

async function updateEmployeeRoles(id: string, roles: string[], contractorId: string): Promise<Employee | undefined> {
  const result = await db.update(employees).set({ roles, updatedAt: new Date() }).where(and(eq(employees.id, id), eq(employees.contractorId, contractorId))).returning();
  return result[0];
}

export const employeeMethods = {
  getEmployees,
  getEmployee,
  getEmployeeByExternalId,
  upsertEmployees,
  updateEmployeeRoles,
};
