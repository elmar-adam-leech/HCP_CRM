import type { Express } from "express";
import { registerHousecallProWebhookRoutes } from "./housecall-pro";
import { registerLeadWebhookRoutes } from "./leads";
import { registerEstimateWebhookRoutes } from "./estimates";
import { registerJobWebhookRoutes } from "./jobs";
import { registerDialpadSmsWebhookRoutes } from "./dialpad-sms";
import { registerDialpadCallsWebhookRoutes } from "./dialpad-calls";
import { registerFacebookWebhookRoutes } from "./facebook";

export function registerWebhookRoutes(app: Express): void {
  registerHousecallProWebhookRoutes(app);
  registerLeadWebhookRoutes(app);
  registerEstimateWebhookRoutes(app);
  registerJobWebhookRoutes(app);
  registerDialpadSmsWebhookRoutes(app);
  registerDialpadCallsWebhookRoutes(app);
  registerFacebookWebhookRoutes(app);
}
