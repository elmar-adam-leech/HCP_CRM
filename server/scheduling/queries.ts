import { db } from '../db';
import { users, userContractors, scheduledBookings } from '@shared/schema';
import { eq, and, gte, lte, asc } from 'drizzle-orm';
import type { SalespersonInfo } from '../types/scheduling';

export async function getSalespeople(tenantId: string): Promise<SalespersonInfo[]> {
  const salespeople = await db.select({
    userId: userContractors.userId,
    name: users.name,
    email: users.email,
    housecallProUserId: userContractors.housecallProUserId,
    lastAssignmentAt: userContractors.lastAssignmentAt,
    calendarColor: userContractors.calendarColor,
    isSalesperson: userContractors.isSalesperson,
    workingDays: userContractors.workingDays,
    workingHoursStart: userContractors.workingHoursStart,
    workingHoursEnd: userContractors.workingHoursEnd,
    hasCustomSchedule: userContractors.hasCustomSchedule,
    displayOrder: userContractors.displayOrder,
  })
  .from(userContractors)
  .innerJoin(users, eq(users.id, userContractors.userId))
  .where(and(
    eq(userContractors.contractorId, tenantId),
    eq(userContractors.isSalesperson, true)
  ));

  return salespeople.map(sp => ({
    ...sp,
    isSalesperson: sp.isSalesperson ?? false,
    workingDays: (sp.workingDays && sp.workingDays.length > 0) ? sp.workingDays : (sp.hasCustomSchedule ? sp.workingDays ?? [] : [1, 2, 3, 4, 5]),
    workingHoursStart: sp.workingHoursStart ?? "08:00",
    workingHoursEnd: sp.workingHoursEnd ?? "17:00",
    hasCustomSchedule: sp.hasCustomSchedule ?? false,
    displayOrder: sp.displayOrder ?? null,
  }));
}

export async function getTeamMembers(tenantId: string): Promise<SalespersonInfo[]> {
  const members = await db.select({
    userId: userContractors.userId,
    name: users.name,
    email: users.email,
    housecallProUserId: userContractors.housecallProUserId,
    lastAssignmentAt: userContractors.lastAssignmentAt,
    calendarColor: userContractors.calendarColor,
    isSalesperson: userContractors.isSalesperson,
    workingDays: userContractors.workingDays,
    workingHoursStart: userContractors.workingHoursStart,
    workingHoursEnd: userContractors.workingHoursEnd,
    hasCustomSchedule: userContractors.hasCustomSchedule,
    displayOrder: userContractors.displayOrder,
  })
  .from(userContractors)
  .innerJoin(users, eq(users.id, userContractors.userId))
  .where(eq(userContractors.contractorId, tenantId));

  return members.map(m => ({
    ...m,
    isSalesperson: m.isSalesperson ?? false,
    workingDays: (m.workingDays && m.workingDays.length > 0) ? m.workingDays : (m.hasCustomSchedule ? m.workingDays ?? [] : [1, 2, 3, 4, 5]),
    workingHoursStart: m.workingHoursStart ?? "08:00",
    workingHoursEnd: m.workingHoursEnd ?? "17:00",
    hasCustomSchedule: m.hasCustomSchedule ?? false,
    displayOrder: m.displayOrder ?? null,
  }));
}

export async function getBookings(
  tenantId: string,
  startDate?: Date,
  endDate?: Date
): Promise<{
  id: string;
  title: string | null;
  startTime: Date;
  endTime: Date;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  status: string | null;
  salespersonId: string;
  salespersonName: string | null;
}[]> {
  const conditions = [eq(scheduledBookings.contractorId, tenantId)];
  if (startDate) conditions.push(gte(scheduledBookings.startTime, startDate));
  if (endDate) conditions.push(lte(scheduledBookings.endTime, endDate));

  return db.select({
    id: scheduledBookings.id,
    title: scheduledBookings.title,
    startTime: scheduledBookings.startTime,
    endTime: scheduledBookings.endTime,
    customerName: scheduledBookings.customerName,
    customerEmail: scheduledBookings.customerEmail,
    customerPhone: scheduledBookings.customerPhone,
    status: scheduledBookings.status,
    salespersonId: scheduledBookings.assignedSalespersonId,
    salespersonName: users.name,
  })
  .from(scheduledBookings)
  .innerJoin(users, eq(users.id, scheduledBookings.assignedSalespersonId))
  .where(and(...conditions))
  .orderBy(asc(scheduledBookings.startTime));
}
