import { insertContactSchema, type InsertContact } from "@shared/schema";

export interface ParseLeadCsvError {
  /** 1-based row number (includes header row; row 1 = header). */
  row: number;
  error: string;
  data: unknown;
}

export interface ParseLeadCsvResult {
  total: number;
  validContacts: Array<Omit<InsertContact, 'contractorId'>>;
  errors: Array<ParseLeadCsvError>;
  /** Set when the entire CSV is rejected before row-level parsing begins. */
  fatalError?: string;
}

const MAX_BYTES = 1024 * 1024;      // 1 MB
const MAX_ROWS  = 1000;

/**
 * Parse and validate a CSV string of lead data.
 *
 * Input contract: `string` is canonical here because the client sends the CSV
 * as a JSON string field in the request body (`{ csvData: "..." }`), not as a
 * raw multipart/form-data upload. If a binary upload path is added in future,
 * callers should convert the Buffer to a UTF-8 string before calling this
 * function (e.g. `buffer.toString('utf8')`).
 *
 * Structural constraints are enforced inside this function so that callers
 * only need to map the returned result to HTTP responses — no pre-parsing
 * is required in the route handler.
 *
 * Constraints:
 *  - Maximum 1 MB of input
 *  - At least one header row + one data row
 *  - At most 1 000 data rows
 *  - Header row must contain a `name` column
 *
 * When a structural constraint is violated, `fatalError` is set on the result
 * and both `total` and `validContacts` are 0/empty — the route should respond
 * with 400.
 *
 * Row-level parse/validation errors are collected in `errors`; the rest of the
 * rows are returned in `validContacts` with `type` forced to `'lead'`.
 *
 * @throws Never — all errors are captured in the returned result.
 */
export function parseLeadCsv(csvData: string): ParseLeadCsvResult {
  if (csvData.length > MAX_BYTES) {
    return { total: 0, validContacts: [], errors: [], fatalError: "CSV file too large (must be less than 1 MB)" };
  }

  const lines = csvData.trim().split('\n');

  if (lines.length < 2) {
    return { total: 0, validContacts: [], errors: [], fatalError: "CSV must contain at least a header row and one data row" };
  }

  if (lines.length > MAX_ROWS + 1) {
    return { total: 0, validContacts: [], errors: [], fatalError: `CSV cannot contain more than ${MAX_ROWS} leads` };
  }

  const headers = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  if (!headers.includes('name')) {
    return { total: 0, validContacts: [], errors: [], fatalError: "CSV must include a 'name' column" };
  }

  const total = lines.length - 1;
  const validContacts: Array<Omit<InsertContact, 'contractorId'>> = [];
  const errors: Array<ParseLeadCsvError> = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = parseQuotedCsvRow(lines[i]);

      // CSV injection guard — prefix formula triggers with a single quote.
      const sanitized = values.map((val) =>
        val && /^[=+\-@\t\r]/.test(val) ? "'" + val : val
      );

      const row: Record<string, unknown> = {};
      headers.forEach((header, idx) => {
        if (sanitized[idx] && sanitized[idx] !== '') {
          row[header] = sanitized[idx];
        }
      });

      if (row.followUpDate) {
        const date = new Date(row.followUpDate as string);
        if (isNaN(date.getTime())) {
          errors.push({ row: i + 1, error: "Invalid date format (use YYYY-MM-DD)", data: row });
          continue;
        }
        row.followUpDate = date;
      }

      const emailVal  = typeof row.email === 'string' ? row.email.trim() : '';
      const phoneVal  = typeof row.phone === 'string' ? row.phone.trim() : '';

      const result = insertContactSchema.omit({ contractorId: true }).safeParse({
        name:         typeof row.name    === 'string' ? row.name.trim()    : row.name,
        type:         'lead' as const,
        emails:       emailVal  ? [emailVal]  : [],
        phones:       phoneVal  ? [phoneVal]  : [],
        address:      typeof row.address === 'string' ? row.address.trim() || undefined : undefined,
        source:       typeof row.source  === 'string' ? row.source.trim()  || 'CSV Import' : 'CSV Import',
        notes:        typeof row.notes   === 'string' ? row.notes.trim()   || undefined : undefined,
        followUpDate: row.followUpDate,
      });

      if (!result.success) {
        const msg = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        errors.push({ row: i + 1, error: `Validation failed: ${msg}`, data: row });
        continue;
      }

      validContacts.push(result.data);
    } catch (err) {
      errors.push({
        row: i + 1,
        error: err instanceof Error ? err.message : "Unknown error",
        data: lines[i],
      });
    }
  }

  return { total, validContacts, errors };
}

/** RFC-4180-compatible CSV row parser (handles quoted fields and escaped quotes). */
function parseQuotedCsvRow(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"') {
      if (inQuotes && line[j + 1] === '"') {
        current += '"';
        j++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values;
}
