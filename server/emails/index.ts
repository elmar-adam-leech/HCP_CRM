import { sendEmail } from './client';
import { welcomeEmail } from './welcome';
import { passwordResetEmail } from './password-reset';
import { passwordChangedEmail } from './password-changed';

export type { SendEmailParams } from './client';

export class SendGridService {
  async sendWelcomeEmail(to: string, name: string): Promise<void> {
    const { subject, html } = welcomeEmail(name);
    await sendEmail({ to, subject, html, fromName: 'Welcome @ HCP CRM', fromEmail: process.env.SENDGRID_WELCOME_EMAIL });
  }

  async sendPasswordResetEmail(to: string, name: string, resetToken: string, baseUrl: string): Promise<void> {
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;
    const { subject, html } = passwordResetEmail(name, resetUrl);
    await sendEmail({ to, subject, html, fromName: 'Password @ HCP CRM', fromEmail: process.env.SENDGRID_PASSWORD_EMAIL });
  }

  async sendPasswordChangedEmail(to: string, name: string): Promise<void> {
    const { subject, html } = passwordChangedEmail(name);
    await sendEmail({ to, subject, html, fromName: 'Password @ HCP CRM', fromEmail: process.env.SENDGRID_PASSWORD_EMAIL });
  }
}

export const sendGridService = new SendGridService();
