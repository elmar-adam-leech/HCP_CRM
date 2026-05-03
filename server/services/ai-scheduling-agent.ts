/**
 * AI SMS scheduling agent. Drives a small state machine over an inbound
 * SMS thread to propose a slot, await YES, and book via `bookAppointment`
 * with `scheduleSource='ai_agent'`. Hands off to a human on STOP, low
 * confidence, repeated LLM failures, or `MAX_EXCHANGES`.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  aiSchedulingConversations,
  contractors,
  messages,
  users,
  type AiSchedulingConversation,
  type Message,
  type Contact,
  type Contractor,
  type InsertMessage,
  type InsertActivity,
  type InsertNotification,
} from "@shared/schema";
import { storage } from "../storage";
import { providerService } from "../providers/provider-service";
import { broadcastToContractor } from "../websocket";
import { logger } from "../utils/logger";
import { aiService } from "../ai-service";
import {
  getUnifiedAvailability,
  selectNextAvailableSalesperson,
} from "../scheduling/availability";
import { bookAppointment } from "../scheduling/booking";
import { getSalespeople } from "../scheduling/queries";
import {
  parseAddressString,
  hasRealStreetAddress,
  type AddressComponents,
} from "../types/scheduling";
import { normalizePhoneForStorage } from "../utils/phone-normalizer";
import { placesTextSearch } from "../utils/places-client";

const log = logger("AiSchedulingAgent");

const MAX_EXCHANGES = 6;
const MIN_INTENT_CONFIDENCE = 0.4;
// Per-contractor LLM circuit breaker: after 3 consecutive failures within
// 5 minutes, suppress LLM dispatch and hand off until cooldown expires.
const LLM_FAILURE_THRESHOLD = 3;
const LLM_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const LLM_COOLDOWN_MS = 10 * 60 * 1000;
const llmFailureState = new Map<string, { failures: number[]; cooldownUntil: number }>();

function recordLlmFailure(contractorId: string) {
  const now = Date.now();
  const s = llmFailureState.get(contractorId) ?? { failures: [], cooldownUntil: 0 };
  s.failures = s.failures.filter((t) => now - t < LLM_FAILURE_WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= LLM_FAILURE_THRESHOLD) {
    s.cooldownUntil = now + LLM_COOLDOWN_MS;
    s.failures = [];
  }
  llmFailureState.set(contractorId, s);
}

function recordLlmSuccess(contractorId: string) {
  const s = llmFailureState.get(contractorId);
  if (s) s.failures = [];
}

function isLlmInCooldown(contractorId: string): boolean {
  const s = llmFailureState.get(contractorId);
  return !!s && s.cooldownUntil > Date.now();
}

const STOP_KEYWORDS = /\b(stop|unsubscribe|quit|talk to (a )?(person|human|rep|someone)|human (please)?|real person|agent please)\b/i;
// HELP-style carrier compliance keywords. These must NOT wake the AI agent;
// existing carrier/auto-reply handling owns them.
const HELP_KEYWORDS = /^\s*(help|info|aide)\b[\s.!?]*$/i;
// Strict, whole-message YES — protects against qualified replies like
// "ok can we do Friday instead?" booking the previously proposed slot.
// The whole message (after trimming and stripping trailing punctuation)
// must be one of: y, yes, yeah, yep, yup, confirm(ed), book it, sounds good,
// that works, looks good, perfect, do it.
const YES_PATTERN = /^\s*(y|yes|yeah|yep|yup|confirm(ed)?|book it|sounds good|that works|looks good|perfect|do it)[\s.!?]*$/i;
// NO is similarly whole-message.
const NO_PATTERN = /^\s*(n|no|nope|not (now|today)|cancel|nevermind|never mind|don'?t)[\s.!?]*$/i;

const DEFAULT_PERSONALITY =
  "Friendly, concise, professional. Warm but to the point. Confirm everything in plain English and avoid jargon.";

const BASE_SYSTEM_PROMPT = `You are an SMS scheduling assistant for a home-services contractor.
Your job is to help a customer book an in-home estimate appointment over text.
Rules you must follow:
- Reply in 1-2 short SMS sentences (under 240 chars).
- Never invent appointment times — only propose times from the AVAILABLE_SLOTS list given to you.
- Never confirm a booking yourself; ask the customer to reply YES.
- If the customer wants a human, says STOP, or seems frustrated, set intent="request_human".
- If the message is ambiguous about the time or address, set intent="unclear" and ask one short clarifying question.
- Output strictly the JSON described — no prose outside it.`;

interface IntentParse {
  intent:
    | "propose_time"
    | "provide_address"
    | "confirm"
    | "decline"
    | "request_human"
    | "unclear";
  confidence: number;
  startTimeIso?: string | null;
  address?: string | null;
  reply: string;
}

interface SlotCandidate {
  start: Date;
  salespersonIds: string[];
}

function sanitize(s: string | null | undefined, max = 2000): string {
  if (!s) return "";
  return s
    .replace(/```/g, "")
    .replace(/<\|.*?\|>/g, "")
    .replace(/system:|assistant:|user:/gi, "")
    .slice(0, max)
    .trim();
}

function fmtSlot(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    timeZone: timezone,
  }).format(d);
}

function buildSystemPrompt(
  contractor: Contractor,
  contact: Contact,
  availableSlotsHint: string | null,
  now: Date,
  timezone: string,
): string {
  const personality = sanitize(contractor.aiSchedulingPersonality) || DEFAULT_PERSONALITY;
  const companyContext = sanitize(contractor.aiSchedulingCompanyContext) ||
    `Company: ${contractor.name}.`;
  const nowLocal = new Intl.DateTimeFormat("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "numeric", timeZoneName: "short", timeZone: timezone,
  }).format(now);

  return [
    BASE_SYSTEM_PROMPT,
    `\nCURRENT_DATETIME: ${nowLocal} (${now.toISOString()})`,
    `\nTIMEZONE: ${timezone}`,
    `\nCONTRACTOR_NAME: ${sanitize(contractor.name, 200)}`,
    `\nPERSONALITY: ${personality}`,
    `\nCOMPANY_CONTEXT: ${companyContext}`,
    `\nCUSTOMER_NAME: ${sanitize(contact.name, 200)}`,
    contact.address ? `\nCUSTOMER_ADDRESS_ON_FILE: ${sanitize(contact.address, 300)}` : "",
    availableSlotsHint ? `\nAVAILABLE_SLOTS: ${availableSlotsHint}` : "",
    `\n\nResolve relative phrases like "tomorrow", "Friday at 10", or "next Tuesday" against CURRENT_DATETIME and TIMEZONE; emit startTimeIso as a UTC ISO-8601 string.`,
    `\nReturn JSON ONLY: {"intent":"propose_time|provide_address|confirm|decline|request_human|unclear","confidence":0..1,"startTimeIso":"ISO|null","address":"string|null","reply":"what to text back"}`,
  ].join("");
}

async function callLlm(
  contractorId: string,
  systemPrompt: string,
  threadHistory: Array<{ direction: "inbound" | "outbound"; content: string }>,
  newInbound: string,
): Promise<IntentParse | null> {
  if (!aiService.isAvailable()) {
    log.warn("AIService unavailable — cannot run scheduling agent");
    return null;
  }
  if (isLlmInCooldown(contractorId)) {
    log.warn(`LLM circuit breaker OPEN for contractor ${contractorId} — skipping call`);
    return null;
  }
  const transcript = threadHistory
    .slice(-8)
    .map((m) => `${m.direction === "inbound" ? "CUSTOMER" : "AGENT"}: ${m.content}`)
    .join("\n");
  const userPrompt = `THREAD_SO_FAR:\n${transcript}\n\nNEW_CUSTOMER_MESSAGE:\n${newInbound}`;
  try {
    // Prefer the structured-JSON path when available; fall back to the
    // generic text path so older mocks/tests still work.
    let raw: string;
    let latencyMs = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    if (typeof (aiService as { generateJson?: unknown }).generateJson === "function") {
      const r = await aiService.generateJson({ systemPrompt, userPrompt });
      raw = r.content;
      latencyMs = r.latencyMs;
      promptTokens = r.promptTokens;
      completionTokens = r.completionTokens;
    } else {
      const startedAt = Date.now();
      raw = await aiService.generateContent(`${systemPrompt}\n\n${userPrompt}\n\nReturn ONLY the JSON object described above.`);
      latencyMs = Date.now() - startedAt;
    }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as IntentParse;
    if (typeof parsed.intent !== "string" || typeof parsed.reply !== "string") {
      recordLlmFailure(contractorId);
      return null;
    }
    if (typeof parsed.confidence !== "number") parsed.confidence = 0.5;
    recordLlmSuccess(contractorId);
    log.info(
      `[ai-scheduling] llm contractor=${contractorId} intent=${parsed.intent} confidence=${parsed.confidence} ` +
      `latencyMs=${latencyMs} promptTokens=${promptTokens} completionTokens=${completionTokens}`,
    );
    return parsed;
  } catch (err) {
    recordLlmFailure(contractorId);
    log.error("LLM intent parse failed:", err);
    return null;
  }
}

/**
 * Pull a stable window of upcoming open slots and surface a short hint string
 * the LLM can use as `AVAILABLE_SLOTS`.
 */
