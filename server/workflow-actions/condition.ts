import type { WorkflowStep } from "@shared/schema";
import type { ExecutionContext, StepResult } from "./types";
import { getNestedValue } from "../utils/workflow/variable-replacer";
import { logger } from "../utils/logger";

const log = logger('WorkflowAction:Condition');

function getFieldValue(field: string, context: ExecutionContext): unknown {
  if (!field) return undefined;
  if (field.startsWith('trigger.')) {
    return (context.triggerData as Record<string, unknown>)[field.substring(8)];
  }
  if (field.startsWith('variable.')) {
    return context.variables[field.substring(9)];
  }
  const fromVars = getNestedValue(context.variables, field);
  if (fromVars !== undefined) return fromVars;

  // Fallback: if the field is prefixed with the trigger entity type
  // (e.g. "lead.tags"), resolve the remainder against the raw triggerData.
  // This lets conditions reference fields that aren't surfaced by the
  // template variable extractor (e.g. the contact's `tags` array).
  const dotIdx = field.indexOf('.');
  if (dotIdx > 0) {
    const prefix = field.substring(0, dotIdx);
    const rest = field.substring(dotIdx + 1);
    if (prefix === context.triggerEntityType) {
      return getNestedValue(context.triggerData, rest);
    }
  }
  return undefined;
}

function normalizeForCompare(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Identify the high-level shape of a resolved field value so the execution
 * detail UI can render the right diagnostic ("array", "string", etc.) without
 * having to re-derive it from the JSON it gets back.
 */
function classifyValueType(v: unknown):
  'array' | 'string' | 'number' | 'boolean' | 'null' | 'object' | 'undefined' {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
  return 'object';
}

interface MultiTagValue {
  tags: string[];
  match: 'any' | 'all';
}

function parseTagComparisonValue(value: unknown): MultiTagValue | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.tags)) {
      const tags = (obj.tags as unknown[]).map(normalizeForCompare).filter(Boolean);
      const match: 'any' | 'all' = obj.match === 'all' ? 'all' : 'any';
      return { tags, match };
    }
  }
  if (Array.isArray(value)) {
    return { tags: value.map(normalizeForCompare).filter(Boolean), match: 'any' };
  }
  return null;
}

export async function handleEvaluateCondition(
  _step: WorkflowStep,
  config: Record<string, unknown>,
  context: ExecutionContext,
): Promise<StepResult> {
  const field    = String(config.conditionField    ?? config.field    ?? '');
  const operator = String(config.conditionOperator ?? config.operator ?? '');
  const value    =        config.conditionValue    ?? config.value;
  const fieldValue = getFieldValue(field, context);

  // Build a baseline diagnostic envelope so we can attach it to both success
  // and error results. step-runner persists this on the conditional_branch
  // step log so the execution-detail UI can show *why* the branch went the
  // way it did (resolved value, type, target, operator).
  const diagnostic = {
    field,
    operator,
    target: value as unknown,
    resolvedValue: fieldValue,
    resolvedValueType: classifyValueType(fieldValue),
    note: fieldValue === undefined
      ? 'field resolved to undefined — check that the trigger entity type matches the field path'
      : undefined,
  };

  try {
    const isArrayField = Array.isArray(fieldValue);
    const multiTag = parseTagComparisonValue(value);

    let result = false;
    if (isArrayField) {
      const arr = (fieldValue as unknown[]).map(normalizeForCompare);
      if (multiTag) {
        const targets = multiTag.tags;
        const matchAny = targets.some((t) => arr.includes(t));
        const matchAll = targets.every((t) => arr.includes(t));
        const matched = multiTag.match === 'all' ? matchAll : matchAny;
        switch (operator) {
          case 'contains':       result = targets.length === 0 ? false : matched; break;
          case 'not_contains':   result = targets.length === 0 ? true  : !matched; break;
          case 'equals': {
            const setA = new Set(arr);
            const setB = new Set(targets);
            result = setA.size === setB.size && targets.every((t) => setA.has(t));
            break;
          }
          case 'not_equals': {
            const setA = new Set(arr);
            const setB = new Set(targets);
            result = !(setA.size === setB.size && targets.every((t) => setA.has(t)));
            break;
          }
          case 'is_empty':       result = arr.length === 0; break;
          case 'is_not_empty':   result = arr.length > 0; break;
          default:
            return { success: false, error: `Operator "${operator}" is not supported for array/tag fields`, data: diagnostic };
        }
      } else {
        const target = normalizeForCompare(value);
        switch (operator) {
          case 'contains':       result = arr.includes(target); break;
          case 'not_contains':   result = !arr.includes(target); break;
          case 'equals':         result = arr.length === 1 && arr[0] === target; break;
          case 'not_equals':     result = !(arr.length === 1 && arr[0] === target); break;
          case 'is_empty':       result = arr.length === 0; break;
          case 'is_not_empty':   result = arr.length > 0; break;
          default:
            return { success: false, error: `Operator "${operator}" is not supported for array/tag fields`, data: diagnostic };
        }
      }
    } else {
      switch (operator) {
        case 'equals':         result = String(fieldValue) === String(value); break;
        case 'not_equals':     result = String(fieldValue) !== String(value); break;
        case 'contains':       result = String(fieldValue).includes(String(value)); break;
        case 'not_contains':   result = !String(fieldValue).includes(String(value)); break;
        case 'greater_than':   result = Number(fieldValue) > Number(value); break;
        case 'less_than':      result = Number(fieldValue) < Number(value); break;
        case 'greater_or_equal': result = Number(fieldValue) >= Number(value); break;
        case 'less_or_equal':  result = Number(fieldValue) <= Number(value); break;
        case 'starts_with':    result = String(fieldValue).startsWith(String(value)); break;
        case 'ends_with':      result = String(fieldValue).endsWith(String(value)); break;
        case 'is_empty':       result = !fieldValue || String(fieldValue).trim() === ''; break;
        case 'is_not_empty':   result = Boolean(fieldValue) && String(fieldValue).trim() !== ''; break;
        default:
          return { success: false, error: `Unknown operator: ${operator}`, data: diagnostic };
      }
    }

    log.debug(`Condition evaluated: field="${field}" operator="${operator}" result=${result} (workflowId: ${context.workflowId})`);

    return { success: true, data: { result, ...diagnostic } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to evaluate condition',
      data: diagnostic,
    };
  }
}
