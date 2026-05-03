import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  decimal,
  date,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { contractors } from "./settings";

// Manual ad-spend entries used by the ROI by Source report. One row per
// (contractor, platform, campaign, month). `month` stores the first day of
// the month the spend applies to (UTC); `amount` is dollars.
//
// `campaign` is optional — when null the row is platform-level spend and
// shows as "Unattributed" in the ROI report's per-campaign drill-down.
//
// Entries are created by the user in the Ad Spend settings page; auto-import
// from ad networks is out of scope.
export const mediaSpend = pgTable(
  "media_spend",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
    // Canonical platform key (lower-case form of the LeadPlatform string,
    // e.g. "facebook", "google", "yelp"). Mirrors the rollup in
    // shared/lib/lead-platform.ts so the report and settings page agree.
    platform: text("platform").notNull(),
    // Optional campaign name within the platform. Matched against
    // leads.utm_campaign (case/space-insensitive) by the ROI report.
    // NULL means platform-level spend (Unattributed in the report).
    campaign: text("campaign"),
    // First day of the month this spend applies to (UTC).
    month: date("month").notNull(),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    note: text("note"),
    // CRM user ids of the people who created/last-edited this row. Not FK'd
    // to keep this schema file independent of the users table import order.
    createdByUserId: varchar("created_by_user_id"),
    updatedByUserId: varchar("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    contractorIdx: index("media_spend_contractor_id_idx").on(table.contractorId),
    contractorMonthIdx: index("media_spend_contractor_month_idx").on(
      table.contractorId,
      table.month,
    ),
    // One row per (contractor, platform, campaign, month). NULLS NOT DISTINCT
    // so two platform-level (campaign=NULL) rows for the same platform+month
    // still collide, preserving the "one entry per platform/month" guarantee
    // for un-campaigned spend.
    uniquePlatformCampaignMonth: unique(
      "media_spend_unique_platform_campaign_month_idx",
    )
      .on(table.contractorId, table.platform, table.campaign, table.month)
      .nullsNotDistinct(),
  }),
);

export const insertMediaSpendSchema = createInsertSchema(mediaSpend).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  // Drizzle decimal serializes to string; accept either when creating.
  amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  // `date` columns project to "YYYY-MM-DD"; accept either form.
  month: z.union([z.string(), z.date()]).transform((v) =>
    typeof v === "string" ? v : v.toISOString().slice(0, 10)
  ),
  campaign: z.string().nullable().optional(),
});

export type InsertMediaSpend = z.infer<typeof insertMediaSpendSchema>;
export type MediaSpend = typeof mediaSpend.$inferSelect;
