import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format, isToday, isTomorrow } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatStatusLabel(status: string): string {
  return status.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export function formatEntityTitle(type: 'estimate' | 'job', title: string): string {
  if (!/^\d+$/.test(title)) return title;
  return type === 'estimate' ? `Estimate #${title}` : `Job #${title}`;
}

export function hcpUrl(type: 'customer' | 'estimate' | 'job', id: string): string {
  if (type === 'customer') return `https://pro.housecallpro.com/app/customers/${id}`;
  if (type === 'estimate') return `https://pro.housecallpro.com/pro/estimates/${id}`;
  return `https://pro.housecallpro.com/app/jobs/${id}`;
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

export function safeToISO(date: Date | string | undefined | null): string | undefined {
  if (!date) return undefined;
  if (date instanceof Date) return isNaN(date.getTime()) ? undefined : date.toISOString();
  if (typeof date === 'string') {
    const d = new Date(date);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/**
 * Format a date for spreadsheet-style display (e.g. "3/25/2026").
 * Returns "—" when value is falsy or not a valid date.
 */
export function formatDateSpreadsheet(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

/**
 * Format a date for scheduling-style display ("Today", "Tomorrow", or "Mar 25, 2026").
 */
export function formatDateScheduling(date: Date): string {
  if (isToday(date)) return "Today";
  if (isTomorrow(date)) return "Tomorrow";
  return format(date, "MMM dd, yyyy");
}

/**
 * Format a date-time string for display (e.g. "3/25/2026, 10:30:00 AM").
 * Returns "Never" when value is falsy.
 */
export function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  return new Date(dateStr).toLocaleString();
}

/**
 * Return a calendar date's year-month-day as displayed in the browser's local
 * timezone (which is how react-day-picker builds the Date for each square),
 * formatted as "YYYY-MM-DD" for safe lexicographic comparison.
 */
export function localYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Current calendar date ("YYYY-MM-DD") in the given IANA timezone. Falls back to
 * the browser timezone if `timezone` is missing or invalid. Used by the internal
 * scheduling calendars so "today" is anchored to the contractor's timezone, not
 * the staff member's browser timezone (task #877).
 */
export function todayYmdInTimezone(timezone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: timezone || undefined }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", opts).format(new Date());
  }
}

export function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    const number = cleaned.slice(1);
    return `(${number.slice(0, 3)}) ${number.slice(3, 6)}-${number.slice(6)}`;
  }
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}

/**
 * Returns true if the entry is a usable phone number or empty (empty clears the
 * stored value). Validates by digit count (10-15 digits) rather than a brittle
 * character-class regex, so any common formatting variation is accepted.
 */
export function isValidPhoneEntry(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === "") return true;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function groupUsDigits(d: string): string {
  if (!d) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

/**
 * Progressively formats a phone number as the user types (and formats a
 * complete stored value on load into one consistent style):
 *  - US 10-digit numbers show as `(123) 456-7890`
 *  - Numbers with a leading +1/country code keep the prefix: `+1 (123) 456-7890`
 *  - Non-US / longer numbers fall back to a grouped display without breaking.
 * Empty input stays empty (allowing the field to be cleared).
 *
 * Never truncates or invents digits: out-of-range input (e.g. more than 15
 * digits) is preserved verbatim so validation can surface a clear error instead
 * of the value being silently trimmed into a "valid" one.
 */
export function formatPhoneAsTyped(input: string): string {
  const hasPlus = input.trimStart().startsWith("+");
  const allDigits = input.replace(/\D/g, "");
  if (!allDigits) return hasPlus ? "+" : "";

  // Peel off a US "+1"/leading-1 country code so the national part can be
  // grouped as a US number.
  let prefix = "";
  let national = allDigits;
  if (
    allDigits.startsWith("1") &&
    (hasPlus || allDigits.length === 11)
  ) {
    prefix = "+1 ";
    national = allDigits.slice(1);
  }

  // Apply US grouping only when the national part fits a US number (<=10 digits)
  // and there's no non-US country code. Anything longer falls through to the raw
  // fallback so lengths outside 10-15 stay visible to validation.
  const isUsPath = prefix !== "" || !hasPlus;
  if (isUsPath && national.length <= 10) {
    return prefix + groupUsDigits(national);
  }

  // Fallback: keep every digit (never truncate); preserve a leading + if typed.
  return (hasPlus ? "+" : "") + allDigits;
}
