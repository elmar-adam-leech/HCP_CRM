import { escapeHtml } from './escape';

export function passwordChangedEmail(name: string): { subject: string; html: string } {
  const safeName = escapeHtml(name);
  return {
    subject: 'Your Password Has Been Changed',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #059669; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #6b7280; }
          .warning { background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 12px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Password Changed Successfully</h1>
          </div>
          <div class="content">
            <p>Hi ${safeName},</p>
            <p>This is a confirmation that your HCP CRM password has been successfully changed.</p>
            <div class="warning">
              <strong>Security Alert:</strong><br>
              If you did not make this change, please contact our support team immediately.
            </div>
            <p>You can now log in with your new password.</p>
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
