/**
 * ProviderService — runtime abstraction layer for communication providers.
 *
 * Purpose:
 *   Decouples application code from specific vendor SDKs (Dialpad, SendGrid, Gmail).
 *   Route handlers call `providerService.sendEmail(...)`, `providerService.sendSms(...)`,
 *   or `providerService.initiateCall(...)` and the service resolves which concrete
 *   provider to use based on the contractor's configuration stored in `tenant_providers`.
 *
 * How to add a new provider:
 *   1. Create `server/providers/<vendor>-provider.ts` implementing the `EmailProvider`,
 *      `SmsProvider`, or `CallProvider` interface from `server/providers/interfaces.ts`.
 *   2. Register a factory in `initializeProviderFactories()` under the appropriate key
 *      (email / sms / calling) so the service can lazy-load it.
 *   3. Add the vendor name to `AVAILABLE_INTEGRATIONS` and update the credential flow
 *      in `server/credential-service.ts` if it needs an API key or OAuth token.
 */
import { providerRegistry } from './registry';
import { storage } from '../storage';
import { credentialService } from '../credential-service';
import type { EmailResult, SmsResult, CallResult, EmailProvider, SmsProvider, CallProvider } from './interfaces';
import { logger } from '../utils/logger';

const log = logger('ProviderService');

/**
 * Centralized registry of available integrations
 */
export const AVAILABLE_INTEGRATIONS = {
  DIALPAD: 'dialpad' as const,
  GMAIL: 'gmail' as const,
  SENDGRID: 'sendgrid' as const,
  HOUSECALL_PRO: 'housecall-pro' as const,
  TWILIO: 'twilio' as const,
} as const;

export const INTEGRATION_NAMES = Object.values(AVAILABLE_INTEGRATIONS);
export type IntegrationName = typeof AVAILABLE_INTEGRATIONS[keyof typeof AVAILABLE_INTEGRATIONS];

export function isIntegrationName(v: string): v is IntegrationName {
  return (INTEGRATION_NAMES as readonly string[]).includes(v);
}

/**
 * Provider factory definitions for dynamic loading
 */
interface ProviderFactory<T> {
  load: () => Promise<T>;
}

type ProviderFactories = {
  email: { [key: string]: ProviderFactory<EmailProvider> };
  sms: { [key: string]: ProviderFactory<SmsProvider> };
  calling: { [key: string]: ProviderFactory<CallProvider> };
};

/**
 * Central provider service that manages contractor-specific provider resolution
 * and communication operations with dynamic provider loading
 */
export class ProviderService {
  private static instance: ProviderService;
  private providerFactories!: ProviderFactories;
  
  private constructor() {
    this.initializeProviderFactories();
  }

  static getInstance(): ProviderService {
    if (!ProviderService.instance) {
      ProviderService.instance = new ProviderService();
    }
    return ProviderService.instance;
  }

  /**
   * Initialize provider factories with dynamic imports
   * Only providers that are actually used will be loaded
   */
  private initializeProviderFactories(): void {
    this.providerFactories = {
      email: {
        gmail: {
          load: async () => {
            const { GmailEmailProvider } = await import('./gmail-provider');
            return new GmailEmailProvider();
          }
        },
        sendgrid: {
          load: async () => {
            const { SendGridEmailProvider } = await import('./sendgrid-provider');
            return new SendGridEmailProvider();
          }
        }
      },
      sms: {
        dialpad: {
          load: async () => {
            const { DialpadSmsProvider } = await import('./dialpad-provider');
            return new DialpadSmsProvider();
          }
        },
        twilio: {
          load: async () => {
            const { TwilioSmsProvider } = await import('./twilio-provider');
            return new TwilioSmsProvider();
          }
        }
      },
      calling: {
        dialpad: {
          load: async () => {
            const { DialpadCallProvider } = await import('./dialpad-provider');
            return new DialpadCallProvider();
          }
        },
        twilio: {
          load: async () => {
            const { TwilioCallProvider } = await import('./twilio-provider');
            return new TwilioCallProvider();
          }
        }
      }
    };
  }