async function findUpcomingSlots(
  contractorId: string,
  timezone: string,
  from: Date,
  daysAhead = 7,
): Promise<{ hint: string; slots: SlotCandidate[] }> {
  const end = new Date(from.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const all = await getUnifiedAvailability(contractorId, from, end, timezone);
  const top = all.slice(0, 6).map((s) => ({ start: s.start, salespersonIds: s.availableSalespersonIds }));
  const hint = top.map((s) => fmtSlot(s.start, timezone)).join("; ") || "(no openings in the next week)";
  return { hint, slots: top };
}

/**
 * When a requested time is unavailable, return the 2-3 nearest open slots
 * (preferring later-the-same-day, then next-day) so the agent can offer
 * alternatives instead of jumping to the very next slot in the system.
 */
async function findAlternatives(
  contractorId: string,
  timezone: string,
  around: Date,
  windowDays = 3,
): Promise<SlotCandidate[]> {
  const start = new Date(around.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const end = new Date(around.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const all = await getUnifiedAvailability(contractorId, start, end, timezone);
  if (all.length === 0) return [];
  const target = around.getTime();
  return all
    .map((s) => ({ start: s.start, salespersonIds: s.availableSalespersonIds, distance: Math.abs(s.start.getTime() - target) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ start: s, salespersonIds }) => ({ start: s, salespersonIds }));
}

async function loadRecentThread(contractorId: string, contactId: string): Promise<Array<{ direction: "inbound" | "outbound"; content: string }>> {
  const rows = await db.select({
    direction: messages.direction,
    content: messages.content,
    createdAt: messages.createdAt,
  })
    .from(messages)
    .where(and(eq(messages.contractorId, contractorId), eq(messages.contactId, contactId)))
    .orderBy(desc(messages.createdAt))
    .limit(20);
  return rows.reverse().map((r) => ({ direction: r.direction as "inbound" | "outbound", content: r.content }));
}

async function findOpenConversation(contractorId: string, contactId: string): Promise<AiSchedulingConversation | null> {
  const [row] = await db.select().from(aiSchedulingConversations).where(and(
    eq(aiSchedulingConversations.contractorId, contractorId),
    eq(aiSchedulingConversations.contactId, contactId),
    sql`${aiSchedulingConversations.status} IN ('active','awaiting_confirmation')`,
  )).limit(1);
  return row ?? null;
}

/**
 * Has the agent ALREADY engaged (in any state — open or terminal) with the
 * given outreach message? Used to prevent restart after handoff/booked: a
 * single scheduling-intent SMS gets at most one AI conversation per contact,
 * regardless of how many times the customer follows up.
 */
async function findConversationByTrigger(
  contractorId: string,
  contactId: string,
  triggeringMessageId: string,
): Promise<AiSchedulingConversation | null> {
  const [row] = await db.select().from(aiSchedulingConversations).where(and(
    eq(aiSchedulingConversations.contractorId, contractorId),
    eq(aiSchedulingConversations.contactId, contactId),
    eq(aiSchedulingConversations.triggeringMessageId, triggeringMessageId),
  )).limit(1);
  return row ?? null;
}

async function findRecentSchedulingIntentMessage(
  contractorId: string,
  contactId: string,
  windowHours: number,
): Promise<Message | null> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const [row] = await db.select()
    .from(messages)
    .where(and(
      eq(messages.contractorId, contractorId),
      eq(messages.contactId, contactId),
      eq(messages.direction, "outbound"),
      eq(messages.isSchedulingIntent, true),
      gte(messages.createdAt, cutoff),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Best-effort canonicalization of a customer-supplied address using the
 * existing Google Places client (same path the public booking widget and
 * in-app pickers use). When the API is unavailable we keep the typed string,
 * so the booking still proceeds.
 */
async function resolveAddress(rawAddress: string): Promise<{ formatted: string; components: AddressComponents } | null> {
  const trimmed = rawAddress.trim();
  if (!trimmed) return null;
  let formatted = trimmed;
  try {
    const canonical = await placesTextSearch(trimmed);
    if (canonical) formatted = canonical;
  } catch (err) {
    log.warn(`[ai-scheduling] places lookup failed for "${trimmed}":`, err);
  }
  const components = parseAddressString(formatted);
  return { formatted, components };
}

/**
 * Send an outbound SMS as the AI agent. Reuses the contractor's default
 * Dialpad number (or the contact's most recent outbound `from_number`).
 */
async function sendAgentSms(opts: {
  contractorId: string;
  contactId: string;
  toNumber: string;
  fromNumber: string;
  body: string;
}): Promise<Message | null> {
  const result = await providerService.sendSms({
    to: opts.toNumber,
    message: opts.body,
    fromNumber: opts.fromNumber,
    contractorId: opts.contractorId,
  });
  if (!result.success) {
    log.error(`AI agent SMS send failed: ${result.error}`);
    return null;
  }
  const insertPayload: Omit<InsertMessage, "contractorId"> = {
    type: "text",
    status: "sent",
    direction: "outbound",
    content: opts.body,
    toNumber: normalizePhoneForStorage(opts.toNumber),
    fromNumber: normalizePhoneForStorage(opts.fromNumber),
    contactId: opts.contactId,
    externalMessageId: result.messageId ?? null,
    aiAuthored: true,
  };
  const msg = await storage.createMessage(insertPayload, opts.contractorId);

  broadcastToContractor(opts.contractorId, {
    type: "new_message",
    message: msg,
    contactId: opts.contactId,
  });
  return msg;
}

async function pickFromNumber(contractorId: string, contactId: string): Promise<string | null> {
  // Prefer the most recent outbound from_number to this contact so the
  // thread stays on the same Dialpad number.
  const [last] = await db.select({ fromNumber: messages.fromNumber })
    .from(messages)
    .where(and(
      eq(messages.contractorId, contractorId),
      eq(messages.contactId, contactId),
      eq(messages.direction, "outbound"),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (last?.fromNumber) return last.fromNumber;
  const [c] = await db.select({ defaultDialpadNumber: contractors.defaultDialpadNumber })
    .from(contractors)
    .where(eq(contractors.id, contractorId))
    .limit(1);
  return c?.defaultDialpadNumber ?? null;
}

interface ContactWithAssignee extends Contact {
  assignedToUserId?: string | null;
}

async function notifyHandoff(
  conversation: AiSchedulingConversation,
  contact: ContactWithAssignee | null,
  reason: string,
): Promise<void> {
  const title = "AI scheduling needs you";
  const message = `The AI agent couldn't finish booking ${contact?.name ?? "a lead"} — please follow up. Reason: ${reason}`;
  const link = `/contacts/${conversation.contactId}`;

  const recipients = new Set<string>();
  if (contact?.assignedToUserId) {
    recipients.add(contact.assignedToUserId);
  } else {
    // Lead-distribution fallback — fan out to every active salesperson.
    try {
      const salespeople = await getSalespeople(conversation.contractorId);
      for (const sp of salespeople) recipients.add(sp.userId);
    } catch (err) {
      log.warn("Failed to enumerate salespeople for handoff fallback:", err);
    }
  }

  for (const userId of recipients) {
    const payload: Omit<InsertNotification, "contractorId"> = {
      userId,
      type: "system",
      title,
      message,
      link,
    };
    try {
      await storage.createNotification(payload, conversation.contractorId);
    } catch (err) {
      log.warn(`Failed to create handoff notification for user ${userId}:`, err);
    }
  }
}

async function handoff(
  conversation: AiSchedulingConversation,
  reason: string,
): Promise<void> {
  await db.update(aiSchedulingConversations)
    .set({ status: "handed_off", handoffReason: reason, updatedAt: new Date() })
    .where(eq(aiSchedulingConversations.id, conversation.id));

  const contact = await storage.getContact(conversation.contactId, conversation.contractorId)
    .catch(() => null) as ContactWithAssignee | null;

  try {
    const noteActivity: Omit<InsertActivity, "contractorId"> = {
      type: "note",
      title: "AI scheduling agent handed off",
      content: `AI agent stopped and handed off. Reason: ${reason}`,
      contactId: conversation.contactId,
      externalSource: "ai_agent",
    };
    await storage.createActivity(noteActivity, conversation.contractorId);
  } catch (err) {
    log.warn("Failed to write ai_handoff activity:", err);
  }

  await notifyHandoff(conversation, contact, reason);

  broadcastToContractor(conversation.contractorId, {
    type: "ai_scheduling_conversation_updated",
    contactId: conversation.contactId,
    status: "handed_off",
  });
}

async function writeBookingActivity(
  conversation: AiSchedulingConversation,
  contact: Contact,
  startTime: Date,
  salespersonName: string | null,
  timezone: string,
): Promise<void> {
  const summary = `Booked by AI agent: ${fmtSlot(startTime, timezone)} with ${salespersonName ?? "auto-assigned salesperson"} for ${contact.name}. ` +
    `Conversation took ${conversation.exchangeCount ?? 0} exchanges.`;
  const activity: Omit<InsertActivity, "contractorId"> = {
    type: "note",
    title: "Booked by AI scheduling agent",
    content: summary,
    contactId: conversation.contactId,
    externalSource: "ai_agent",
    externalId: `ai-booking-${conversation.id}`,
  };
  try {
    await storage.createActivity(activity, conversation.contractorId);
  } catch (err) {
    log.warn("Failed to write ai_agent booking activity (non-fatal):", err);
  }
}

/**
 * YES handler shared by the deterministic bypass and any future LLM-driven
 * paths. Re-validates the proposed slot, falls back to cascade when the
 * proposed salesperson is no longer free, books via `bookAppointment`,
 * sends the confirmation SMS, and writes the booking-by-AI activity.
 */
async function handleConfirmation(
  conversation: AiSchedulingConversation,
  contractorId: string,
  contactId: string,
  contact: Contact,
  phone: string,
  fromNumber: string,
  timezone: string,
): Promise<boolean> {
  if (!conversation.proposedStartTime) {
    await handoff(conversation, "YES received but no proposed slot on conversation");
    return true;
  }
  const proposedStart = conversation.proposedStartTime;
  // Defense-in-depth: never confirm a slot that has fallen into the past
  // between proposal and YES (e.g. customer takes hours to reply).
  if (proposedStart.getTime() <= Date.now()) {
    await handoff(conversation, "Proposed slot is in the past — cannot book");
    return true;
  }
  try {
    const stillAvailable = await selectNextAvailableSalesperson(contractorId, proposedStart, timezone);
    const salespersonForBooking = stillAvailable?.userId === conversation.proposedSalespersonUserId
      ? conversation.proposedSalespersonUserId
      : stillAvailable?.userId;
    if (!salespersonForBooking) {
      await handoff(conversation, "Proposed slot no longer has any salesperson available");
      return true;
    }
    const addressForBooking = conversation.proposedAddress || contact.address || "";
    const resolved = addressForBooking ? await resolveAddress(addressForBooking) : null;
    const result = await bookAppointment(contractorId, {
      startTime: proposedStart,
      title: `Estimate — ${contact.name}`,
      customerName: contact.name,
      customerPhone: phone,
      customerEmail: contact.emails?.[0],
      customerAddress: resolved?.formatted || addressForBooking || undefined,
      customerAddressComponents: resolved?.components,
      contactId,
      salespersonId: salespersonForBooking,
      timezone,
      scheduleSource: "ai_agent",
    });
    if (!result.success) {
      await handoff(conversation, `bookAppointment failed: ${result.error}`);
      return true;
    }
    // `success: true` from bookAppointment can still mean the HCP estimate
    // was created but the appointment time/employee was NOT scheduled
    // (see scheduleError on the result). Do NOT confirm the booking to the
    // customer — hand off so a human can finish placing them on the calendar.
    if (result.scheduleError) {
      await handoff(conversation, `HCP scheduling failed after estimate created: ${result.scheduleError}`);
      return true;
    }
    let salespersonFirstName = "your specialist";
    let salespersonFullName: string | null = null;
    const [sp] = await db.select({ name: users.name }).from(users)
      .where(eq(users.id, salespersonForBooking)).limit(1);
    if (sp?.name) {
      salespersonFullName = sp.name;
      salespersonFirstName = sp.name.split(" ")[0];
    }
    const confirmText = `You're booked for ${fmtSlot(proposedStart, timezone)} with ${salespersonFirstName}. We'll see you then!`;
    const msg = await sendAgentSms({ contractorId, contactId, toNumber: phone, fromNumber, body: confirmText });
    await db.update(aiSchedulingConversations).set({
      status: "booked",
      exchangeCount: (conversation.exchangeCount ?? 0) + 1,
      lastOutboundMessageId: msg?.id,
      updatedAt: new Date(),
    }).where(eq(aiSchedulingConversations.id, conversation.id));
    await writeBookingActivity(conversation, contact, proposedStart, salespersonFullName, timezone);
    broadcastToContractor(contractorId, {
      type: "ai_scheduling_conversation_updated",
      contactId,
      status: "booked",
    });
    return true;
  } catch (err) {
    await handoff(conversation, `Booking error: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export interface HandleInboundParams {
  contractorId: string;
  contactId: string;
  messageId: string;
}

/**
 * Public entry point — invoked fire-and-forget from the inbound SMS webhook.
 * Returns true when the agent processed the message (open conversation
 * existed or was created), false when it skipped (no scheduling-intent
 * outreach in the window, contractor disabled, etc).
 */
export async function handleInbound(params: HandleInboundParams): Promise<boolean> {
  const { contractorId, contactId, messageId } = params;
  try {
    const [contractor] = await db.select().from(contractors).where(eq(contractors.id, contractorId)).limit(1);
    if (!contractor || !contractor.aiSchedulingEnabled) {
      return false;
    }

    const inboundMsg = await storage.getMessage(messageId, contractorId);
    if (!inboundMsg || inboundMsg.direction !== "inbound") return false;
    const inboundText = (inboundMsg.content || "").trim();
    if (!inboundText) return false;

    if (STOP_KEYWORDS.test(inboundText)) {
      const existing = await findOpenConversation(contractorId, contactId);
      if (existing) await handoff(existing, "Customer requested a human / sent stop keyword");
      return false;
    }
    // Carrier-compliance HELP keywords stay with existing auto-reply handling.
    if (HELP_KEYWORDS.test(inboundText)) {
      log.info(`[ai-scheduling] HELP keyword received from contact ${contactId} — leaving to carrier compliance handler`);
      return false;
    }

    let conversation = await findOpenConversation(contractorId, contactId);
    if (!conversation) {
      const trigger = await findRecentSchedulingIntentMessage(
        contractorId,
        contactId,
        contractor.aiSchedulingWindowHours ?? 72,
      );
      if (!trigger) return false;
      // Durable suppression: if a conversation already exists for this
      // outreach (handed_off, booked, failed, anything), do NOT restart.
      // A single scheduling-intent SMS gets at most one AI conversation —
      // manual takeover, customer STOP, and post-booking follow-ups must
      // all stay terminal until the workflow sends a fresh outreach.
      const existingForTrigger = await findConversationByTrigger(contractorId, contactId, trigger.id);
      if (existingForTrigger) {
        log.info(
          `[ai-scheduling] suppressing restart — conversation ${existingForTrigger.id} already engaged with trigger ${trigger.id} (status=${existingForTrigger.status})`,
        );
        return false;
      }
      const [created] = await db.insert(aiSchedulingConversations).values({
        contractorId,
        contactId,
        triggeringMessageId: trigger.id,
        status: "active",
        exchangeCount: 0,
        lastInboundMessageId: messageId,
      }).returning();
      conversation = created;
    } else {
      await db.update(aiSchedulingConversations)
        .set({ lastInboundMessageId: messageId, updatedAt: new Date() })
        .where(eq(aiSchedulingConversations.id, conversation.id));
    }

    if ((conversation.exchangeCount ?? 0) >= MAX_EXCHANGES) {
      await handoff(conversation, `Reached max ${MAX_EXCHANGES} AI exchanges without a booking`);
      return true;
    }

    const contact = await storage.getContact(contactId, contractorId);
    if (!contact) return false;
    // Reply destination MUST be the number that actually sent the inbound
    // SMS — contacts can have multiple phones and texting an arbitrary one
    // can leak appointment/address details to a different recipient.
    const phone = inboundMsg.fromNumber || contact.phones?.[0];
    if (!phone) return false;
    const fromNumber = await pickFromNumber(contractorId, contactId);
    if (!fromNumber) {
      await handoff(conversation, "No Dialpad from-number available for AI reply");
      return true;
    }

    const timezone = contractor.timezone || "America/New_York";
    const now = new Date();

    // Deterministic confirmation/decline bypass: when we're already
    // `awaiting_confirmation` and the customer's message starts with a
    // clear YES or NO, skip the LLM entirely. This protects the booking
    // path from model regressions and the json_object response_format
    // failing on edge providers — the most consequential transition is
    // always under deterministic control.
    if (conversation.status === "awaiting_confirmation" && conversation.proposedStartTime) {
      if (YES_PATTERN.test(inboundText)) {
        return await handleConfirmation(conversation, contractorId, contactId, contact, phone, fromNumber, timezone);
      }
      if (NO_PATTERN.test(inboundText)) {
        await db.update(aiSchedulingConversations).set({
          status: "active",
          proposedStartTime: null,
          proposedSalespersonUserId: null,
          updatedAt: new Date(),
        }).where(eq(aiSchedulingConversations.id, conversation.id));
        conversation = { ...conversation, status: "active", proposedStartTime: null, proposedSalespersonUserId: null };
      }
    }

    const slotInfo = await findUpcomingSlots(contractorId, timezone, now);
    const systemPrompt = buildSystemPrompt(contractor, contact, slotInfo.hint, now, timezone);
    const thread = await loadRecentThread(contractorId, contactId);
    const parsed = await callLlm(contractorId, systemPrompt, thread, inboundText);

    if (!parsed) {
      await handoff(conversation, "AI parse failed");
      return true;
    }
    if (parsed.intent === "request_human") {
      await handoff(conversation, "Customer asked for a human");
      return true;
    }
    if (parsed.confidence < MIN_INTENT_CONFIDENCE) {
      await handoff(conversation, `LLM low confidence (${parsed.confidence})`);
      return true;
    }

    if (parsed.intent === "decline") {
      await db.update(aiSchedulingConversations).set({
        status: "active",
        proposedStartTime: null,
        proposedSalespersonUserId: null,
        updatedAt: new Date(),
      }).where(eq(aiSchedulingConversations.id, conversation.id));
    }

    // Decide whether to propose a slot. We do that when we have BOTH a
    // candidate startTime AND an address. Either may have been supplied in
    // an earlier turn — fall back to the conversation's persisted state so
    // the customer can split "Tuesday 3pm" and "123 Main St" across two
    // messages without losing the requested time.
    const parsedStart = parsed.startTimeIso ? new Date(parsed.startTimeIso) : null;
    const candidateStart = parsedStart && !Number.isNaN(parsedStart.getTime())
      ? parsedStart
      : conversation.proposedStartTime ?? null;
    const rawCandidateAddress = parsed.address?.trim() || conversation.proposedAddress || contact.address || "";
    const haveAddress = rawCandidateAddress && hasRealStreetAddress(rawCandidateAddress);

    let resolvedAddress: { formatted: string; components: AddressComponents } | null = null;
    if (haveAddress) {
      resolvedAddress = await resolveAddress(rawCandidateAddress);
    }
    const candidateAddress = resolvedAddress?.formatted || rawCandidateAddress;

    // Reject past times deterministically — `selectNextAvailableSalesperson`
    // does not filter past slots, and a model misparse or "yesterday"-style
    // wording must never produce a backdated booking.
    if (candidateStart && candidateStart.getTime() <= Date.now()) {
      const replyBody = "That time has already passed. What date and time work for you?";
      const msg = await sendAgentSms({ contractorId, contactId, toNumber: phone, fromNumber, body: replyBody });
      await db.update(aiSchedulingConversations).set({
        proposedStartTime: null,
        exchangeCount: (conversation.exchangeCount ?? 0) + 1,
        lastOutboundMessageId: msg?.id,
        updatedAt: new Date(),
      }).where(eq(aiSchedulingConversations.id, conversation.id));
      return true;
    }

    if (candidateStart && resolvedAddress) {
      const salesperson = await selectNextAvailableSalesperson(contractorId, candidateStart, timezone);
      let proposalText: string;
      let chosenStart: Date;
      let chosenSalespersonId: string;

      if (salesperson) {
        chosenStart = candidateStart;
        chosenSalespersonId = salesperson.userId;
        proposalText = `Got it — ${fmtSlot(chosenStart, timezone)} at ${candidateAddress}. Reply YES to confirm.`;
      } else {
        const alternatives = await findAlternatives(contractorId, timezone, candidateStart);
        if (alternatives.length === 0) {
          await handoff(conversation, "No availability near the requested time");
          return true;
        }
        chosenStart = alternatives[0].start;
        const altSp = await selectNextAvailableSalesperson(contractorId, chosenStart, timezone);
        if (!altSp) {
          await handoff(conversation, "Could not assign a salesperson to the alternative slot");
          return true;
        }
        chosenSalespersonId = altSp.userId;
        const others = alternatives
          .slice(1)
          .map((s) => fmtSlot(s.start, timezone))
          .filter(Boolean);
        const otherText = others.length > 0 ? ` Other openings: ${others.join("; ")}.` : "";
        proposalText = `That time is taken — how about ${fmtSlot(chosenStart, timezone)} at ${candidateAddress}?${otherText} Reply YES to confirm.`;
      }

      const msg = await sendAgentSms({ contractorId, contactId, toNumber: phone, fromNumber, body: proposalText });
      await db.update(aiSchedulingConversations).set({
        status: "awaiting_confirmation",
        proposedStartTime: chosenStart,
        proposedSalespersonUserId: chosenSalespersonId,
        proposedAddress: candidateAddress,
        exchangeCount: (conversation.exchangeCount ?? 0) + 1,
        lastOutboundMessageId: msg?.id,
        updatedAt: new Date(),
      }).where(eq(aiSchedulingConversations.id, conversation.id));
      return true;
    }

    // Otherwise, send the LLM's plain reply (asks for missing info or
    // clarifies). Persist whatever fragments of state we DID extract so the
    // next turn can complete the proposal — e.g. the customer texts
    // "Tuesday 3pm" first, agent asks for address, customer replies
    // "123 Main St" — second turn must still know the requested start time.
    const replyBody = parsed.reply.slice(0, 320);
    const msg = await sendAgentSms({ contractorId, contactId, toNumber: phone, fromNumber, body: replyBody });
    await db.update(aiSchedulingConversations).set({
      exchangeCount: (conversation.exchangeCount ?? 0) + 1,
      proposedAddress: candidateAddress || conversation.proposedAddress,
      proposedStartTime: candidateStart ?? conversation.proposedStartTime,
      lastOutboundMessageId: msg?.id,
      updatedAt: new Date(),
    }).where(eq(aiSchedulingConversations.id, conversation.id));

    log.info(
      `[ai-scheduling] contractor=${contractorId} contact=${contactId} intent=${parsed.intent} confidence=${parsed.confidence} status=${conversation.status}`,
    );
    return true;
  } catch (err) {
    log.error("handleInbound failed:", err);
    return false;
  }
}

/**
 * Stop the AI agent's open conversation for a contact (manual take-over from
 * the contact page). No-op when there is no open conversation.
 */
export async function takeOverConversation(contractorId: string, contactId: string, byUserId: string | null): Promise<boolean> {
  const conv = await findOpenConversation(contractorId, contactId);
  if (!conv) return false;
  await handoff(conv, byUserId ? `Manually taken over by user ${byUserId}` : "Manually taken over");
  return true;
}

export const aiSchedulingAgent = { handleInbound, takeOverConversation };
