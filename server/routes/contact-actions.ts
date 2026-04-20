import type { Express, Response } from "express";
import { asyncHandler } from "../utils/async-handler";
import { storage } from "../storage";
import { isIntegrationEnabledCached } from "../services/cache";
import { housecallProService } from "../hcp/index";
import { type AuthedRequest } from "../auth-service";
type AuthenticatedRequest = AuthedRequest;
import { z } from "zod";
import { parseLeadCsv } from "../utils/parse-lead-csv";
import { parseBody } from "../utils/validate-body";
import { markContactScheduled } from "../services/contact-status";

import { logger } from '../utils/logger';

const log = logger('ContactActionsRoutes');

const scheduleContactSchema = z.object({
  employeeId: z.string().min(1, "Employee ID is required"),
  scheduledStart: z.string().refine((date) => !isNaN(Date.parse(date)), {
    message: "Invalid start date format"
  }),
  scheduledEnd: z.string().refine((date) => !isNaN(Date.parse(date)), {
    message: "Invalid end date format"
  }),
  description: z.string().optional()
});

export function registerContactActionRoutes(app: Express): void {
  app.get("/api/contacts/scheduled", asyncHandler(async (req, res) => {
    const scheduledContacts = await storage.getScheduledContacts(req.user.contractorId);
    res.json(scheduledContacts);
  }));

  app.get("/api/contacts/unscheduled", asyncHandler(async (req, res) => {
    const unscheduledContacts = await storage.getUnscheduledContacts(req.user.contractorId);
    res.json(unscheduledContacts);
  }));

  app.post("/api/contacts/:id/schedule", asyncHandler(async (req, res) => {
    const { id: contactId } = req.params;

    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'housecall-pro');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Housecall Pro integration is not enabled for this tenant. Please enable it to schedule contacts.",
        integrationDisabled: true
      });
      return;
    }

    const validation = parseBody(scheduleContactSchema, req, res);
    if (!validation) return;

    const { employeeId, scheduledStart, scheduledEnd, description } = validation;
    const startDate = new Date(scheduledStart);
    const endDate = new Date(scheduledEnd);

    const contact = await storage.getContact(contactId, req.user.contractorId);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    if (contact.isScheduled) {
      res.status(400).json({ message: "Contact is already scheduled" });
      return;
    }

    let housecallProCustomerId = contact.housecallProCustomerId;
    const contactEmail = contact.emails?.[0];
    const contactPhone = contact.phones?.[0];

    if (!housecallProCustomerId) {
      if (contactEmail || contactPhone) {
        const searchResult = await housecallProService.searchCustomers(req.user.contractorId, {
          email: contactEmail || undefined,
          phone: contactPhone || undefined
        });

        if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
          housecallProCustomerId = searchResult.data[0].id;
        }
      }

      if (!housecallProCustomerId) {
        const customerResult = await housecallProService.createCustomer(req.user.contractorId, {
          first_name: contact.name.split(' ')[0] || contact.name,
          last_name: contact.name.split(' ').slice(1).join(' ') || '',
          email: contactEmail || '',
          mobile_number: contactPhone || '',
          addresses: (contact.street || contact.address) ? [{
            street: contact.street || contact.address || '',
            city: contact.city || '',
            state: contact.state || '',
            zip: contact.zip || '',
            country: 'US',
          }] : undefined
        });

        if (!customerResult.success) {
          res.status(400).json({ message: `Failed to create customer in Housecall Pro: ${customerResult.error}` });
          return;
        }

        // SAFE: `customerResult.success` was checked on line 107; `.data` is non-null
        // when `success === true` by the HousecallPro service contract.
        housecallProCustomerId = customerResult.data!.id;
      }
    }

    const estimateResult = await housecallProService.createEstimate(req.user.contractorId, {
      customer_id: housecallProCustomerId,
      employee_id: employeeId,
      message: description || `Estimate for ${contact.name}`,
      options: [{
        name: 'Option 1',
        schedule: {
          scheduled_start: startDate.toISOString(),
          scheduled_end: endDate.toISOString(),
        },
      }],
      address: (contact.street || contact.address) ? {
        street: contact.street || contact.address || '',
        city: contact.city || '',
        state: contact.state || '',
        zip: contact.zip || '',
        country: 'US',
      } : undefined
    });

    if (!estimateResult.success) {
      res.status(400).json({ message: `Failed to create estimate in Housecall Pro: ${estimateResult.error}` });
      return;
    }

    const result = await storage.scheduleContactAsEstimate(contactId, {
      housecallProCustomerId,
      // SAFE: `estimateResult.success` was checked on line 136; `.data` is non-null
      // when `success === true` by the HousecallPro service contract.
      housecallProEstimateId: estimateResult.data!.id,
      scheduledAt: startDate,
      scheduledEmployeeId: employeeId,
      scheduledStart: startDate,
      scheduledEnd: endDate,
      description: description || `Estimate for ${contact.name}`
    }, req.user.contractorId);

    if (!result) {
      res.status(500).json({ message: "Failed to complete contact-to-estimate conversion" });
      return;
    }

    // Centralized status flip + workflow trigger. scheduleContactAsEstimate above
    // already set isScheduled=true but does NOT update status or fire the trigger,
    // so we route the status transition through the helper for consistency with
    // every other "mark scheduled" code path.
    await markContactScheduled(contactId, req.user.contractorId, {
      source: 'hcp_estimate_link',
      scheduledByUserId: req.user.userId,
    }).catch(err => log.error('markContactScheduled (hcp estimate link) failed:', err));

    res.json({
      message: "Contact scheduled and converted to estimate successfully",
      contact: result.contact,
      estimate: result.estimate,
      // SAFE: same success-guard as above — `estimateResult.data` is non-null here.
      housecallProEstimateId: estimateResult.data!.id
    });
  }));

  app.post("/api/contacts/deduplicate", asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      res.status(403).json({ message: "Only administrators can deduplicate contacts" });
      return;
    }
    const result = await storage.deduplicateContacts(req.user.contractorId);
    res.json(result);
  }));

  app.post("/api/leads/csv-upload", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { csvData } = req.body;

    if (!csvData || typeof csvData !== 'string') {
      res.status(400).json({ error: "Missing CSV data", message: "Please provide CSV data in the request body" });
      return;
    }

    const contractorId = req.user.contractorId;
    const { total, validContacts, errors, fatalError } = parseLeadCsv(csvData);

    if (fatalError) {
      res.status(400).json({ error: "Invalid CSV", message: fatalError });
      return;
    }

    let imported = 0;
    if (validContacts.length > 0) {
      const bulkResult = await storage.bulkCreateContacts(validContacts, contractorId);
      imported = bulkResult.inserted;
    }

    log.info(`CSV import completed for contractor ${contractorId}: ${imported}/${total} leads imported`);

    const statusCode = errors.length > 0 ? 207 : 200;
    res.status(statusCode).json({
      success: true,
      message: `Successfully imported ${imported} out of ${total} leads`,
      total,
      imported,
      failedCount: errors.length,
      errors: errors.slice(0, 10),
    });
  }));
}
