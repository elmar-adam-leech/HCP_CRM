import type { Express } from "express";
import { storage } from "../storage";
import { asyncHandler } from "../utils/async-handler";
import { broadcastToContractor } from "../websocket";

export function registerNotificationRoutes(app: Express): void {
  app.get("/api/notifications", asyncHandler(async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const notifications = await storage.getNotifications(req.user.userId, req.user.contractorId, limit);
    res.json(notifications);
  }));

  app.get("/api/notifications/unread", asyncHandler(async (req, res) => {
    const notifications = await storage.getUnreadNotifications(req.user.userId, req.user.contractorId);
    res.json(notifications);
  }));

  app.post("/api/notifications/:id/read", asyncHandler(async (req, res) => {
    const notification = await storage.markNotificationAsRead(req.params.id, req.user.userId);
    if (!notification) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'notification_updated' });
    res.json(notification);
  }));

  app.post("/api/notifications/mark-all-read", asyncHandler(async (req, res) => {
    await storage.markAllNotificationsAsRead(req.user.userId, req.user.contractorId);
    broadcastToContractor(req.user.contractorId, { type: 'notification_updated' });
    res.json({ success: true });
  }));

  app.delete("/api/notifications/:id", asyncHandler(async (req, res) => {
    const deleted = await storage.deleteNotification(req.params.id, req.user.userId);
    if (!deleted) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'notification_updated' });
    res.json({ success: true });
  }));
}
