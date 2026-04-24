import OpenAI from 'openai';
import { logger } from '../utils/logger';

const log = logger('EmailAIParser');

export interface EmailParseResult {
  isSpam: boolean;
  spamConfidence?: number;
  name?: string;
  phone?: string;
  email?: string;
  serviceDescription?: string;
}

export interface HeuristicSpamResult {
  isSpam: boolean;
  confidence: number;
  reason: string;
}

function looksLikeRandomString(name: string): boolean {
  const cleaned = name.trim().replace(/\s+/g, '');
  if (cleaned.length < 2) return false;

  const hasDigits = /\d/.test(cleaned);
  const hasUpperLower = /[a-z]/.test(cleaned) && /[A-Z]/.test(cleaned);
  const consecutiveConsonants = /[bcdfghjklmnpqrstvwxyz]{5,}/i.test(cleaned);
  const noVowels = cleaned.length > 4 && !/[aeiou]/i.test(cleaned);
  const mixedCaseNoSpaces = hasUpperLower && !name.includes(' ') && cleaned.length > 8 &&
    (cleaned.replace(/[A-Z]/g, '').length < cleaned.length * 0.3 || cleaned.replace(/[a-z]/g, '').length < cleaned.length * 0.3);
  const alphanumericMix = hasDigits && /[a-zA-Z]/.test(cleaned) && cleaned.length > 5;
  const allCapsNoSpaces = /^[A-Z]{8,}$/.test(cleaned) && !name.includes(' ');

  let score = 0;
  if (consecutiveConsonants) score += 2;
  if (noVowels) score += 2;
  if (alphanumericMix) score += 2;
  if (mixedCaseNoSpaces) score += 1;
  if (allCapsNoSpaces) score += 1;
  if (cleaned.length > 15 && !name.includes(' ')) score += 1;

  return score >= 2;
}

function hasInternationalPhoneOnly(phone?: string, email?: string): boolean {
  if (!phone || email) return false;
  const cleaned = phone.replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+') && !/^\+1/.test(cleaned)) {
    return true;
  }
  return false;
}

function containsRealWords(text: string): boolean {
  const lower = text.toLowerCase();
  const phrasePatterns = [
    'not working', 'no hot water', 'need help', 'need a quote', 'request a quote',
    'air conditioning', 'water heater', 'garbage disposal', 'circuit breaker',
  ];
  if (phrasePatterns.some(phrase => lower.includes(phrase))) return true;

  const words = lower.split(/\s+/).filter(w => w.length >= 2);
  const commonServiceWords = new Set([
    'repair', 'fix', 'install', 'replace', 'broken', 'leak', 'heat', 'cool',
    'air', 'water', 'pipe', 'drain', 'furnace', 'ac', 'hvac', 'plumbing',
    'electrical', 'help', 'need', 'want', 'quote', 'estimate', 'service',
    'appointment', 'schedule', 'call', 'please', 'thank', 'home', 'house',
    'kitchen', 'bathroom', 'basement', 'roof', 'unit', 'system', 'problem',
    'issue', 'maintenance', 'inspection', 'emergency', 'heater', 'toilet',
    'faucet', 'shower', 'thermostat', 'duct', 'vent', 'sewer', 'clog',
  ]);
  return words.some(w => commonServiceWords.has(w));
}

export function runHeuristicSpamCheck(
  name?: string,
  phone?: string,
  email?: string,
  serviceDescription?: string,
  body?: string,
): HeuristicSpamResult {
  const reasons: string[] = [];
  let confidence = 0;

  if (name && looksLikeRandomString(name)) {
    reasons.push('Name appears to be random characters');
    confidence += 40;
  }

  if (hasInternationalPhoneOnly(phone, email)) {
    reasons.push('International phone number with no email address');
    confidence += 30;
  }

  if (!email && !serviceDescription && body && !containsRealWords(body)) {
    reasons.push('No email and no recognizable service request');
    confidence += 30;
  }

  if (name && looksLikeRandomString(name) && !serviceDescription) {
    reasons.push('Random name with no service description');
    confidence += 20;
  }

  confidence = Math.min(confidence, 100);

  return {
    isSpam: confidence >= 80,
    confidence,
    reason: reasons.length > 0 ? `Heuristic: ${reasons.join('; ')}` : '',
  };
}

