/**
 * Convert an HTML string to plain text by stripping tags and decoding
 * common HTML entities.  This is intentionally simple — it is meant for
 * email body processing, not for full HTML rendering.
 */
export function htmlToPlainText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s>][\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s>][\s\S]*?<\/style>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&mdash;/gi, '\u2014');
  text = text.replace(/&ndash;/gi, '\u2013');
  text = text.replace(/&rsquo;/gi, '\u2019');
  text = text.replace(/&lsquo;/gi, '\u2018');
  text = text.replace(/&rdquo;/gi, '\u201D');
  text = text.replace(/&ldquo;/gi, '\u201C');
  text = text.replace(/&hellip;/gi, '\u2026');
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
