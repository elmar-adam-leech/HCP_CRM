import { google } from 'googleapis';
import type { EmailProvider, EmailResult } from './interfaces';
import { credentialService } from '../credential-service';
import { logger } from '../utils/logger';

const log = logger('GmailProvider');

export class GmailEmailProvider implements EmailProvider {
  readonly providerName = 'gmail';
  readonly providerType = 'email' as const;

  /**
   * Create Gmail client for a specific tenant
   */
  private async createGmailClient(contractorId: string) {
    const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'gmail');

    if (!credentials.client_id || !credentials.client_secret || !credentials.refresh_token) {
      throw new Error(`Gmail credentials not configured for contractor ${contractorId}`);
    }

    const oauth2Client = new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      'urn:ietf:wg:oauth:2.0:oob'
    );

    oauth2Client.setCredentials({
      refresh_token: credentials.refresh_token,
    });

    return {
      gmail: google.gmail({ version: 'v1', auth: oauth2Client }),
      userEmail: credentials.user_email ?? undefined
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
      const { gmail, userEmail } = await this.createGmailClient(options.contractorId);
      const fromEmail = options.fromEmail || userEmail || 'noreply@company.com';
      
      // Create the email message
      const email = [
        `To: ${options.to}`,
        `From: ${fromEmail}`,
        `Subject: ${options.subject}`,
        '',
        options.content,
      ].join('\n');

      // Encode the email in base64
      const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

      // Send the email
      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedEmail,
        },
      });

      return {
        success: true,
        messageId: response.data.id ?? undefined,
      };
    } catch (error) {
      log.error('Gmail send error', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  async checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }> {
    try {
      const { gmail } = await this.createGmailClient(contractorId);
      
      // Test connection by getting user profile
      await gmail.users.getProfile({ userId: 'me' });
      
      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async isConfigured(contractorId: string): Promise<boolean> {
    try {
      const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'gmail');
      return !!(credentials.client_id && credentials.client_secret && credentials.refresh_token);
    } catch {
      return false;
    }
  }
}
