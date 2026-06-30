import type { Express, Response } from "express";
import { storage } from "../../storage";
import { isIntegrationEnabledCached, invalidateContractorCache } from "../../services/cache";
import { dialpadEnhancedService } from "../../dialpad";
import { providerService, INTEGRATION_NAMES, isIntegrationName } from "../../providers/provider-service";
import { requireManagerOrAdmin, type AuthedRequest } from "../../auth-service";
import { CredentialService } from "../../credential-service";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";
import { syncScheduler } from "../../sync-scheduler";
import { notifyHcpIntegrationChanged } from "../../services/hcp-webhook-health";
import crypto from "crypto";

const log = logger('Integrations');

function hasGeneralIntegrationAccess(user: { role: string; canManageIntegrations: boolean }): boolean {
  return user.role === 'admin' || user.role === 'super_admin' || user.role === 'manager' || user.canManageIntegrations === true;
}

function canAccessIntegration(user: { role: string; canManageIntegrations: boolean; allowedIntegrations?: string[] | null }, integrationKey: string): boolean {
  if (user.role === 'admin' || user.role === 'super_admin' || user.role === 'manager') return true;
  if (!user.canManageIntegrations) return false;
  const allowed = user.allowedIntegrations;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(integrationKey);
}

export function registerIntegrationRoutes(app: Express): void {
  // Integration management routes
  app.get("/api/integrations", asyncHandler(async (req: AuthedRequest, res: Response) => {
    if (!hasGeneralIntegrationAccess(req.user)) {
      res.status(403).json({ message: "You do not have permission to view integrations" });
      return;
    }

    // Fetch tenant integration list and enabled set in parallel — independent queries
    let tenantIntegrations: any[] = [];
    let enabledIntegrations: any[] = [];
    try {
      [tenantIntegrations, enabledIntegrations] = await Promise.all([
        storage.getTenantIntegrations(req.user.contractorId),
        storage.getEnabledIntegrations(req.user.contractorId),
      ]);
    } catch (err) {
      console.error("[integrations] Failed to fetch tenant/enabled integrations:", err);
    }

    const integrationStatus = await Promise.all(
      INTEGRATION_NAMES.map(async (integrationName) => {
        try {
          const [hasCredentials, isEnabled] = await Promise.all([
            providerService.hasRequiredCredentials(req.user.contractorId, integrationName),
            isIntegrationEnabledCached(req.user.contractorId, integrationName),
          ]);
          return { name: integrationName, hasCredentials, isEnabled, canEnable: hasCredentials && !isEnabled };
        } catch (err) {
          console.error(`[integrations] Failed to check status for ${integrationName}:`, err);
          return { name: integrationName, hasCredentials: false, isEnabled: false, canEnable: false };
        }
      })
    );
    
    res.json({ 
      integrations: integrationStatus,
      configured: tenantIntegrations,
      enabled: enabledIntegrations 
    });
  }));

  app.post("/api/integrations/:integrationName/enable", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { integrationName } = req.params;

    if (!canAccessIntegration(req.user, integrationName)) {
      res.status(403).json({ message: "You do not have permission to enable this integration" });
      return;
    }
    
    if (!isIntegrationName(integrationName)) {
      res.status(400).json({ message: "Invalid integration name" });
      return;
    }
    
    const hasCredentials = await providerService.hasRequiredCredentials(req.user.contractorId, integrationName);
    if (!hasCredentials) {
      res.status(400).json({ 
        message: `Cannot enable ${integrationName} integration. Please configure credentials first.`,
        missingCredentials: true
      });
      return;
    }
    
    const integration = await storage.enableTenantIntegration(
      req.user.contractorId, 
      integrationName, 
      req.user.userId
    );

    invalidateContractorCache(req.user.contractorId);

    if (integrationName === 'housecall-pro') {
      try {
        await syncScheduler.onIntegrationEnabled(req.user.contractorId, 'housecall-pro');
      } catch (error) {
        log.error('Failed to schedule sync for Housecall Pro integration:', error);
      }
      notifyHcpIntegrationChanged().catch(err =>
        log.error('Failed to notify HCP integration change on enable:', err)
      );
    }
    
    let webhookCreated = false;
    let webhookError: string | undefined;
    
    if (integrationName === 'dialpad') {
      try {
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('x-forwarded-host') || req.get('host');
        const baseWebhookUrl = `${protocol}://${host}`;
        
        const result = await dialpadEnhancedService.createWebhookWithSubscription(
          req.user.contractorId,
          'inbound',
          baseWebhookUrl
        );
        if (result.success) {
          webhookCreated = true;
        } else {
          webhookError = result.error || 'Failed to create webhook';
          log.error('Failed to auto-create Dialpad webhook:', result.error);
        }
      } catch (error) {
        webhookError = error instanceof Error ? error.message : 'Unknown error occurred';
        log.error('Failed to auto-create Dialpad webhook:', error);
      }
    }

    let messagingServicesConfigured = 0;
    if (integrationName === 'twilio') {
      try {
        const { syncTwilioNumbers } = await import('../../twilio/numbers');
        const { configureTwilioWebhooks } = await import('../../twilio/webhook-config');
        await syncTwilioNumbers(req.user.contractorId);
        const result = await configureTwilioWebhooks(req.user.contractorId);
        webhookCreated = result.configured > 0;
        messagingServicesConfigured = result.messagingServicesConfigured;
        if (result.configured === 0) {
          webhookError = 'No Twilio numbers were configured. Purchase or assign a number in Twilio, then re-sync.';
        }
      } catch (error) {
        webhookError = error instanceof Error ? error.message : 'Unknown error occurred';
        log.error('Failed to auto-configure Twilio webhooks:', error);
      }
    }

    const webhookProvider = integrationName === 'dialpad' || integrationName === 'twilio';
    res.json({ 
      success: true, 
      message: `${integrationName} integration enabled successfully`,
      integration,
      webhookCreated: webhookProvider ? webhookCreated : undefined,
      webhookError: webhookProvider ? webhookError : undefined,
      messagingServicesConfigured: integrationName === 'twilio' ? messagingServicesConfigured : undefined
    });
  }));

  app.post("/api/integrations/:integrationName/disable", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { integrationName } = req.params;

    if (!canAccessIntegration(req.user, integrationName)) {
      res.status(403).json({ message: "You do not have permission to disable this integration" });
      return;
    }
    
    if (!isIntegrationName(integrationName)) {
      res.status(400).json({ message: "Invalid integration name" });
      return;
    }
    
    await storage.disableTenantIntegration(req.user.contractorId, integrationName);

    invalidateContractorCache(req.user.contractorId);

    if (integrationName === 'housecall-pro') {
      try {
        await syncScheduler.onIntegrationDisabled(req.user.contractorId, 'housecall-pro');
      } catch (error) {
        // Non-fatal: integration is already disabled in the DB. The sync scheduler
        // will not pick it up on the next run even if the in-memory cancel failed.
        // Log enough context for an operator to diagnose if syncs keep running.
        log.error(
          `Failed to cancel scheduled sync after disabling housecall-pro ` +
          `— contractorId=${req.user.contractorId}, error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      notifyHcpIntegrationChanged().catch(err =>
        log.error('Failed to notify HCP integration change on disable:', err)
      );
    }
    
    res.json({ 
      success: true, 
      message: `${integrationName} integration disabled successfully` 
    });
  }));

  app.get("/api/integrations/:integrationName/status", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { integrationName } = req.params;
    
    if (!isIntegrationName(integrationName)) {
      res.status(400).json({ message: "Invalid integration name" });
      return;
    }
    
    // Three independent queries — run in parallel
    const [hasCredentials, isEnabled, integration] = await Promise.all([
      providerService.hasRequiredCredentials(req.user.contractorId, integrationName),
      isIntegrationEnabledCached(req.user.contractorId, integrationName),
      storage.getTenantIntegration(req.user.contractorId, integrationName),
    ]);
    
    res.json({
      integrationName,
      hasCredentials,
      isEnabled,
      canEnable: hasCredentials && !isEnabled,
      canDisable: isEnabled,
      enabledAt: integration?.enabledAt,
      disabledAt: integration?.disabledAt
    });
  }));

  app.post("/api/integrations/:integrationName/credentials", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { integrationName } = req.params;
    const { credentials } = req.body;
    
    if (!isIntegrationName(integrationName)) {
      res.status(400).json({ message: "Invalid integration name" });
      return;
    }
    
    if (!credentials || Object.keys(credentials).length === 0) {
      res.status(400).json({ message: "Credentials are required" });
      return;
    }
    
    const result = await providerService.saveCredentials(req.user.contractorId, integrationName, credentials);
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: `${integrationName} credentials saved successfully` 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error || "Failed to save credentials" 
      });
    }
  }));

  app.get("/api/integrations/:integrationName/credentials", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { integrationName } = req.params;
    
    if (!isIntegrationName(integrationName)) {
      res.status(400).json({ message: "Invalid integration name" });
      return;
    }
    
    const credentials = await CredentialService.getMaskedCredentials(req.user.contractorId, integrationName);
    
    res.json({ credentials });
  }));

  app.delete("/api/integrations/:integrationName/credentials", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { integrationName } = req.params;
    
    if (!isIntegrationName(integrationName)) {
      res.status(400).json({ message: "Invalid integration name" });
      return;
    }
    
    await CredentialService.deleteIntegrationCredentials(req.user.contractorId, integrationName);
    
    res.json({ 
      success: true, 
      message: `${integrationName} credentials deleted successfully` 
    });
  }));

  // Webhook configuration endpoint — returns the public webhook URL and a persistent API key
  // for this contractor's lead intake webhook. Generates and saves the key on first call.
  app.get("/api/webhook-config", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    
    let apiKey: string;
    try {
      const existingKey = await CredentialService.getCredential(contractorId, 'webhook', 'api_key');
      if (!existingKey) {
        throw new Error('No API key found');
      }
      apiKey = existingKey;
    } catch {
      apiKey = crypto.randomBytes(32).toString('hex');
      await CredentialService.setCredential(contractorId, 'webhook', 'api_key', apiKey);
    }

    const protocol = req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}/api/webhooks/${contractorId}`;
    const webhookUrl = `${baseUrl}/leads`;

    const commonHeaders = {
      "Content-Type": "application/json",
      "X-API-Key": apiKey
    };

    res.json({
      webhookUrl,
      apiKey,
      webhooks: {
        leads: {
          url: `${baseUrl}/leads`,
          documentation: {
            method: "POST",
            headers: commonHeaders,
            requiredFields: ["name"],
            optionalFields: ["email", "emails", "phone", "phones", "address", "street", "city", "state", "zip", "source", "notes", "followUpDate"],
            phoneNormalization: "All phone numbers are automatically normalized to E.164 format (+1XXXXXXXXXX for US). Supports any format: (xxx)xxx-xxxx, xxx-xxx-xxxx, xxx.xxx.xxxx, xxxxxxxxxx, +1(xxx)xxx-xxxx, etc.",
            multipleContacts: "Send single values (email/phone) OR arrays (emails/phones). Arrays allow multiple contact methods per lead.",
            addressFields: "Use structured fields (street, city, state, zip) when available — they are used as-is without parsing. Use address for a combined string when structured fields are not available.",
            example: {
              name: "John Smith",
              phone: "(555) 123-4567",
              email: "john@example.com",
              street: "123 Main St",
              city: "Springfield",
              state: "IL",
              zip: "62701",
              source: "Website Contact Form",
              notes: "Interested in HVAC installation",
              followUpDate: "2024-01-15T10:00:00Z"
            }
          }
        },
        estimates: {
          url: `${baseUrl}/estimates`,
          documentation: {
            method: "POST",
            headers: commonHeaders,
            requiredFields: ["title", "amount", "customerName"],
            optionalFields: ["description", "status", "validUntil", "followUpDate", "customerEmail", "customerPhone", "customerAddress"],
            example: {
              title: "HVAC Installation",
              amount: 2500.00,
              customerName: "John Smith",
              customerEmail: "john@example.com",
              customerPhone: "(555) 123-4567",
              customerAddress: "123 Main St, City, State 12345",
              description: "Full HVAC system installation including labor",
              status: "scheduled",
              validUntil: "2024-02-15T00:00:00Z"
            }
          }
        },
        jobs: {
          url: `${baseUrl}/jobs`,
          documentation: {
            method: "POST",
            headers: commonHeaders,
            requiredFields: ["title", "scheduledDate", "customerName"],
            optionalFields: ["description", "status", "type", "amount", "notes", "estimateId", "customerEmail", "customerPhone", "customerAddress"],
            example: {
              title: "HVAC Maintenance Visit",
              scheduledDate: "2024-02-01T09:00:00Z",
              customerName: "John Smith",
              customerEmail: "john@example.com",
              customerPhone: "(555) 123-4567",
              customerAddress: "123 Main St, City, State 12345",
              type: "service",
              amount: 150.00,
              status: "scheduled",
              notes: "Annual maintenance, check filters and refrigerant"
            }
          }
        }
      },
      documentation: {
        method: "POST",
        headers: commonHeaders,
        requiredFields: ["name"],
        optionalFields: ["email", "emails", "phone", "phones", "address", "source", "notes", "followUpDate"],
        phoneNormalization: "All phone numbers are automatically normalized to E.164 format (+1XXXXXXXXXX for US). Supports any format: (xxx)xxx-xxxx, xxx-xxx-xxxx, xxx.xxx.xxxx, xxxxxxxxxx, +1(xxx)xxx-xxxx, etc.",
        multipleContacts: "Send single values (email/phone) OR arrays (emails/phones). Arrays allow multiple contact methods per lead.",
        example: {
          name: "John Smith",
          phone: "(555) 123-4567",
          email: "john@example.com",
          address: "123 Main St, City, State 12345",
          source: "Website Contact Form",
          notes: "Interested in HVAC installation",
          followUpDate: "2024-01-15T10:00:00Z"
        }
      }
    });
  }));
}
