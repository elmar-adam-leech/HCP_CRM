// Provider abstraction interfaces for multi-tenant communication services

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface EmailProvider {
  readonly providerName: string;
  readonly providerType: 'email';
  
  sendEmail(options: {
    to: string;
    subject: string;
    content: string;
    fromEmail?: string;
    contractorId: string;
  }): Promise<EmailResult>;
  
  checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }>;
  isConfigured(contractorId: string): Promise<boolean>;
}

export interface SmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface SmsProvider {
  readonly providerName: string;
  readonly providerType: 'sms';
  
  sendSms(options: {
    to: string;
    message: string;
    fromNumber?: string;
    contractorId: string;
    userId?: string;
  }): Promise<SmsResult>;
  
  checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }>;
  isConfigured(contractorId: string): Promise<boolean>;
}

export interface CallResult {
  success: boolean;
  callId?: string;
  callUrl?: string;
  error?: string;
}

export interface CallProvider {
  readonly providerName: string;
  readonly providerType: 'calling';
  
  initiateCall(options: {
    to: string;
    fromNumber?: string;
    autoRecord?: boolean;
    contractorId: string;
  }): Promise<CallResult>;
  
  getCallDetails(callId: string, contractorId: string): Promise<{ success: boolean; callDetails?: any; error?: string }>;
  checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }>;
  isConfigured(contractorId: string): Promise<boolean>;
}

export type CommunicationProvider = EmailProvider | SmsProvider | CallProvider;

export interface ProviderRegistry {
  // Email providers
  registerEmailProvider(provider: EmailProvider): void;
  getEmailProvider(providerName: string): EmailProvider | undefined;
  getAvailableEmailProviders(): string[];
  
  // SMS providers
  registerSmsProvider(provider: SmsProvider): void;
  getSmsProvider(providerName: string): SmsProvider | undefined;
  getAvailableSmsProviders(): string[];
  
  // Call providers
  registerCallProvider(provider: CallProvider): void;
  getCallProvider(providerName: string): CallProvider | undefined;
  getAvailableCallProviders(): string[];
  
  // Generic provider access
  getProvider(providerType: 'email' | 'sms' | 'calling', providerName: string): CommunicationProvider | undefined;
  getAllProviders(): { [key: string]: CommunicationProvider };
}