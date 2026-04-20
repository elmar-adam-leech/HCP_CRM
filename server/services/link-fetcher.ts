import { logger } from '../utils/logger';
import { URL } from 'url';
import * as dns from 'dns/promises';
import * as net from 'net';

const log = logger('LinkFetcher');

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/i;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
  '169.254.169.254',
]);

function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd');
}

async function isUrlSafe(urlString: string): Promise<boolean> {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
      return false;
    }
    if (net.isIP(hostname)) {
      return !isPrivateIP(hostname);
    }
    const addresses = await dns.resolve4(hostname).catch(() => []);
    const addresses6 = await dns.resolve6(hostname).catch(() => []);
    const allAddresses = [...addresses, ...addresses6];
    if (allAddresses.length === 0) {
      return false;
    }
    for (const addr of allAddresses) {
      if (isPrivateIP(addr)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_REGEX);
  return match ? match[0] : null;
}

const URL_REGEX_GLOBAL = /https?:\/\/[^\s<>"')\]]+/gi;

export function extractUrlByPattern(text: string, pattern: string): string | null {
  const urls = text.match(URL_REGEX_GLOBAL);
  if (!urls || urls.length === 0) return null;
  const lowerPattern = pattern.toLowerCase();
  const match = urls.find(url => url.toLowerCase().includes(lowerPattern));
  return match || null;
}

export async function fetchPageText(url: string): Promise<string | null> {
  try {
    const safe = await isUrlSafe(url);
    if (!safe) {
      log.warn(`Blocked unsafe URL: ${url}`);
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LeadCapture/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.warn(`Failed to fetch ${url}: HTTP ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('json')) {
      log.warn(`Skipping non-text content type: ${contentType}`);
      return null;
    }

    const html = await response.text();
    const text = stripHtml(html);
    return text.substring(0, 10000);
  } catch (error: any) {
    if (error.name === 'AbortError') {
      log.warn(`Timeout fetching ${url}`);
    } else {
      log.warn(`Error fetching ${url}:`, error.message);
    }
    return null;
  }
}

export const SOURCE_ABBREVIATIONS: Record<string, string> = {
  'ig': 'instagram',
  'fb': 'facebook',
  'tw': 'twitter',
  'x': 'twitter',
  'li': 'linkedin',
  'yt': 'youtube',
  'pin': 'pinterest',
  'tt': 'tiktok',
  'ggl': 'google',
  'gg': 'google',
  'ms': 'microsoft',
  'bing': 'microsoft',
};

export const KNOWN_PLATFORMS = new Set([
  'instagram', 'facebook', 'google', 'twitter', 'linkedin',
  'youtube', 'pinterest', 'tiktok', 'microsoft', 'bing',
  'snapchat', 'reddit', 'nextdoor', 'yelp', 'thumbtack',
  'homeadvisor', 'angi', 'houzz',
]);

export interface ParsedUtm {
  pageUrl: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  resolvedSource?: string;
}

function getCaseInsensitiveParam(searchParams: URLSearchParams, key: string): string | null {
  const direct = searchParams.get(key);
  if (direct) return direct;
  let found: string | null = null;
  searchParams.forEach((v, k) => {
    if (!found && k.toLowerCase() === key) found = v;
  });
  return found;
}

export function parseUtmFromUrl(urlString: string): ParsedUtm | null {
  try {
    const parsed = new URL(urlString);
    const params = new globalThis.URLSearchParams(parsed.search);

    const hasUtm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
      .some(p => getCaseInsensitiveParam(params, p) !== null);

    if (!hasUtm) return null;

    const rawSource = getCaseInsensitiveParam(params, 'utm_source') || undefined;
    const normalizedSource = rawSource
      ? (SOURCE_ABBREVIATIONS[rawSource.toLowerCase()] || rawSource.toLowerCase())
      : undefined;

    const rawMedium = getCaseInsensitiveParam(params, 'utm_medium');
    const utmMedium = rawMedium
      ? rawMedium.toLowerCase().replace(/\s+/g, '_')
      : undefined;

    const result: ParsedUtm = {
      pageUrl: urlString,
      utmSource: normalizedSource,
      utmMedium,
      utmCampaign: getCaseInsensitiveParam(params, 'utm_campaign') || undefined,
      utmContent: getCaseInsensitiveParam(params, 'utm_content') || undefined,
      utmTerm: getCaseInsensitiveParam(params, 'utm_term') || undefined,
    };

    if (normalizedSource && KNOWN_PLATFORMS.has(normalizedSource)) {
      result.resolvedSource = normalizedSource;
    }

    return result;
  } catch {
    return null;
  }
}

const UTM_URL_REGEX = /https?:\/\/[^\s<>"')\]]+utm_[^\s<>"')\]]*/gi;

export function extractMarketingUrl(text: string, ownDomain?: string): ParsedUtm | null {
  const utmUrls = text.match(UTM_URL_REGEX);
  if (!utmUrls || utmUrls.length === 0) return null;

  const parsed: ParsedUtm[] = [];
  for (const url of utmUrls) {
    const cleaned = url.replace(/[.,;:!?)]+$/, '');
    const result = parseUtmFromUrl(cleaned);
    if (result) parsed.push(result);
  }

  if (parsed.length === 0) return null;

  if (ownDomain) {
    const normalizedDomain = ownDomain.toLowerCase().replace(/^www\./, '');
    const domainMatch = parsed.find(p => {
      try {
        const hostname = new URL(p.pageUrl).hostname.toLowerCase().replace(/^www\./, '');
        return hostname === normalizedDomain || hostname.endsWith('.' + normalizedDomain);
      } catch {
        return false;
      }
    });
    if (domainMatch) return domainMatch;
  }

  return parsed[0];
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}
