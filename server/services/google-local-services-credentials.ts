/**
 * Per-tenant Google Local Services credential resolver.
 *
 * Returns the effective {clientId, clientSecret, developerToken, source} that
 * should be used for any GLS API call for a given tenant. Tenant-stored values
 * (in the credential service) take precedence over platform-level env vars.
 *
 * The "source" field reflects which side supplied the developer token, since
 * that's the value Google attaches its API quota and ToS to. If a tenant has
 * stored a developer_token, the call is going out under their MCC and we
 * report 'tenant'; otherwise we fall back to the platform value (if any) and
 * report 'platform'.
 *
 * For OAuth credentials (client_id/client_secret) the rule is: if a tenant
 * stored a client_id we use that pair; otherwise we fall back to the platform
 * pair. We never mix-and-match (e.g. tenant client_id with platform secret).
 */
import { CredentialService } from '../credential-service';
import { GLS_SERVICE } from '../sync/google-local-services-leads';

export type GlsCredentialSource = 'tenant' | 'platform';

export interface GlsCredentials {
  clientId: string | null;
  clientSecret: string | null;
  developerToken: string | null;
  /** Which side supplied the developer token. */
  source: GlsCredentialSource;
  /** Which side supplied the OAuth client (may differ from `source`). */
  oauthSource: GlsCredentialSource;
  /** True if everything required to talk to Google is present. */
  configured: boolean;
}

export const TENANT_CRED_KEYS = {
  clientId: 'tenant_client_id',
  clientSecret: 'tenant_client_secret',
  developerToken: 'tenant_developer_token',
  /** Which client_id issued the currently-stored refresh_token. */
  refreshTokenClientId: 'refresh_token_client_id',
} as const;

function readPlatform(): { clientId: string | null; clientSecret: string | null; developerToken: string | null } {
  return {
    clientId: process.env.GOOGLE_LOCAL_SERVICES_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_LOCAL_SERVICES_CLIENT_SECRET || null,
    developerToken: process.env.GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN || null,
  };
}

export async function resolveGlsCredentials(tenantId: string): Promise<GlsCredentials> {
  const [tenantClientId, tenantClientSecret, tenantDevToken] = await Promise.all([
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientId),
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientSecret),
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.developerToken),
  ]);
  const platform = readPlatform();

  const useTenantOauth = !!tenantClientId && !!tenantClientSecret;
  const clientId = useTenantOauth ? tenantClientId : platform.clientId;
  const clientSecret = useTenantOauth ? tenantClientSecret : platform.clientSecret;

  const useTenantDev = !!tenantDevToken;
  const developerToken = useTenantDev ? tenantDevToken : platform.developerToken;

  return {
    clientId,
    clientSecret,
    developerToken,
    source: useTenantDev ? 'tenant' : 'platform',
    oauthSource: useTenantOauth ? 'tenant' : 'platform',
    configured: !!clientId && !!clientSecret && !!developerToken,
  };
}

/** Did the tenant explicitly store any of the per-tenant credentials? */
export async function hasAnyTenantCredentials(tenantId: string): Promise<boolean> {
  const [a, b, c] = await Promise.all([
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientId),
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientSecret),
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.developerToken),
  ]);
  return !!(a || b || c);
}
