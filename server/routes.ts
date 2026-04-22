import type { Express, NextFunction, Request, Response } from "express";
import { createServer, type Server } from "http";
import cookieParser from "cookie-parser";
import { requireAuth } from "./auth-service";
import { apiRateLimiter } from './middleware/rate-limiter';
import { setupWebSocket, broadcastToContractor } from './websocket';
import { initSyncStatusBroadcast } from './sync-status-store';

import { registerAuthRoutes } from './routes/auth';
import { registerMFARoutes } from './routes/mfa';
import { registerAuditLogRoutes } from './routes/audit-logs';
import { registerOAuthRoutes } from './routes/oauth';
import { registerUserRoutes } from './routes/users';
import { registerContactRoutes } from './routes/contacts';
import { registerContactActionRoutes } from './routes/contact-actions';
import { registerJobRoutes } from './routes/jobs';
import { registerEstimateRoutes } from './routes/estimates';
import { registerActivityRoutes } from './routes/activities';
import { registerEmployeeRoutes } from './routes/employees';
import { registerMessagingRoutes } from './routes/messaging';
import { registerTemplateRoutes } from './routes/templates';
import { registerEmailSyncRoutes } from './routes/email-sync';
import { registerAssignmentRoutes } from './routes/assignments';
import { registerWorkflowRoutes } from './routes/workflows';
import { registerNotificationRoutes } from './routes/notifications';
import { registerAiRoutes } from './routes/ai';
import { registerSettingsRoutes } from './routes/settings';
import { registerIntegrationRoutes } from './routes/integrations';
import { registerDialpadRoutes } from './routes/integrations/dialpad';
import { registerHousecallProRoutes } from './routes/integrations/housecall-pro';
import { registerHcpSyncRoutes } from './routes/integrations/hcp-sync';
import { registerHcpSchedulingRoutes } from './routes/integrations/hcp-scheduling';
import { registerHcpEmployeeMappingRoutes } from './routes/integrations/hcp-employee-mapping';
import { registerFacebookIntegrationRoutes } from './routes/integrations/facebook';
import { registerGoogleLocalServicesIntegrationRoutes } from './routes/integrations/google-local-services';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerPublicRoutes } from './routes/public';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerReportsRoutes } from './routes/reports';
import { registerLeadCaptureRoutes } from './routes/lead-capture';
import { registerSalesProcessRoutes } from './routes/sales-process';

export async function registerRoutes(app: Express): Promise<Server> {
  app.use(cookieParser());

  app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/' || req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
    else if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg)$/)) {
      // Content-hashed Vite bundles under /assets/* are immutable — let
      // serveStatic apply its own `public, max-age=1y, immutable` header
      // (send.js only sets Cache-Control when it isn't already set, so we
      // must NOT pre-set anything here for those paths).
      if (!req.path.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'max-age=300, must-revalidate');
      }
    }
    next();
  });

  // Auth middleware — enforces authentication on all /api/ routes except the
  // public ones listed below.
  app.use("/api", (req, res, next: NextFunction) => {
    if (req.path === '/auth/login' || req.path === '/auth/register' || req.path === '/auth/logout') {
      return next();
    }
    if (req.path === '/auth/forgot-password' || req.path === '/auth/reset-password') {
      return next();
    }
    if (req.path === '/mfa/verify') {
      return next(); // Public MFA verify endpoint (uses pendingToken)
    }
    if (req.path === '/version') {
      return next();
    }
    if (req.path.startsWith('/webhooks/')) {
      return next();
    }
    if (req.path.startsWith('/public/')) {
      return next();
    }
    return requireAuth(req, res, next);
  });

  // General safety-net rate limiter for all /api/ routes.
  // Runs AFTER requireAuth so req.user is populated and the limiter can key
  // authenticated requests by user ID instead of IP (avoids CGNAT collisions).
  // Routes with their own stricter limiters (auth, webhooks, public, AI) are
  // excluded here because they apply their limiter at the individual route level.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (
      req.path.startsWith('/auth/') ||
      req.path.startsWith('/webhooks/') ||
      req.path.startsWith('/public/') ||
      req.path === '/version'
    ) {
      return next();
    }
    return apiRateLimiter(req, res, next);
  });

  registerAuthRoutes(app);
  registerMFARoutes(app);
  registerAuditLogRoutes(app);
  registerOAuthRoutes(app);
  registerUserRoutes(app);
  registerContactActionRoutes(app);
  registerContactRoutes(app);
  registerJobRoutes(app);
  registerEstimateRoutes(app);
  registerActivityRoutes(app);
  registerEmployeeRoutes(app);
  registerMessagingRoutes(app);
  registerTemplateRoutes(app);
  registerEmailSyncRoutes(app);
  registerAssignmentRoutes(app);
  registerWorkflowRoutes(app);
  registerNotificationRoutes(app);
  registerAiRoutes(app);
  registerSettingsRoutes(app);
  registerLeadCaptureRoutes(app);
  registerSalesProcessRoutes(app);
  registerFacebookIntegrationRoutes(app);
  registerGoogleLocalServicesIntegrationRoutes(app);
  registerIntegrationRoutes(app);
  registerDialpadRoutes(app);
  registerHousecallProRoutes(app);
  registerHcpSyncRoutes(app);
  registerHcpSchedulingRoutes(app);
  registerHcpEmployeeMappingRoutes(app);
  registerWebhookRoutes(app);
  registerPublicRoutes(app);
  registerDashboardRoutes(app);
  registerReportsRoutes(app);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const isDevelopment = process.env.NODE_ENV === 'development';
    console.error(`[ERROR] ${req.method} ${req.path} — ${err.message}`, err.stack);
    res.status(500).json({
      message: 'Internal server error',
      details: isDevelopment ? err.message : undefined
    });
  });

  const httpServer = createServer(app);
  setupWebSocket(httpServer);
  initSyncStatusBroadcast(broadcastToContractor);

  return httpServer;
}
