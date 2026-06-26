import { describe, it, expect } from 'vitest';
import {
  sanitizeEmailHtml,
  isHtmlEmail,
  isEmptyEmailBody,
  buildMultipartAlternative,
} from './email-html';
import { htmlToPlainText } from './text';

describe('sanitizeEmailHtml', () => {
  it('keeps the allowlisted formatting tags', () => {
    const html = '<p>Hello <strong>bold</strong> and <em>italic</em><br>line two</p>';
    const out = sanitizeEmailHtml(html);
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<br>');
    expect(out).toContain('<p>');
  });

  it('strips script tags and event handlers', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="steal()">hi</p><script>alert(1)</script>',
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('hi');
  });

  it('removes javascript: and data: hrefs but keeps http/https/mailto', () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(
      /javascript:/i,
    );
    expect(sanitizeEmailHtml('<a href="data:text/html,evil">x</a>')).not.toMatch(
      /data:/i,
    );
    const safe = sanitizeEmailHtml('<a href="https://example.com">x</a>');
    expect(safe).toContain('href="https://example.com"');
    const mail = sanitizeEmailHtml('<a href="mailto:a@b.com">x</a>');
    expect(mail).toContain('href="mailto:a@b.com"');
  });

  it('forces safe link attributes on surviving anchors', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('strips disallowed structural tags like div/span/img', () => {
    const out = sanitizeEmailHtml(
      '<div><span>text</span><img src="x"></div>',
    );
    expect(out).not.toMatch(/<div|<span|<img/i);
    expect(out).toContain('text');
  });

  it('preserves line breaks when Chrome/Safari wrap lines in <div>', () => {
    // Chrome/Safari emit the first line bare and subsequent lines in <div>.
    const out = sanitizeEmailHtml('Line one<div>Line two</div><div>Line three</div>');
    expect(out).not.toMatch(/<div/i);
    expect(out).toContain('<br>');
    // The plain-text fallback must carry all three lines on separate lines.
    expect(htmlToPlainText(out)).toBe('Line one\nLine two\nLine three');
  });

  it('preserves a blank line typed between paragraphs', () => {
    const out = sanitizeEmailHtml('A<div><br></div><div>B</div>');
    const text = htmlToPlainText(out);
    expect(text).toBe('A\n\nB');
  });

  it('keeps bold and links intact while normalizing div breaks', () => {
    const out = sanitizeEmailHtml(
      'Hello <strong>world</strong><div>Visit <a href="https://example.com">site</a></div>',
    );
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('<br>');
    expect(out).not.toMatch(/<div/i);
  });

  it('does not add a spurious leading break for fully div-wrapped lines', () => {
    const out = sanitizeEmailHtml('<div>First</div><div>Second</div>');
    expect(htmlToPlainText(out)).toBe('First\nSecond');
  });

  it('leaves <p>-separated lines (Firefox / forced separator) working', () => {
    const out = sanitizeEmailHtml('<p>Line one</p><p>Line two</p>');
    expect(htmlToPlainText(out)).toBe('Line one\nLine two');
  });

  it('does not stack breaks on top of an existing <br>', () => {
    const out = sanitizeEmailHtml('Line one<br><div>Line two</div>');
    expect(htmlToPlainText(out)).toBe('Line one\nLine two');
  });
});

describe('isHtmlEmail', () => {
  it('detects editor-produced markup', () => {
    expect(isHtmlEmail('<p>hello</p>')).toBe(true);
    expect(isHtmlEmail('a <strong>b</strong>')).toBe(true);
    expect(isHtmlEmail('line<br>break')).toBe(true);
  });

  it('treats plain text (automated sends) as non-HTML', () => {
    expect(isHtmlEmail('Hello there')).toBe(false);
    expect(isHtmlEmail('Line one\nLine two')).toBe(false);
    expect(isHtmlEmail('2 < 3 and 4 > 1')).toBe(false);
  });
});

describe('isEmptyEmailBody', () => {
  it('treats blank and whitespace as empty', () => {
    expect(isEmptyEmailBody('')).toBe(true);
    expect(isEmptyEmailBody('   ')).toBe(true);
  });

  it('treats empty rich-text markup as empty', () => {
    expect(isEmptyEmailBody('<p><br></p>')).toBe(true);
    expect(isEmptyEmailBody('<p>&nbsp;</p>')).toBe(true);
    expect(isEmptyEmailBody('<br><br>')).toBe(true);
  });

  it('treats real content as non-empty', () => {
    expect(isEmptyEmailBody('hello')).toBe(false);
    expect(isEmptyEmailBody('<p>hello</p>')).toBe(false);
  });
});

describe('buildMultipartAlternative', () => {
  it('produces a multipart/alternative body with both parts', () => {
    const { contentType, body } = buildMultipartAlternative(
      '<p>hi</p>',
      'hi',
    );
    expect(contentType).toMatch(/^multipart\/alternative; boundary="/);
    const boundary = contentType.match(/boundary="([^"]+)"/)?.[1] as string;
    expect(boundary).toBeTruthy();
    expect(body).toContain('Content-Type: text/plain; charset=utf-8');
    expect(body).toContain('Content-Type: text/html; charset=utf-8');
    expect(body).toContain(`--${boundary}--`);
    // base64-encoded HTML part is present
    expect(body).toContain(Buffer.from('<p>hi</p>', 'utf-8').toString('base64'));
  });
});
