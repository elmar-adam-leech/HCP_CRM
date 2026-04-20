import { escapeHtml } from './escape';

export function passwordResetEmail(name: string, resetUrl: string): { subject: string; html: string } {
  const safeName = escapeHtml(name);
  const safeResetUrl = escapeHtml(resetUrl);
  return {
    subject: 'Reset Your Password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #dc2626; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .button { display: inline-block; padding: 12px 24px; background-color: #dc2626; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #6b7280; }
          .warning { background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 12px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Password Reset Request</h1>
          </div>
          <div class="content">
            <p>Hi ${safeName},</p>
            <p>We received a request to reset your password for your HCP CRM account.</p>
            <p>Click the button below to reset your password:</p>
            <p>
              <a href="${safeResetUrl}" class="button">Reset Password</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #2563eb;">${safeResetUrl}</p>
            <div class="warning">
              <strong>Security Notice:</strong>
              <ul>
                <li>This link will expire in 1 hour for security reasons</li>
                <li>If you didn't request this reset, please ignore this email</li>
                <li>Your password will remain unchanged until you create a new one</li>
              </ul>
            </div>
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
