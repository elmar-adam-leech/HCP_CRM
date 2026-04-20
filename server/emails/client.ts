import { logger } from '../utils/logger';
import { maskEmail } from '../utils/pii-redactor';
import sgMail from '@sendgrid/mail';

const log = logger('EmailClient');

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  fromEmail?: string;
}

function getCredentials(): { apiKey: string; fromEmail: string; fromName: string } | null {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_EMAIL || 'noreply@hcpcrm.com';
  const fromName = process.env.SENDGRID_FROM_NAME || 'HCP CRM';

  if (!apiKey) {
    return null;
  }

  return { apiKey, fromEmail, fromName };
}

export async function sendEmail({ to, subject, html, text, fromName, fromEmail }: SendEmailParams): Promise<void> {
  const credentials = getCredentials();

  if (!credentials) {
    log.warn('[SendGrid] SENDGRID_API_KEY not set — skipping email to', maskEmail(to));
    return;
  }

  try {
    sgMail.setApiKey(credentials.apiKey);

    await sgMail.send({
      to,
      from: {
        email: fromEmail || credentials.fromEmail,
        name: fromName || credentials.fromName,
      },
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
    });

    log.info(`[SendGrid] Email sent successfully to ${maskEmail(to)}`);
  } catch (error) {
    log.error('[SendGrid] Email send error:', error);
    throw new Error('Failed to send email');
  }
}