const SYSTEM_PROMPT = `You are an AI assistant that analyzes incoming emails for a home services contractor (HVAC, plumbing, electrical, etc.).

Your job is to:
1. Determine if the email is a legitimate service inquiry/lead or spam/solicitation.
2. If it's a lead, extract any available contact information and service details.
3. Provide a spamConfidence score from 0 to 100 indicating how confident you are the email is spam.

IMPORTANT SCORING GUIDELINES — use these signals cumulatively to arrive at a spamConfidence score. Each signal adds to suspicion; multiple signals together should result in HIGH confidence (85-100):

Strong spam signals (each adds +25-35 to confidence):
- Name looks like a random string, username, or bot-generated text (e.g. "DarktoteaskDI", "xk7user392", "asdfghjkl"). Single-word names with unusual capitalization patterns, no spaces, or alphanumeric mixes are suspicious.
- No coherent service description — the "message" or "service needed" field is empty, contains gibberish, generic filler text, or doesn't describe an actual home service need.

Moderate spam signals (each adds +15-25 to confidence):
- Phone number with non-US country code (e.g. +353, +44, +91) AND no email address provided. Note: if the submission has a real service description and a plausible name, a non-US phone alone is not sufficient to flag as spam.
- No email address provided at all.
- Email uses a known disposable/temporary domain (tempmail, guerrillamail, mailinator, etc.).

When multiple signals combine, set isSpam to true. For example:
- Random name + no service description = confidence 70-85
- Random name + international phone + no email + no service description = confidence 95-100
- Normal name + international phone + clear service need = confidence 10-20 (legitimate lead)

Assign LOW spamConfidence (0-30) for:
- Real human names (first and last name, properly capitalized with space)
- A clear description of a home service need (e.g. "My AC isn't cooling", "Need a plumber for a leak")
- US phone numbers with a real email address
- Web form submissions from known lead generation platforms that contain genuine customer inquiries

Spam also includes:
- Marketing emails, newsletters, sales pitches from vendors, promotional offers, subscription confirmations, social media notifications
- Bot/automated form submissions with disposable email domains (e.g. tempmail, guerrillamail, mailinator)
- Any non-customer inquiry

Leads include:
- Web form submission notifications that contain a real customer inquiry (e.g. a customer filling out a "Request a Quote" or "Contact Us" form with a real name, real contact info, and a genuine description of a service need). These are legitimate leads even though they are technically automated notification emails.
- Customers emailing directly asking about services, requesting quotes, describing problems, scheduling appointments, or following up on previous service requests.

When the body contains separate "First Name" and "Last Name" lines (or "Given Name" / "Surname" / "Family Name"), combine them into a single "First Last" string and return it in the "name" field — never return only one half.

Respond with valid JSON only, no markdown formatting:
{
  "isSpam": true/false,
  "spamConfidence": 0-100,
  "name": "extracted name or null",
  "phone": "extracted phone number or null",
  "email": "extracted email address or null",
  "serviceDescription": "brief summary of what the customer needs or null"
}`;

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (client) return client;
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  client = new OpenAI({ baseURL: "https://api.x.ai/v1", apiKey });
  return client;
}

export async function parseEmailWithAI(subject: string, body: string): Promise<EmailParseResult> {
  const ai = getClient();
  if (!ai) {
    log.warn('XAI_API_KEY not configured, skipping AI parsing');
    return { isSpam: false };
  }

  try {
    const userMessage = `Subject: ${subject}\n\nBody:\n${body.substring(0, 3000)}`;

    const completion = await ai.chat.completions.create({
      model: 'grok-4-fast-reasoning',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) {
      log.warn('Empty AI response, treating as non-spam');
      return { isSpam: false };
    }

    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const spamConfidence = typeof parsed.spamConfidence === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.spamConfidence)))
      : undefined;

    return {
      isSpam: parsed.isSpam === true,
      spamConfidence,
      name: parsed.name || undefined,
      phone: parsed.phone || undefined,
      email: parsed.email || undefined,
      serviceDescription: parsed.serviceDescription || undefined,
    };
  } catch (error) {
    log.error('Error parsing email with AI:', error);
    return { isSpam: false };
  }
}
