import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import crypto from 'crypto';
import { db } from './db';
import { oauthStates } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from './utils/logger';
import { htmlToPlainText } from './utils/text';
import { maskEmail } from './utils/pii-redactor';

const log = logger('GmailService');

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const STATE_EXPIRATION_MINUTES = 10;

// Lazy-load and validate encryption key
let ENCRYPTION_KEY: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (ENCRYPTION_KEY) {
    return ENCRYPTION_KEY;
  }
  
  // Use existing CREDENTIAL_ENCRYPTION_KEY from production secrets
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
  
  if (!key) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable must be set (32 bytes, hex-encoded). Generate one with: node -e "log.info(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  
  const keyBuffer = Buffer.from(key, 'hex');
  
  if (keyBuffer.length !== 32) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). Got ${keyBuffer.length} bytes.`);
  }
  
  ENCRYPTION_KEY = keyBuffer;
  return keyBuffer;
}

/**
 * Encrypt sensitive data (like refresh tokens)
 */
function encrypt(text: string): string {
  const key = getEncryptionKey(); // Validates key on first use
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 */
function decrypt(encryptedText: string): string {
  const key = getEncryptionKey(); // Validates key on first use
  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}


export class GmailService {
  private clientId: string;
  private clientSecret: string;
  private allowedDomains: Set<string>;

  constructor() {
    this.clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    this.clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
    
    // Build allowlist — check ALLOWED_REDIRECT_DOMAINS first (for external deployments),
    // then REPLIT_DOMAINS (auto-set by Replit), then fall back to localhost for dev.
    const rawDomains =
      process.env.ALLOWED_REDIRECT_DOMAINS ||
      process.env.REPLIT_DOMAINS ||
      'localhost:5000';
    const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
    this.allowedDomains = new Set(domains);

    log.info('[Gmail OAuth] Allowed redirect domains:', Array.from(this.allowedDomains));
  }

  /**
   * Validate that a host is in the allowlist
   */
  validateHost(host: string): boolean {
    return this.allowedDomains.has(host);
  }

  /**
   * Get OAuth2 client instance with dynamic redirect URI
   */
  private getOAuth2Client(redirectHost: string) {
    const protocol = redirectHost.startsWith('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${redirectHost}/api/oauth/gmail/callback`;
    
    return new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      redirectUri
    );
  }

  /**
   * Create Gmail client for a specific user using their stored refresh token
   */
  private async createGmailClient(refreshToken: string, redirectHost: string = 'localhost:5000') {
    try {
      const oauth2Client = this.getOAuth2Client(redirectHost);
      
      // Decrypt the refresh token
      log.info('[Gmail] Decrypting refresh token...');
      const decryptedToken = decrypt(refreshToken);
      log.info('[Gmail] Refresh token decrypted successfully');
      
      oauth2Client.setCredentials({
        refresh_token: decryptedToken,
      });

      log.info('[Gmail] OAuth2 credentials set, creating Gmail client...');
      return google.gmail({ version: 'v1', auth: oauth2Client });
    } catch (error: any) {
      log.error('[Gmail] Error creating Gmail client:', {
        message: error.message,
        code: error.code,
        stack: error.stack?.split('\n').slice(0, 3).join('\n')
      });
      throw error;
    }
  }

  /**
   * Generate authorization URL for user to connect their Gmail
   */
  async generateAuthUrl(userId: string, redirectHost: string): Promise<string> {
    if (!this.validateHost(redirectHost)) {
      throw new Error(`Invalid redirect host: ${redirectHost}. Must be one of: ${Array.from(this.allowedDomains).join(', ')}`);
    }

    const oauth2Client = this.getOAuth2Client(redirectHost);
    
    // Generate secure random state token for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');
    
    // Calculate expiration time (10 minutes from now)
    const expiresAt = new Date(Date.now() + STATE_EXPIRATION_MINUTES * 60 * 1000);
    
    // Store state token in database for persistence across restarts
    await db.insert(oauthStates).values({
      state,
      userId,
      redirectHost,
      expiresAt,
    });
    
    log.info(`[Gmail OAuth] Created state token for user ${userId}, expires at ${expiresAt.toISOString()}`);
    
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ];

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent', // Force consent to get refresh token
      state: state, // Secure random state for CSRF protection
    });
  }

  /**
   * Get user data from state token
   * Returns userId and redirectHost for the OAuth callback
   * Uses atomic DELETE ... RETURNING to prevent race conditions (single-use guarantee)
   */
  async getStateData(state: string): Promise<{ userId: string; redirectHost: string } | null> {
    try {
      // Atomic delete-and-return: ensures single-use semantics for CSRF protection
      // If another request tries to use the same state token, it will get no results
      const deletedRecords = await db.delete(oauthStates)
        .where(eq(oauthStates.state, state))
        .returning();
      
      if (deletedRecords.length === 0) {
        log.error('[Gmail OAuth] No matching state token found in database (may have already been used)');
        return null;
      }
      
      const stateRecord = deletedRecords[0];
      
      // Check if state is expired
      const now = new Date();
      if (stateRecord.expiresAt < now) {
        log.error('[Gmail OAuth] State expired for user:', stateRecord.userId);
        // State was already deleted, no need to clean up
        return null;
      }
      
      log.info(`[Gmail OAuth] Validated and consumed state token for user ${stateRecord.userId}`);
      
      return {
        userId: stateRecord.userId,
        redirectHost: stateRecord.redirectHost,
      };
    } catch (error) {
      log.error('[Gmail OAuth] Error looking up state token:', error);
      return null;
    }
  }

  /**
   * Get userId from state token (legacy method - kept for compatibility)
   */
  async getUserIdFromState(state: string): Promise<string | null> {
    const data = await this.getStateData(state);
    return data ? data.userId : null;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string, redirectHost: string): Promise<{
    refreshToken: string;
    email: string;
  }> {
    const oauth2Client = this.getOAuth2Client(redirectHost);
    
    const { tokens } = await oauth2Client.getToken(code);
    
    if (!tokens.refresh_token) {
      throw new Error('No refresh token received. User may have already authorized this app.');
    }

    // Get user's email address
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    
    return {
      refreshToken: encrypt(tokens.refresh_token),
      email: profile.data.emailAddress || '',
    };
  }

  async sendEmail(options: {
    to: string;
    subject: string;
    content: string;
    fromEmail?: string;
    fromName?: string; // Display name for the sender
    refreshToken: string; // User's encrypted refresh token
  }): Promise<{ success: boolean; messageId?: string; rfc822MessageId?: string; error?: string }> {
    try {
      const gmail = await this.createGmailClient(options.refreshToken);
      
      // Format the From header with display name if provided
      let fromHeader = '';
      if (options.fromEmail) {
        if (options.fromName) {
          // Quote the display name to properly handle special characters like "@"
          // Format as "Display Name" <email@domain.com>
          fromHeader = `From: "${options.fromName}" <${options.fromEmail}>`;
        } else {
          fromHeader = `From: ${options.fromEmail}`;
        }
      }
      
      // Create the email message with HTML support
      const headers = [
        `To: ${options.to}`,
        fromHeader,
        `Subject: ${options.subject}`,
        'Content-Type: text/html; charset=utf-8',
      ].filter(Boolean).join('\r\n');
      
      // Add blank line separator between headers and body
      const email = headers + '\r\n\r\n' + options.content;
      
      // Debug log to verify the From header
      log.info('[Gmail] Sending email with headers:', {
        to: maskEmail(options.to),
        from: fromHeader ? `[masked from header]` : '',
        subject: options.subject,
        fromName: options.fromName,
      });

      // Encode the email in base64
      const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      // Send the email
      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedEmail,
        },
      });

      log.info('[Gmail] Email sent successfully:', response.data.id);

      // Refetch the just-sent message to extract the RFC822 Message-Id header.
      // This is the value that will appear in the recipient's In-Reply-To /
      // References headers when they reply, so storing it on the outbound
      // activity lets us thread inbound replies back to the right contact.
      let rfc822MessageId: string | undefined;
      if (response.data.id) {
        try {
          const meta = await gmail.users.messages.get({
            userId: 'me',
            id: response.data.id,
            format: 'metadata',
            metadataHeaders: ['Message-Id'],
          });
          const header = meta.data.payload?.headers?.find(
            h => h.name?.toLowerCase() === 'message-id'
          );
          rfc822MessageId = header?.value || undefined;
        } catch (metaErr: any) {
          log.warn('[Gmail] Failed to fetch Message-Id header for sent email', {
            id: response.data.id,
            error: metaErr?.message,
          });
        }
      }

      return {
        success: true,
        messageId: response.data.id || undefined,
        rfc822MessageId,
      };
    } catch (error) {
      log.error('[Gmail] Error sending email:', error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error sending email',
      };
    }
  }

  async checkConnection(refreshToken: string): Promise<{ connected: boolean; email?: string; error?: string }> {
    try {
      const gmail = await this.createGmailClient(refreshToken);
      const profile = await gmail.users.getProfile({ userId: 'me' });
      return {
        connected: true,
        email: profile.data.emailAddress || undefined,
      };
    } catch (error) {
      log.error('[Gmail] Connection check failed:', error);
      return { 
        connected: false, 
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Fetch only the RFC822 Message-Id header for a previously sent (or received)
   * Gmail message identified by its Gmail message id. Used by the backfill
   * script that populates `metadata.rfc822MessageId` on historic outbound
   * activities so reply-thread matching works against pre-existing history.
   *
   * Returns the header value (already trimmed) or undefined when the message
   * is not accessible or has no Message-Id header. Throws on auth/network
   * errors so the caller can decide whether to abort.
   */
  async fetchMessageIdHeader(
    refreshToken: string,
    gmailMessageId: string,
  ): Promise<string | undefined> {
    const gmail = await this.createGmailClient(refreshToken);
    const meta = await gmail.users.messages.get({
      userId: 'me',
      id: gmailMessageId,
      format: 'metadata',
      metadataHeaders: ['Message-Id'],
    });
    const header = meta.data.payload?.headers?.find(
      h => h.name?.toLowerCase() === 'message-id'
    );
    const value = header?.value?.trim();
    return value || undefined;
  }

  /**
   * Validate encryption key is configured (for pre-flight checks)
   */
  validateEncryptionKey(): void {
    getEncryptionKey(); // Will throw if not configured
  }

  private parseEmailHeaders(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): {
    from: string;
    to: string[];
    subject: string;
    date: string;
    rfc822MessageId: string;
    inReplyTo: string;
    references: string[];
  } {
    const result = {
      from: '',
      to: [] as string[],
      subject: '',
      date: '',
      rfc822MessageId: '',
      inReplyTo: '',
      references: [] as string[],
    };

    if (!headers) return result;

    for (const header of headers) {
      const name = header.name?.toLowerCase();
      const value = header.value || '';

      switch (name) {
        case 'from':
          result.from = value;
          break;
        case 'to':
          result.to = value.split(',').map(email => email.trim());
          break;
        case 'subject':
          result.subject = value;
          break;
        case 'date':
          result.date = value;
          break;
        case 'message-id':
          result.rfc822MessageId = value.trim();
          break;
        case 'in-reply-to':
          result.inReplyTo = value.trim();
          break;
        case 'references':
          // Per RFC 5322 the References header is a whitespace-separated list of
          // angle-bracketed message ids.
          result.references = value.split(/\s+/).map(s => s.trim()).filter(Boolean);
          break;
      }
    }

    return result;
  }

  private extractEmailAddress(emailString: string): string {
    const match = emailString.match(/<(.+?)>/);
    return match ? match[1] : emailString.trim();
  }

  private decodeBase64(data: string): string {
    const replaced = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(replaced, 'base64').toString('utf-8');
  }

  private getEmailBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return '';

    if (payload.body?.data) {
      const decoded = this.decodeBase64(payload.body.data);
      if (payload.mimeType === 'text/html') {
        return htmlToPlainText(decoded);
      }
      return decoded;
    }

    if (payload.parts) {
      // Prefer plain text — check text/plain first to avoid storing raw HTML
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return this.decodeBase64(part.body.data);
        }
      }

      // Fall back to HTML only if no plain text part exists
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return htmlToPlainText(this.decodeBase64(part.body.data));
        }
      }

      for (const part of payload.parts) {
        const body = this.getEmailBody(part);
        if (body) return body;
      }
    }

    return '';
  }

  async fetchNewEmails(refreshToken: string, sinceDate?: Date): Promise<{
    emails: Array<{
      id: string;
      threadId: string;
      from: string;
      to: string[];
      subject: string;
      body: string;
      date: Date;
      snippet: string;
      labelIds: string[]; // Gmail system labels e.g. ['SENT'], ['INBOX']
      // RFC822 thread headers used to attribute inbound replies back to the
      // original outbound activity even when the sender's address is not yet
      // on the contact (spouse replying, reply-from-phone, etc.).
      rfc822MessageId?: string;
      inReplyTo?: string;
      references?: string[];
    }>;
    tokenExpired?: boolean;
    error?: string;
  }> {
    try {
      log.info('[Gmail] Starting email fetch...', { 
        hasSinceDate: !!sinceDate,
        sinceDate: sinceDate?.toISOString()
      });

      const gmail = await this.createGmailClient(refreshToken);
      log.info('[Gmail] Gmail client created successfully');
      
      // Fetch both inbox and sent emails to capture all communication
      let query = 'in:inbox OR in:sent';
      if (sinceDate) {
        const epochSeconds = Math.floor(sinceDate.getTime() / 1000);
        query += ` after:${epochSeconds}`;
      }

      log.info('[Gmail] Listing messages with query:', query);
      const listResponse = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 100, // Increased since we're fetching both inbox and sent
      });

      const messages = listResponse.data.messages || [];
      log.info(`[Gmail] Found ${messages.length} message(s) to fetch`);
      
      const emailMessages = [];

      // Fetch up to 10 messages concurrently instead of sequentially
      const CONCURRENCY = 10;
      const validMessages = messages.filter(m => m.id);
      for (let i = 0; i < validMessages.length; i += CONCURRENCY) {
        const batch = validMessages.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.allSettled(
          batch.map(message => gmail.users.messages.get({
            userId: 'me',
            id: message.id!,
            format: 'full',
          }))
        );
        for (const result of batchResults) {
          if (result.status === 'rejected') {
            log.error('[Gmail] Error fetching message in batch:', result.reason?.message);
            continue;
          }
          const fullMessage = result.value;
          try {
            const headers = this.parseEmailHeaders(fullMessage.data.payload?.headers);
            const body = this.getEmailBody(fullMessage.data.payload);
            emailMessages.push({
              id: fullMessage.data.id || '',
              threadId: fullMessage.data.threadId || '',
              from: this.extractEmailAddress(headers.from),
              to: headers.to.map(email => this.extractEmailAddress(email)),
              subject: headers.subject,
              body: body,
              date: headers.date ? new Date(headers.date) : new Date(),
              snippet: fullMessage.data.snippet || '',
              labelIds: fullMessage.data.labelIds || [],
              rfc822MessageId: headers.rfc822MessageId || undefined,
              inReplyTo: headers.inReplyTo || undefined,
              references: headers.references.length > 0 ? headers.references : undefined,
            });
          } catch (parseError: any) {
            log.error(`[Gmail] Error parsing message ${fullMessage.data.id}:`, parseError.message);
          }
        }
      }

      log.info(`[Gmail] Successfully fetched ${emailMessages.length} emails`);
      return { emails: emailMessages };
    } catch (error: any) {
      log.error('[Gmail] Error fetching emails:', {
        message: error.message,
        code: error.code,
        status: error.status,
        errors: error.errors,
        stack: error.stack?.split('\n').slice(0, 3).join('\n')
      });
      
      // Detect token expiration errors
      const isTokenExpired = 
        error.code === 401 || 
        error.code === 403 ||
        error.message?.includes('invalid_grant') ||
        error.message?.includes('Token has been expired') ||
        error.message?.includes('Token has been revoked') ||
        error.response?.data?.error === 'invalid_grant';
      
      if (isTokenExpired) {
        log.error('[Gmail] Token expired or revoked - user needs to reconnect Gmail');
        return { 
          emails: [], 
          tokenExpired: true, 
          error: 'Gmail access has expired. Please reconnect your Gmail account.' 
        };
      } else if (error.code === 429) {
        log.error('[Gmail] Rate limit exceeded - too many requests to Gmail API');
        return { emails: [], error: 'Rate limit exceeded' };
      } else if (error.code >= 500) {
        log.error('[Gmail] Gmail API server error - temporary issue with Google servers');
        return { emails: [], error: 'Gmail API server error' };
      }
      
      return { emails: [], error: error.message };
    }
  }
}

export const gmailService = new GmailService();