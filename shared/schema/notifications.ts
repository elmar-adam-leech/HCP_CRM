import { sql } from "drizzle-orm";
import { pgTable, varchar, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { notificationTypeEnum } from "./enums";
import { contractors } from "./settings";
import { users } from "./users";

// Notifications table for user notifications
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  type: notificationTypeEnum("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  link: text("link"), // Optional URL to navigate to
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Index for fetching user's notifications
  userIdIdx: index("notifications_user_id_idx").on(table.userId),
  contractorIdIdx: index("notifications_contractor_id_idx").on(table.contractorId),
  // Composite index for unread notifications query (userId, read)
  userUnreadIdx: index("notifications_user_unread_idx").on(table.userId, table.read),
  createdAtIdx: index("notifications_created_at_idx").on(table.createdAt),
  // Covering composite index for getUnreadNotifications() which filters by
  // (user_id, contractor_id, read) and orders by created_at in a single scan.
  userContractorUnreadCreatedIdx: index("notifications_user_contractor_unread_created_idx").on(table.userId, table.contractorId, table.read, table.createdAt),
}));

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;
