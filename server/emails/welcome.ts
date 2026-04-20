import { escapeHtml } from './escape';

export function welcomeEmail(name: string): { subject: string; html: string } {
  const safeName = escapeHtml(name);
  return {
    subject: 'Welcome to HCP CRM',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #2563eb; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #6b7280; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to HCP CRM!</h1>
          </div>
          <div class="content">
            <p>Hi ${safeName},</p>
            <p>Welcome to your HCP CRM system! We're excited to have you on board.</p>
            <p>Your account has been successfully created. You can now log in and start managing your customers, leads, and jobs.</p>
            <p>If you have any questions or need assistance, please don't hesitate to reach out to our support team.</p>
            <p>Best regards,<br>The HCP CRM Team</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} HCP CRM. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };
}
