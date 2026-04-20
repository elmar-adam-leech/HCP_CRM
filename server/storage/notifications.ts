import {
  type Notification, type InsertNotification,
  notifications,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc } from "drizzle-orm";

async function getNotifications(userId: string, contractorId: string, limit: number = 50): Promise<Notification[]> {
  return await db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.contractorId, contractorId))).orderBy(desc(notifications.createdAt)).limit(limit);
}

async function getUnreadNotifications(userId: string, contractorId: string): Promise<Notification[]> {
  return await db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.contractorId, contractorId), eq(notifications.read, false))).orderBy(desc(notifications.createdAt)).limit(100);  // unread notifications should never grow unbounded
}

async function getNotification(id: string, userId: string): Promise<Notification | undefined> {
  const result = await db.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).limit(1);
  return result[0];
}

async function createNotification(notification: Omit<InsertNotification, 'contractorId'>, contractorId: string): Promise<Notification> {
  const result = await db.insert(notifications).values({ ...notification, contractorId }).returning();
  return result[0];
}

async function markNotificationAsRead(id: string, userId: string): Promise<Notification | undefined> {
  const result = await db.update(notifications).set({ read: true }).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).returning();
  return result[0];
}

async function markAllNotificationsAsRead(userId: string, contractorId: string): Promise<void> {
  await db.update(notifications).set({ read: true }).where(and(eq(notifications.userId, userId), eq(notifications.contractorId, contractorId), eq(notifications.read, false)));
}

async function deleteNotification(id: string, userId: string): Promise<boolean> {
  const result = await db.delete(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).returning();
  return result.length > 0;
}

export const notificationMethods = {
  getNotifications,
  getUnreadNotifications,
  getNotification,
  createNotification,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
};
