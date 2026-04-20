import type { EmailProvider, SmsProvider, CallProvider, CommunicationProvider, ProviderRegistry } from './interfaces';

/**
 * Central registry for all communication providers
 * Allows easy registration and retrieval of email, SMS, and calling providers
 */
export class CommunicationProviderRegistry implements ProviderRegistry {
  private emailProviders = new Map<string, EmailProvider>();
  private smsProviders = new Map<string, SmsProvider>();
  private callProviders = new Map<string, CallProvider>();

  // Email provider management
  registerEmailProvider(provider: EmailProvider): void {
    this.emailProviders.set(provider.providerName, provider);
  }

  getEmailProvider(providerName: string): EmailProvider | undefined {
    return this.emailProviders.get(providerName);
  }

  getAvailableEmailProviders(): string[] {
    return Array.from(this.emailProviders.keys());
  }

  // SMS provider management
  registerSmsProvider(provider: SmsProvider): void {
    this.smsProviders.set(provider.providerName, provider);
  }

  getSmsProvider(providerName: string): SmsProvider | undefined {
    return this.smsProviders.get(providerName);
  }

  getAvailableSmsProviders(): string[] {
    return Array.from(this.smsProviders.keys());
  }

  // Call provider management
  registerCallProvider(provider: CallProvider): void {
    this.callProviders.set(provider.providerName, provider);
  }

  getCallProvider(providerName: string): CallProvider | undefined {
    return this.callProviders.get(providerName);
  }

  getAvailableCallProviders(): string[] {
    return Array.from(this.callProviders.keys());
  }

  // Generic provider access
  getProvider(providerType: 'email' | 'sms' | 'calling', providerName: string): CommunicationProvider | undefined {
    switch (providerType) {
      case 'email':
        return this.getEmailProvider(providerName);
      case 'sms':
        return this.getSmsProvider(providerName);
      case 'calling':
        return this.getCallProvider(providerName);
      default:
        return undefined;
    }
  }

  getAllProviders(): { [key: string]: CommunicationProvider } {
    const allProviders: { [key: string]: CommunicationProvider } = {};
    
    // Add all email providers
    this.emailProviders.forEach((provider, name) => {
      allProviders[`email:${name}`] = provider;
    });
    
    // Add all SMS providers
    this.smsProviders.forEach((provider, name) => {
      allProviders[`sms:${name}`] = provider;
    });
    
    // Add all call providers
    this.callProviders.forEach((provider, name) => {
      allProviders[`calling:${name}`] = provider;
    });
    
    return allProviders;
  }
}

// Global registry instance
export const providerRegistry = new CommunicationProviderRegistry();