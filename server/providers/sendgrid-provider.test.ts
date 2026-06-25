import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the last message handed to SendGrid so we can assert on the
// html/text branching without making a real network call.
const sendMock = vi.fn().mockResolvedValue([
  { headers: { 'x-message-id': 'test-message-id' } },
]);
const setApiKeyMock = vi.fn();

vi.mock('@sendgrid/mail', () => ({
  setApiKey: (...args: unknown[]) => setApiKeyMock(...args),
  send: (...args: unknown[]) => sendMock(...args),
}));

vi.mock('../credential-service', () => ({
  credentialService: {
    getCredentialsWithFallback: vi.fn().mockResolvedValue({
      api_key: 'SG.test',
      from_email: 'sender@company.com',
    }),
  },
}));

import { SendGridEmailProvider } from './sendgrid-provider';

describe('SendGridEmailProvider.sendEmail content branching', () => {
  let provider: SendGridEmailProvider;

  beforeEach(() => {
    sendMock.mockClear();
    setApiKeyMock.mockClear();
    provider = new SendGridEmailProvider();
  });

  it('sends sanitized HTML with a derived plain-text fallback for rich-text bodies', async () => {
    await provider.sendEmail({
      to: 'rcpt@example.com',
      subject: 'Hi',
      content: '<p>Hello <strong>there</strong></p><script>alert(1)</script>',
      contractorId: 'c1',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][0] as { html: string; text: string };
    // HTML part keeps allowlisted formatting and drops the script.
    expect(msg.html).toContain('<strong>there</strong>');
    expect(msg.html).not.toMatch(/<script/i);
    // Plain-text fallback is derived from the HTML and is non-empty.
    expect(msg.text).toContain('Hello');
    expect(msg.text).not.toMatch(/<strong>/i);
  });

  it('keeps plain-text bodies untouched (automated-send regression guard)', async () => {
    await provider.sendEmail({
      to: 'rcpt@example.com',
      subject: 'Reminder',
      content: 'Line one\nLine two',
      contractorId: 'c1',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0][0] as { html: string; text: string };
    // Plain text passes through verbatim as the text part...
    expect(msg.text).toBe('Line one\nLine two');
    // ...and the HTML part uses the legacy naive newline→<br> conversion.
    expect(msg.html).toBe('Line one<br>Line two');
  });
});