  /**
   * Check if a provider is enabled for a contractor (has credentials, is configured, AND explicitly enabled)
   */
  private async isProviderEnabled(contractorId: string, providerType: 'email' | 'sms' | 'calling', providerName: string): Promise<boolean> {
    try {
      // Check if provider has required credentials
      const hasCredentials = await this.hasRequiredCredentials(contractorId, providerName);
      if (!hasCredentials) {
        return false;
      }

      // Check if provider factory exists
      const factory = this.providerFactories[providerType][providerName];
      if (!factory) {
        return false;
      }

      // Check if integration is explicitly enabled for this contractor
      const { isIntegrationEnabledCached } = await import('../services/cache');
      const isIntegrationEnabled = await isIntegrationEnabledCached(contractorId, providerName);
      if (!isIntegrationEnabled) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if contractor has required credentials for a provider (public method for API endpoints)
   */
  async hasRequiredCredentials(contractorId: string, providerName: string): Promise<boolean> {
    try {
      // Use CredentialService's method which only checks tenant-specific credentials
      // This ensures integrations only show as "Active" when tenant has configured their own credentials
      return await credentialService.hasRequiredCredentials(contractorId, providerName);
    } catch {
      return false;
    }
  }

  /**
   * Load a provider dynamically and cache it in the registry
   */
  private async loadProvider(providerType: 'email' | 'sms' | 'calling', providerName: string): Promise<EmailProvider | SmsProvider | CallProvider | null> {
    try {
      // Check if already loaded in registry
      const existing = providerRegistry.getProvider(providerType, providerName);
      if (existing) {
        return existing;
      }

      // Load the provider using factory
      const factory = this.providerFactories[providerType][providerName];
      if (!factory) {
        log.warn(`No factory found for ${providerType} provider '${providerName}'`);
        return null;
      }

      log.info(`Dynamically loading ${providerType} provider: ${providerName}`);
      const provider = await factory.load();

      // Register the loaded provider
      switch (providerType) {
        case 'email':
          providerRegistry.registerEmailProvider(provider as EmailProvider);
          break;
        case 'sms':
          providerRegistry.registerSmsProvider(provider as SmsProvider);
          break;
        case 'calling':
          providerRegistry.registerCallProvider(provider as CallProvider);
          break;
      }

      return provider;
    } catch (error) {
      log.error(`Failed to load ${providerType} provider '${providerName}'`, error);
      return null;
    }
  }

  /**
   * Public accessor for the tenant's active provider name (with enablement
   * checks). Used by callers that need to make provider-specific decisions
   * BEFORE sending — e.g. the workflow SMS action resolving a default "From"
   * number against the provider that will actually perform the send.
   * Throws when no enabled provider exists for the type.
   */
  async getActiveProviderName(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<string> {
    return this.getTenantProvider(contractorId, providerType);
  }

  /**
   * Get contractor's preferred provider for a service type, with enablement checks
   */
  private async getTenantProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<string> {
    // Get contractor's provider preference
    const preference = await storage.getTenantProvider(contractorId, providerType);
    
    if (preference) {
      let preferredProvider: string | undefined;
      
      // Return the configured provider name
      if (providerType === 'email' && preference.emailProvider) {
        preferredProvider = preference.emailProvider;
      } else if (providerType === 'sms' && preference.smsProvider) {
        preferredProvider = preference.smsProvider;
      } else if (providerType === 'calling' && preference.callingProvider) {
        preferredProvider = preference.callingProvider;
      }

      // Verify the preferred provider is enabled
      if (preferredProvider && await this.isProviderEnabled(contractorId, providerType, preferredProvider)) {
        return preferredProvider;
      }
    }

    // Fallback: find first enabled provider for this contractor
    const availableProviders = this.getAvailableProviderNames(providerType);
    for (const providerName of availableProviders) {
      if (await this.isProviderEnabled(contractorId, providerType, providerName)) {
        return providerName;
      }
    }

    throw new Error(`No enabled ${providerType} providers found for contractor ${contractorId}. Please configure credentials AND enable the integration for a ${providerType} provider.`);
  }

  /**
   * Get available provider names for a service type (from factories, not loaded providers)
   */
  getAvailableProviderNames(providerType: 'email' | 'sms' | 'calling'): string[] {
    return Object.keys(this.providerFactories[providerType] || {});
  }

  /**
   * Get available providers for a service type (for backward compatibility)
   */
  getAvailableProviders(providerType: 'email' | 'sms' | 'calling'): string[] {
    return this.getAvailableProviderNames(providerType);
  }

  /**
   * Get enabled providers for a specific contractor
   */
  async getEnabledProviders(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<string[]> {
    const availableProviders = this.getAvailableProviderNames(providerType);
    const enabledProviders: string[] = [];
    
    for (const providerName of availableProviders) {
      if (await this.isProviderEnabled(contractorId, providerType, providerName)) {
        enabledProviders.push(providerName);
      }
    }
    
    return enabledProviders;
  }

  /**
   * Send email using contractor's preferred email provider (with dynamic loading)
   */
  async sendEmail(options: {
    to: string;
    subject: string;
    content: string;
    fromEmail?: string;
    contractorId: string;
  }): Promise<EmailResult> {
    try {
      const providerName = await this.getTenantProvider(options.contractorId, 'email');
      
      // Dynamically load the provider if needed
      await this.loadProvider('email', providerName);
      const provider = providerRegistry.getEmailProvider(providerName);
      
      if (!provider) {
        return {
          success: false,
          error: `Email provider '${providerName}' could not be loaded`
        };
      }

      return await provider.sendEmail(options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Send SMS using contractor's preferred SMS provider (with dynamic loading)
   */
  async sendSms(options: {
    to: string;
    message: string;
    fromNumber?: string;
    contractorId: string;
    userId?: string;
  }): Promise<SmsResult> {
    try {
      const providerName = await this.getTenantProvider(options.contractorId, 'sms');
      
      // Dynamically load the provider if needed
      await this.loadProvider('sms', providerName);
      const provider = providerRegistry.getSmsProvider(providerName);
      
      if (!provider) {
        return {
          success: false,
          error: `SMS provider '${providerName}' could not be loaded`
        };
      }

      return await provider.sendSms(options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Initiate call using contractor's preferred calling provider (with dynamic loading)
   */
  async initiateCall(options: {
    to: string;
    fromNumber?: string;
    autoRecord?: boolean;
    contractorId: string;
    userId?: string;
  }): Promise<CallResult> {
    try {
      const providerName = await this.getTenantProvider(options.contractorId, 'calling');
      
      // Dynamically load the provider if needed
      await this.loadProvider('calling', providerName);
      const provider = providerRegistry.getCallProvider(providerName);
      
      if (!provider) {
        return {
          success: false,
          error: `Calling provider '${providerName}' could not be loaded`
        };
      }

      return await provider.initiateCall(options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Check if a contractor has a specific provider configured and working
   */
  async checkProviderConnection(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<{ connected: boolean; error?: string; provider?: string }> {
    try {
      const providerName = await this.getTenantProvider(contractorId, providerType);
      
      // Dynamically load the provider if needed
      await this.loadProvider(providerType, providerName);
      const provider = providerRegistry.getProvider(providerType, providerName);
      
      if (!provider) {
        return {
          connected: false,
          error: `${providerType} provider '${providerName}' could not be loaded`,
          provider: providerName
        };
      }

      const result = await provider.checkConnection(contractorId);
      return {
        ...result,
        provider: providerName
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Set contractor's preferred provider for a service type (with enablement checks)
   */
  async setTenantProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling', providerName: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if provider factory exists
      const factory = this.providerFactories[providerType][providerName];
      if (!factory) {
        return {
          success: false,
          error: `Provider '${providerName}' not available for ${providerType}`
        };
      }

      // Check if contractor has required credentials
      const hasCredentials = await this.hasRequiredCredentials(contractorId, providerName);
      if (!hasCredentials) {
        return {
          success: false,
          error: `Required credentials not configured for ${providerName}. Please set up credentials first.`
        };
      }

      // Set the provider preference
      await storage.setTenantProvider(contractorId, providerType, providerName);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Save credentials for a specific integration
   */
  async saveCredentials(contractorId: string, integrationName: string, credentials: Record<string, string>): Promise<{ success: boolean; error?: string }> {
    try {
      // Validate the integration name
      if (!isIntegrationName(integrationName)) {
        return {
          success: false,
          error: `Invalid integration name: ${integrationName}`
        };
      }

      // Save each credential key-value pair
      for (const [key, value] of Object.entries(credentials)) {
        if (value && typeof value === 'string') { // Only save non-empty string values
          await credentialService.setCredential(contractorId, integrationName, key, value);
        }
      }

      return { success: true };
    } catch (error) {
      log.error('Error saving credentials', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials'
      };
    }
  }
}

// Export singleton instance
export const providerService = ProviderService.getInstance();