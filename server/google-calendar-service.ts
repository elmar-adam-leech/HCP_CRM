import { google } from 'googleapis';
import crypto from 'crypto';
import { db } from './db';
import { oauthStates } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logger } from './utils/logger';

const log = logger('GoogleCalendarService');

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const STATE_EXPIRATION_MINUTES = 10;

// Lazy-load and validate encryption key (shared CREDENTIAL_ENCRYPTION_KEY,
// same key used by gmail-service so the two integrations share the secret).
let ENCRYPTION_KEY: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (ENCRYPTION_KEY) {
    return ENCRYPTION_KEY;
  }

  const key = process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;

  if (!key) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable must be set (32 bytes, hex-encoded).');
  }

  const keyBuffer = Buffer.from(key, 'hex');

  if (keyBuffer.length !== 32) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). Got ${keyBuffer.length} bytes.`);
  }

  ENCRYPTION_KEY = keyBuffer;
  return keyBuffer;
}

function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();
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

export interface BusyWindow {
  start: Date;
  end: Date;
}

/**
 * Thrown when a Google Calendar refresh token is no longer valid (revoked or
 * expired). Callers should mark the user disconnected and prompt a reconnect.
 */
export class GoogleCalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleCalendarAuthError';
  }
}

function isAuthError(error: any): boolean {
  return (
    error?.code === 401 ||
    error?.code === 403 ||
    error?.response?.status === 401 ||
    error?.response?.status === 403 ||
    error?.message?.includes('invalid_grant') ||
    error?.message?.includes('Token has been expired') ||
    error?.message?.includes('Token has been revoked') ||
    error?.message?.includes('invalid_token')
  );
}

export class GoogleCalendarService {
  private clientId: string;
  private clientSecret: string;
  private allowedDomains: Set<string>;

  constructor() {
    this.clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    this.clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

    const rawDomains =
      process.env.ALLOWED_REDIRECT_DOMAINS ||
      process.env.REPLIT_DOMAINS ||
      'localhost:5000';
    const domains = rawDomains.split(',').map(d => d.trim()).filter(Boolean);
    this.allowedDomains = new Set(domains);

    log.info('[Google Calendar OAuth] Allowed redirect domains:', Array.from(this.allowedDomains));
  }

  validateHost(host: string): boolean {
    return this.allowedDomains.has(host);
  }

  private getOAuth2Client(redirectHost: string) {
    const protocol = redirectHost.startsWith('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${redirectHost}/api/oauth/google-calendar/callback`;

    return new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      redirectUri
    );
  }

  /**
   * Build an authenticated Calendar client from a user's stored (encrypted)
   * refresh token.
   */
  private createCalendarClient(refreshToken: string, redirectHost: string = 'localhost:5000') {
    const oauth2Client = this.getOAuth2Client(redirectHost);
    const decryptedToken = decrypt(refreshToken);
    oauth2Client.setCredentials({ refresh_token: decryptedToken });
    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  /**
   * Generate authorization URL for a user to connect their Google Calendar.
   * Reuses the shared oauthStates table (same CSRF-state mechanism as Gmail).
   */
  async generateAuthUrl(userId: string, redirectHost: string): Promise<string> {
    if (!this.validateHost(redirectHost)) {
      throw new Error(`Invalid redirect host: ${redirectHost}. Must be one of: ${Array.from(this.allowedDomains).join(', ')}`);
    }

    const oauth2Client = this.getOAuth2Client(redirectHost);
    const state = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + STATE_EXPIRATION_MINUTES * 60 * 1000);

    await db.insert(oauthStates).values({
      state,
      userId,
      redirectHost,
      expiresAt,
    });

    log.info(`[Google Calendar OAuth] Created state token for user ${userId}, expires at ${expiresAt.toISOString()}`);

    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ];

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state,
    });
  }

  /**
   * Atomically consume a state token (single-use CSRF protection).
   */
  async getStateData(state: string): Promise<{ userId: string; redirectHost: string } | null> {
    try {
      const deletedRecords = await db.delete(oauthStates)
        .where(eq(oauthStates.state, state))
        .returning();

      if (deletedRecords.length === 0) {
        log.error('[Google Calendar OAuth] No matching state token found (may have already been used)');
        return null;
      }

      const stateRecord = deletedRecords[0];

      if (stateRecord.expiresAt < new Date()) {
        log.error('[Google Calendar OAuth] State expired for user:', stateRecord.userId);
        return null;
      }

      log.info(`[Google Calendar OAuth] Validated and consumed state token for user ${stateRecord.userId}`);

      return {
        userId: stateRecord.userId,
        redirectHost: stateRecord.redirectHost,
      };
    } catch (error) {
      log.error('[Google Calendar OAuth] Error looking up state token:', error);
      return null;
    }
  }

  /**
   * Exchange an authorization code for an encrypted refresh token + account email.
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

    oauth2Client.setCredentials(tokens);

    // Resolve the primary calendar's id (equals the account email) so we can
    // display which Google account is connected.
    let email = '';
    try {
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const primary = await calendar.calendars.get({ calendarId: 'primary' });
      email = primary.data.id || primary.data.summary || '';
    } catch (err) {
      log.warn('[Google Calendar] Could not resolve primary calendar email (non-fatal):', err instanceof Error ? err.message : err);
    }

    return {
      refreshToken: encrypt(tokens.refresh_token),
      email,
    };
  }

  /**
   * Fetch busy windows for the primary calendar between two instants.
   * Throws GoogleCalendarAuthError on revoked/expired tokens so the caller can
   * mark the user disconnected; throws other errors for transient failures.
   */
  async getBusyWindows(refreshToken: string, timeMin: Date, timeMax: Date): Promise<BusyWindow[]> {
    try {
      const calendar = this.createCalendarClient(refreshToken);
      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          items: [{ id: 'primary' }],
        },
      });

      const busy = response.data.calendars?.primary?.busy || [];
      return busy
        .filter(b => b.start && b.end)
        .map(b => ({ start: new Date(b.start!), end: new Date(b.end!) }));
    } catch (error: any) {
      if (isAuthError(error)) {
        log.error('[Google Calendar] Auth error fetching busy windows:', error?.message);
        throw new GoogleCalendarAuthError(error?.message || 'Google Calendar authorization expired');
      }
      log.error('[Google Calendar] Error fetching busy windows:', error?.message);
      throw error;
    }
  }

  /**
   * Create a calendar event on the user's primary calendar.
   * Returns the created event id. Throws GoogleCalendarAuthError on
   * revoked/expired tokens; throws other errors for transient failures.
   */
  async createEvent(refreshToken: string, event: {
    summary: string;
    description?: string;
    location?: string;
    startTime: Date;
    endTime: Date;
    timezone?: string;
    attendees?: string[];
  }): Promise<string> {
    try {
      const calendar = this.createCalendarClient(refreshToken);
      const response = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: event.summary,
          description: event.description,
          location: event.location,
          start: {
            dateTime: event.startTime.toISOString(),
            timeZone: event.timezone,
          },
          end: {
            dateTime: event.endTime.toISOString(),
            timeZone: event.timezone,
          },
          attendees: event.attendees?.filter(Boolean).map(email => ({ email })),
        },
      });

      const eventId = response.data.id;
      if (!eventId) {
        throw new Error('Google Calendar did not return an event id');
      }
      return eventId;
    } catch (error: any) {
      if (isAuthError(error)) {
        log.error('[Google Calendar] Auth error creating event:', error?.message);
        throw new GoogleCalendarAuthError(error?.message || 'Google Calendar authorization expired');
      }
      log.error('[Google Calendar] Error creating event:', error?.message);
      throw error;
    }
  }

  async checkConnection(refreshToken: string): Promise<{ connected: boolean; email?: string; error?: string }> {
    try {
      const calendar = this.createCalendarClient(refreshToken);
      const primary = await calendar.calendars.get({ calendarId: 'primary' });
      return {
        connected: true,
        email: primary.data.id || primary.data.summary || undefined,
      };
    } catch (error) {
      log.error('[Google Calendar] Connection check failed:', error);
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  validateEncryptionKey(): void {
    getEncryptionKey();
  }
}

export const googleCalendarService = new GoogleCalendarService();
