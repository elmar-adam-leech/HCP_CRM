import { sendEmail } from '../emails/client';
import { storage } from '../storage';
import { logger } from '../utils/logger';

const log = logger('HcpIncidentEmail');

export type HcpIncidentKind =
  | 'staleness'
  | 'rejection'
  | 'health-check-failure'
  | 'subscription-missing';

export interface HcpIncidentEmailParams {
  contractorId: string;
  kind: HcpIncidentKind;
  subject: string;
  /**
   * Plain-text body. Will be rendered into a minimal HTML wrapper. Use \n\n
   * to break paragraphs.
   */
  body: string;
  /**
   * Optional deep-link to surface in the email (typically the integrations
   * settings page). The email recipient won't have host context so this
   * MUST be a fully-qualified URL.
   */
  link?: string;
}

/**
 * Out-of-band SendGrid notification for HCP webhook incidents.
 *
 * Used IN ADDITION TO the existing in-app notification so admins are
 * paged even if (a) nobody is logged in to the CRM, or (b) the CRM
 * itself is what's failing (Task #684 — the original outage was
 * silent precisely because the in-app notification path depends on
 * the same DB queries that were timing out).
 *
 * Failures here are logged but never thrown — email delivery must
 * never block the health checker from making progress on other work.
 */
/**
 * @returns `attempted` — number of distinct admin email addresses we tried
 *          to deliver to (after de-dup). Zero when no admin had a usable
 *          email address; this is treated as "email impossible" by callers,
 *          NOT as a transient failure.
 * @returns `sent` — number of those addresses for which the underlying
 *          SendGrid API call resolved successfully on this attempt.
 *
 * Callers MUST NOT mark an incident as `notifiedAt` when
 * `attempted > 0 && sent === 0` — that would permanently suppress the
 * alert if the SMTP outage was transient. Instead, allow the next health
 * check tick to retry.
 */
export async function sendHcpIncidentEmail(params: HcpIncidentEmailParams): Promise<{ sent: number; attempted: number }> {
  const { contractorId, kind, subject, body, link } = params;

  // If SendGrid isn't configured at all, `sendEmail()` returns successfully
  // without actually sending anything (see server/emails/client.ts). Treat
  // that as "no email possible" — equivalent to having no admin recipients
  // — so the in-app channel can still mark the incident notified instead of
  // looping forever waiting for a provider that will never come back.
  if (!process.env.SENDGRID_API_KEY) {
    log.warn(`SENDGRID_API_KEY not set — out-of-band HCP incident email (${kind}) for contractor ${contractorId} cannot be delivered; relying on in-app notification only`);
    return { sent: 0, attempted: 0 };
  }

  let recipients: string[] = [];
  try {
    const contractorUsers = await storage.getContractorUsers(contractorId);
    const adminContractorUsers = contractorUsers.filter(uc =>
      uc.role === 'admin' || uc.role === 'super_admin'
    );

    for (const uc of adminContractorUsers) {
      try {
        const user = await storage.getUser(uc.userId);
        if (user?.email && user.email.trim()) {
          recipients.push(user.email.trim());
        }
      } catch (err) {
        log.warn(`Failed to load admin user ${uc.userId} for incident email: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    log.error('Failed to enumerate admin users for HCP incident email', err);
    // Enumeration failure is itself transient (DB hiccup) — surface it as
    // "attempted but failed" so callers retry next tick instead of silently
    // dedup-suppressing.
    return { sent: 0, attempted: 1 };
  }

  // Dedupe (a user may appear twice if they're admin on two contractor rows
  // for the same tenant — defensive).
  recipients = Array.from(new Set(recipients));

  if (recipients.length === 0) {
    log.warn(`No admin email recipients available for contractor ${contractorId}/${kind} incident`);
    return { sent: 0, attempted: 0 };
  }

  const html = buildIncidentEmailHtml(kind, body, link);
  const text = `${body}${link ? `\n\nOpen the integrations settings: ${link}` : ''}`;

  let sent = 0;
  for (const to of recipients) {
    try {
      await sendEmail({ to, subject, html, text });
      sent += 1;
    } catch (err) {
      log.error(`Failed to send HCP incident email to ${to.replace(/(.{2}).*(@.*)/, '$1***$2')}`, err);
    }
  }

  log.info(`HCP incident email (${kind}) sent to ${sent}/${recipients.length} admin(s) for contractor ${contractorId}`);
  return { sent, attempted: recipients.length };
}

function buildIncidentEmailHtml(kind: HcpIncidentKind, body: string, link: string | undefined): string {
  const safeBody = escapeHtml(body)
    .split(/\n{2,}/)
    .map(p => `<p style="margin: 0 0 12px 0; line-height: 1.5;">${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');

  const banner = bannerForKind(kind);
  const linkBlock = link
    ? `<p style="margin: 16px 0 0 0;"><a href="${escapeHtml(link)}" style="color: #2563eb; text-decoration: underline;">Open Housecall Pro integration settings</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; max-width: 600px; margin: 0 auto; padding: 16px;">
  <div style="border-left: 4px solid ${banner.color}; padding: 12px 16px; background: ${banner.bg}; margin-bottom: 16px;">
    <strong style="color: ${banner.color};">${escapeHtml(banner.label)}</strong>
  </div>
  ${safeBody}
  ${linkBlock}
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin-top: 24px;"/>
  <p style="color: #6b7280; font-size: 12px;">This is an automated alert from your CRM's Housecall Pro webhook health monitor.</p>
</body></html>`;
}

function bannerForKind(kind: HcpIncidentKind): { label: string; color: string; bg: string } {
  switch (kind) {
    case 'staleness':
      return { label: 'Housecall Pro webhooks may be disabled', color: '#b45309', bg: '#fffbeb' };
    case 'rejection':
      return { label: 'Housecall Pro webhook auth failures', color: '#b91c1c', bg: '#fef2f2' };
    case 'health-check-failure':
      return { label: 'Webhook health monitor is failing', color: '#b91c1c', bg: '#fef2f2' };
    case 'subscription-missing':
      return { label: 'Housecall Pro webhook subscription missing', color: '#b91c1c', bg: '#fef2f2' };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
