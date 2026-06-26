import crypto from 'crypto';
import { storage } from './storage';
import { logger } from './utils/logger';

const log = logger('CredentialService');

// Encryption configuration
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = (() => {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  
  if (process.env.NODE_ENV === 'production' && (!key || key.length < 64)) {
    log.error('CRITICAL SECURITY ERROR: CREDENTIAL_ENCRYPTION_KEY must be set to a secure 64-character hex string in production!');
    log.error('Generate a secure key with: node -e "log.info(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
  
  if (!key) {
    log.warn('WARNING: Using default CREDENTIAL_ENCRYPTION_KEY for development. Set CREDENTIAL_ENCRYPTION_KEY environment variable for security.');
    // Use a consistent key for development to avoid decryption issues across restarts
    return 'a'.repeat(64); // Simple but consistent 64-character key for development
  }
  
  return key;
})();

interface EncryptedCredential {
  encryptedValue: string;
  iv: string;
  authTag: string;
}

interface TenantCredentials {
  gmail?: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    userEmail?: string;
  };
  dialpad?: {
    apiKey?: string;
    baseUrl?: string;
  };
  twilio?: {
    accountSid?: string;
    authToken?: string;
    apiKeySid?: string;
    apiKeySecret?: string;
  };
}

export class CredentialService {
  /**
   * Encrypt a credential value for secure storage using AES-256-GCM
   */
  private static encrypt(value: string): EncryptedCredential {
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Get authentication tag for GCM mode
    const authTag = cipher.getAuthTag();
    
    return {
      encryptedValue: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  }

  /**
   * Decrypt a credential value from storage using AES-256-GCM
   */
  private static decrypt(encryptedCredential: EncryptedCredential): string {
    try {
      const iv = Buffer.from(encryptedCredential.iv, 'hex');
      const key = Buffer.from(ENCRYPTION_KEY, 'hex');
      const authTag = Buffer.from(encryptedCredential.authTag, 'hex');
      
      // Validate auth tag length to prevent truncation attacks
      if (authTag.length !== 16) {
        throw new Error('Invalid authentication tag length - expected 16 bytes');
      }
      
      const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, {
        authTagLength: 16
      });
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encryptedCredential.encryptedValue, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      log.error('Credential decryption failed:', error);
      throw new Error('Failed to decrypt credential - data may be corrupted or tampered with');
    }
  }

  /**
   * Store encrypted credential for a tenant
   */
  static async setCredential(
    tenantId: string, 
    service: string, 
    credentialKey: string, 
    value: string
  ): Promise<void> {
    const encrypted = this.encrypt(value);
    const encryptedData = JSON.stringify(encrypted);
    
    await storage.setContractorCredential(tenantId, service, credentialKey, encryptedData);
  }

  /**
   * Retrieve and decrypt credential for a tenant
   */
  static async getCredential(
    tenantId: string, 
    service: string, 
    credentialKey: string
  ): Promise<string | null> {
    const credential = await storage.getContractorCredential(tenantId, service, credentialKey);
    
    if (!credential || !credential.isActive) {
      return null;
    }
    
    try {
      const encryptedData: EncryptedCredential = JSON.parse(credential.encryptedValue);
      return this.decrypt(encryptedData);
    } catch (error) {
      log.error('Failed to parse encrypted credential:', error);
      return null;
    }
  }

  /**
   * Get all credentials for a tenant and service
   */
  static async getServiceCredentials(tenantId: string, service: string): Promise<Record<string, string>> {
    const credentials = await storage.getContractorServiceCredentials(tenantId, service);
    const result: Record<string, string> = {};
    
    for (const cred of credentials) {
      if (cred.isActive) {
        try {
          const encryptedData: EncryptedCredential = JSON.parse(cred.encryptedValue);
          result[cred.credentialKey] = this.decrypt(encryptedData);
        } catch (error) {
          log.error(`Failed to decrypt credential ${cred.credentialKey}:`, error);
        }
      }
    }
    
    return result;
  }

  /**
   * Get structured credentials for Gmail service
   */
  static async getGmailCredentials(tenantId: string): Promise<TenantCredentials['gmail']> {
    const creds = await this.getServiceCredentials(tenantId, 'gmail');
    return {
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      refreshToken: creds.refresh_token,
      userEmail: creds.user_email
    };
  }

  /**
   * Get structured credentials for Dialpad service
   */
  static async getDialpadCredentials(tenantId: string): Promise<TenantCredentials['dialpad']> {
    const creds = await this.getServiceCredentials(tenantId, 'dialpad');
    return {
      apiKey: creds.api_key,
      baseUrl: creds.base_url || 'https://dialpad.com/api/v2'
    };
  }

  /**
   * Get structured credentials for Twilio service (task #822)
   */
  static async getTwilioCredentials(tenantId: string): Promise<TenantCredentials['twilio']> {
    const creds = await this.getServiceCredentials(tenantId, 'twilio');
    return {
      accountSid: creds.account_sid,
      authToken: creds.auth_token,
      apiKeySid: creds.api_key_sid,
      apiKeySecret: creds.api_key_secret,
    };
  }

  /**
   * Check if tenant has required credentials for a service
   */
  static async hasRequiredCredentials(tenantId: string, service: string): Promise<boolean> {
    const creds = await this.getServiceCredentials(tenantId, service);
    
    switch (service) {
      case 'gmail':
        return !!(creds.client_id && creds.client_secret && creds.refresh_token);
      case 'dialpad':
        return !!(creds.api_key);
      case 'housecall-pro':
        return !!(creds.api_key);
      case 'sendgrid':
        return !!(creds.api_key);
      case 'twilio':
        return !!(creds.account_sid && creds.auth_token);
      default:
        return false;
    }
  }

  /**
   * Disable/delete credential for a tenant
   */
  static async disableCredential(
    tenantId: string, 
    service: string, 
    credentialKey: string
  ): Promise<void> {
    await storage.disableContractorCredential(tenantId, service, credentialKey);
  }

  /**
   * Get masked credentials for display (sensitive data hidden)
   */
  static async getMaskedCredentials(tenantId: string, service: string): Promise<Record<string, string>> {
    const credentials = await storage.getContractorServiceCredentials(tenantId, service);
    const maskedCreds: Record<string, string> = {};

    for (const cred of credentials) {
      if (cred.isActive) {
        try {
          const decryptedValue = await this.getCredential(tenantId, service, cred.credentialKey);
          if (decryptedValue) {
            // Mask the value - show first 3 and last 4 characters with dots in between
            const masked = decryptedValue.length > 7 
              ? `${decryptedValue.substring(0, 3)}${'•'.repeat(Math.min(20, decryptedValue.length - 7))}${decryptedValue.substring(decryptedValue.length - 4)}`
              : '•'.repeat(decryptedValue.length);
            maskedCreds[cred.credentialKey] = masked;
          }
        } catch (error) {
          log.error(`Failed to decrypt credential ${cred.credentialKey}:`, error);
          maskedCreds[cred.credentialKey] = '••••••••••••••••••••';
        }
      }
    }

    return maskedCreds;
  }

  /**
   * Delete all credentials for an integration
   */
  static async deleteIntegrationCredentials(tenantId: string, service: string): Promise<void> {
    const credentials = await storage.getContractorServiceCredentials(tenantId, service);
    
    for (const cred of credentials) {
      await storage.disableContractorCredential(tenantId, service, cred.credentialKey);
    }
  }

  /**
   * Get fallback to environment variables if tenant credentials don't exist
   */
  static async getCredentialsWithFallback(tenantId: string, service: string): Promise<Record<string, string>> {
    const tenantCreds = await this.getServiceCredentials(tenantId, service);
    
    // If tenant has no credentials, only fallback to environment variables for specific services
    if (Object.keys(tenantCreds).length === 0) {
      switch (service) {
        case 'gmail':
          // Gmail can fallback to system-wide OAuth app credentials
          log.warn(`No tenant credentials found for ${service}, falling back to environment variables`);
          return {
            client_id: process.env.GMAIL_CLIENT_ID || '',
            client_secret: process.env.GMAIL_CLIENT_SECRET || '',
            refresh_token: process.env.GMAIL_REFRESH_TOKEN || '',
            user_email: process.env.GMAIL_USER_EMAIL || ''
          };
        case 'dialpad':
          // Dialpad requires contractor-specific credentials - no global fallback
          log.warn(`No tenant credentials found for ${service} - contractor must configure their own credentials`);
          return {};
        case 'twilio':
          // Twilio requires contractor-specific credentials - no global fallback
          log.warn(`No tenant credentials found for ${service} - contractor must configure their own credentials`);
          return {};
        case 'sendgrid':
          // SendGrid can fallback to system-wide API key
          log.warn(`No tenant credentials found for ${service}, falling back to environment variables`);
          return {
            api_key: process.env.SENDGRID_API_KEY || ''
          };
        default:
          return {};
      }
    }
    
    return tenantCreds;
  }
}

export const credentialService = CredentialService;