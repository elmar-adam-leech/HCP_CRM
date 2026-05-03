import { sendEmail } from '../emails/client';
import { storage } from '../storage';
import { logger } from '../utils/logger';

const log = logger('DialpadIncidentEmail');

export type DialpadIncidentKind =
  | 'staleness'
  | 'poller-failure'
  | 'backlog'
  | 'failed-events';

export interface DialpadIncidentEmailParams {
  contractorId: string;
  kind: DialpadIncidentKind;
  subject: string;
  /** Plain-text body, rendered into a minimal HTML wrapper. Use \n\n to break paragraphs. */
  body: string;
  /** Optional fully-qualified deep-link surfaced in the email. */
  link?: string;
}

/**
 * Out-of-band SendGrid notification for Dialpad webhook incidents.
 *
 * Sibling to sendHcpIncidentEmail — same delivery contract so the shared
 * notifier (server/services/webhook-incident-notifier.ts) can treat both
 * services identically:
 *   - `attempted` — distinct admin recipients we tried to deliver to
 *                   (0 means "no email possible" — caller falls through
 *                    to in-app only and still consumes the cooldown)
 *   - `sent`      — recipients for which the SendGrid call resolved OK
 *
 * Failures are logged but never thrown.
 */
export async function sendDialpadIncidentEmail(
  params: DialpadIncidentEmailParams,
): Promise<{ sent: number; attempted: number }> {
  const { contractorId, kind, subject, body, link } = params;

  // No SendGrid → "no email possible". The in-app channel can still
  // consume the cooldown, matching the HCP behaviour.
  if (!process.env.SENDGRID_API_KEY) {
    log.warn(
      `SENDGRID_API_KEY not set — out-of-band Dialpad incident email (${kind}) ` +
      `for contractor ${contractorId} cannot be delivered; relying on in-app notification only`
    );
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
        log.warn(
          `Failed to load admin user ${uc.userId} for Dialpad incident email: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err) {
    log.error('Failed to enumerate admin users for Dialpad incident email', err);
    // Surface enumeration failure as transient (DB hiccup) so the next
    // tick retries, matching HCP behaviour.
    return { sent: 0, attempted: 1 };
  }

  recipients = Array.from(new Set(recipients));

  if (recipients.length === 0) {
    log.warn(`No admin email recipients available for contractor ${contractorId}/${kind} Dialpad incident`);
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
      log.error(`Failed to send Dialpad incident email to ${to.replace(/(.{2}).*(@.*)/, '$1***$2')}`, err);
    }
  }

  log.info(`Dialpad incident email (${kind}) sent to ${sent}/${recipients.length} admin(s) for contractor ${contractorId}`);
  return { sent, attempted: recipients.length };
}

function buildIncidentEmailHtml(kind: DialpadIncidentKind, body: string, link: string | undefined): string {
  const safeBody = escapeHtml(body)
    .split(/\n{2,}/)
    .map(p => `<p style="margin: 0 0 12px 0; line-height: 1.5;">${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');

  const banner = bannerForKind(kind);
  const linkBlock = link
    ? `<p style="margin: 16px 0 0 0;"><a href="${escapeHtml(link)}" style="color: #2563eb; text-decoration: underline;">Open Dialpad integration settings</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; max-width: 600px; margin: 0 auto; padding: 16px;">
  <div style="border-left: 4px solid ${banner.color}; padding: 12px 16px; background: ${banner.bg}; margin-bottom: 16px;">
    <strong style="color: ${banner.color};">${escapeHtml(banner.label)}</strong>
  </div>
  ${safeBody}
  ${linkBlock}
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin-top: 24px;"/>
  <p style="color: #6b7280; font-size: 12px;">This is an automated alert from your CRM's Dialpad webhook health monitor.</p>
</body></html>`;
}

function bannerForKind(kind: DialpadIncidentKind): { label: string; color: string; bg: string } {
  switch (kind) {
    case 'staleness':
      return { label: 'Dialpad call events are not arriving', color: '#b45309', bg: '#fffbeb' };
    case 'poller-failure':
      return { label: 'Dialpad event poller is failing', color: '#b91c1c', bg: '#fef2f2' };
    case 'backlog':
      return { label: 'Dialpad webhook backlog is growing', color: '#b45309', bg: '#fffbeb' };
    case 'failed-events':
      return { label: 'Dialpad webhook events are failing', color: '#b91c1c', bg: '#fef2f2' };
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
