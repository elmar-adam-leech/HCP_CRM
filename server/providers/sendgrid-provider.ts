import * as sgMail from '@sendgrid/mail';
import { EmailProvider, EmailResult } from './interfaces';
import { credentialService } from '../credential-service';
import { logger } from '../utils/logger';

const log = logger('SendGridProvider');

export class SendGridEmailProvider implements EmailProvider {
  readonly providerName = 'sendgrid';
  readonly providerType = 'email' as const;

  private async getSendGridCredentials(contractorId: string): Promise<{ apiKey: string; fromEmail?: string }> {
    const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'sendgrid');
    
    if (!credentials.api_key) {
      throw new Error('SendGrid API key not configured for this contractor');
    }
    
    return {
      apiKey: credentials.api_key,
      fromEmail: credentials.from_email
    };
  }

  async sendEmail(options: {
    to: string;
    subject: string;
    content: string;
    fromEmail?: string;
    contractorId: string;
  }): Promise<EmailResult> {
    try {
      const { apiKey, fromEmail: configuredFromEmail } = await this.getSendGridCredentials(options.contractorId);
      sgMail.setApiKey(apiKey);

      const fromEmail = options.fromEmail || configuredFromEmail || 'noreply@company.com';
      
      const msg = {
        to: options.to,
        from: fromEmail,
        subject: options.subject,
        text: options.content,
        html: options.content.replace(/\n/g, '<br>'), // Simple HTML conversion
      };

      const response = await sgMail.send(msg);
      
      // SendGrid returns an array with response info
      const messageId = response[0]?.headers?.['x-message-id'] || 'unknown';

      return {
        success: true,
        messageId: messageId as string,
      };
    } catch (error: unknown) {
      log.error('SendGrid send error', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send email via SendGrid',
      };
    }
  }

  async checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }> {
    try {
      const { apiKey } = await this.getSendGridCredentials(contractorId);
      sgMail.setApiKey(apiKey);
      
      // Simple test to validate the API key
      // SendGrid doesn't have a direct "test connection" endpoint, 
      // but we can check if the API key format is valid
      if (!apiKey || !apiKey.startsWith('SG.')) {
        return { connected: false, error: 'Invalid SendGrid API key format' };
      }
      
      return { connected: true };
    } catch (error: unknown) {
      return { 
        connected: false, 
        error: error instanceof Error ? error.message : 'Failed to connect to SendGrid',
      };
    }
  }

  async isConfigured(contractorId: string): Promise<boolean> {
    try {
      const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'sendgrid');
      return !!credentials.api_key;
    } catch {
      return false;
    }
  }
}
