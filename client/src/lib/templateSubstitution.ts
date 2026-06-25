/**
 * Applies template variable substitution for SMS/text message templates.
 * Supports both double-brace {{contact.name}} format and legacy single-brace {customerName} format.
 */
export interface TemplateVariables {
  customerName: string;
  companyName: string;
  contactEmail?: string;
  contactPhone?: string;
  contactAddress?: string;
  contactId?: string;
  bookingCode?: string;
  bookingBaseUrl?: string;
  status?: string;
  source?: string;
  followUpDate?: string;
  notes?: string;
}

/**
 * Convert stored plain-text (templates, sales-process step bodies) into HTML
 * suitable for the rich-text email editor: escape HTML-special characters so
 * they render literally, and preserve line breaks as <br>. The result is safe
 * to load into the contentEditable editor as formatted text rather than raw
 * markup. The server re-sanitizes on send regardless.
 */
export function plainTextToHtml(text: string): string {
  if (!text) return "";
  // Already-HTML content (rare, e.g. re-editing a sent rich email) passes
  // through untouched so we don't double-escape its tags.
  if (/<(?:\/?)(?:p|br|strong|em|b|i|a)(?:\s|>|\/)/i.test(text)) {
    return text;
  }
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\r\n|\r|\n/g, "<br>");
}

export function applyTemplateSubstitution(
  content: string,
  variables: TemplateVariables
): string {
  let result = content;

  result = result.replace(/\{\{contact\.name\}\}/g, variables.customerName);
  result = result.replace(/\{\{name\}\}/g, variables.customerName);
  result = result.replace(/\{\{title\}\}/g, variables.customerName);
  result = result.replace(/\{customerName\}/g, variables.customerName);
  result = result.replace(/\{companyName\}/g, variables.companyName);

  result = result.replace(/\{\{contact\.emails\}\}/g, variables.contactEmail ?? "");
  result = result.replace(/\{\{contact\.phones\}\}/g, variables.contactPhone ?? "");
  result = result.replace(/\{\{contact\.address\}\}/g, variables.contactAddress ?? "");
  result = result.replace(/\{\{contact\.id\}\}/g, variables.contactId ?? "");

  // Resolve {{booking_link}} only via the short bookingCode (?c=<code>) form.
  // Legacy ?contactId=<uuid> fallback was retired (task #776/#792): possession
  // of an internal UUID is not proof of identity and those links never
  // expire. If a short code is not available at preview time, show a
  // placeholder — the server-side substitution path will fill in the real
  // short-code URL when the message is actually sent.
  if (result.includes('{{booking_link}}')) {
    if (variables.bookingBaseUrl && variables.bookingCode) {
      const bookingUrl = `${variables.bookingBaseUrl}?c=${variables.bookingCode}`;
      result = result.replace(/\{\{booking_link\}\}/g, bookingUrl);
    } else {
      result = result.replace(/\{\{booking_link\}\}/g, '[booking link]');
    }
  }

  result = result.replace(/\{\{status\}\}/g, variables.status ?? "");
  result = result.replace(/\{\{source\}\}/g, variables.source ?? "");
  result = result.replace(/\{\{followUpDate\}\}/g, variables.followUpDate ?? "");
  result = result.replace(/\{\{notes\}\}/g, variables.notes ?? "");

  return result;
}
