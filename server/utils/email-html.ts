/**
 * Server-side email HTML handling — the security boundary for rich-text email.
 *
 * Reps can now compose emails with limited formatting (bold, italic, links,
 * line breaks). The client sanitizes before sending, but client-sanitized HTML
 * must NEVER be trusted alone: every outbound/stored email body passes through
 * `sanitizeEmailHtml` here against a strict allowlist before it is sent to a
 * provider or persisted as an activity.
 *
 * Automated/workflow/AI emails continue to pass PLAIN TEXT. `isHtmlEmail`
 * distinguishes the two so the plain-text path keeps its existing behavior and
 * does not get wrapped in markup.
 */
import createDOMPurify from 'dompurify';
// jsdom ships no bundled type declarations and there is no @types/jsdom in the
// tree; it is only used server-side to back DOMPurify.
// @ts-ignore
import { JSDOM } from 'jsdom';
import { htmlToPlainText } from './text';

export { htmlToPlainText };

// A single jsdom window backs the DOMPurify instance for the whole process.
const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window as any);

// Strict allowlist: only the formatting the rich-text editor can produce.
const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'a', 'br', 'p'];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

// Only http(s) and mailto links are permitted. Anything else (javascript:,
// data:, etc.) is stripped.
const SAFE_URI_REGEXP = /^(?:https?:|mailto:)/i;

// Force every surviving anchor to open safely.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (!SAFE_URI_REGEXP.test(href)) {
      node.removeAttribute('href');
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Returns HTML sanitized down to the email formatting allowlist. Safe to call
 * more than once (idempotent) and safe to call on plain text (returns it
 * unchanged aside from entity encoding of any stray angle brackets).
 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
  });
}

/**
 * Heuristic: does this content already contain rich-text markup produced by
 * the editor? Automated senders pass plain text, so this lets the send path
 * keep the plain-text branch untouched (no regression).
 */
export function isHtmlEmail(content: string): boolean {
  return /<(?:\/?)(?:p|br|strong|em|b|i|a|span|div)(?:\s|>|\/)/i.test(content);
}

/**
 * True when an email body has no meaningful content — empty string, whitespace,
 * or HTML that only contains empty tags / <br> / &nbsp; (e.g. "<p><br></p>").
 * Mirrors the client's `richTextIsEmpty` so the server rejects effectively-blank
 * rich-text submissions even when a non-browser caller bypasses the UI checks.
 */
export function isEmptyEmailBody(content: string): boolean {
  if (!content) return true;
  const text = content
    .replace(/<br\s*\/?>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '');
  return text.length === 0;
}

/**
 * Builds a multipart/alternative MIME body (plain-text + HTML parts) for an
 * HTML email. Returns the `Content-Type` header value (with boundary) and the
 * encoded body. Each part is base64-encoded for correct UTF-8 handling.
 */
export function buildMultipartAlternative(html: string, text: string): {
  contentType: string;
  body: string;
} {
  const boundary = `=_hcrm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  const encodePart = (s: string) =>
    Buffer.from(s, 'utf-8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n');

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodePart(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodePart(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return {
    contentType: `multipart/alternative; boundary="${boundary}"`,
    body,
  };
}
