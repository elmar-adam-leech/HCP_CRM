import { storage } from "../storage";
import { broadcastToContractor } from "../websocket";
import type { InsertActivity, Activity } from "@shared/schema";

/**
 * Creates an activity record and broadcasts a WebSocket event to all connected
 * clients for the given contractor in a single call.
 *
 * Use this instead of calling `storage.createActivity` + `broadcastToContractor`
 * separately, which was error-prone (broadcast easily forgotten) and led to
 * inconsistent broadcast payload shapes across route files.
 *
 * When to use vs. calling each separately:
 *  - Use this whenever a user action should both persist an activity AND
 *    notify connected clients (status changes, follow-up updates, note additions).
 *  - Call each separately only when you need fine-grained error handling between
 *    the two operations (e.g. the broadcast should fire even if activity creation
 *    fails, or vice-versa).
 *
 * @param contractorId  Tenant identifier used for both storage and broadcast targeting.
 * @param activityData  The activity fields (same shape as storage.createActivity's first arg).
 * @param broadcastPayload  The WebSocket message object sent to all contractor clients.
 * @returns The newly created Activity record.
 */
export async function createActivityAndBroadcast(
  contractorId: string,
  activityData: Omit<InsertActivity, 'contractorId'>,
  broadcastPayload: { type: string; [key: string]: unknown }
): Promise<Activity> {
  const activity = await storage.createActivity(activityData, contractorId);
  broadcastToContractor(contractorId, broadcastPayload);
  return activity;
}
