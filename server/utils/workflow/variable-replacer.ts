/**
 * Variable replacement utility for workflow automation
 * Replaces {{placeholders}} with actual values during workflow execution
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Replace all {{placeholder}} variables in a string with actual values
 * @param template - String containing {{placeholder}} variables
 * @param variables - Object with variable values
 * @returns String with all variables replaced
 */
export function replaceVariables(template: string, variables: Record<string, unknown>): string {
  if (!template || typeof template !== 'string') {
    return template;
  }

  // Regular expression to match {{variable.path}} patterns
  const variablePattern = /\{\{([^}]+)\}\}/g;

  return template.replace(variablePattern, (_match, variablePath) => {
    // Trim whitespace from variable path
    const cleanPath = (variablePath as string).trim();
    
    // Split the path (e.g., "lead.name" => ["lead", "name"])
    const pathParts = cleanPath.split('.');
    
    // Navigate through the variables object
    let value: unknown = variables;
    for (const part of pathParts) {
      if (DANGEROUS_KEYS.has(part)) {
        return '';
      }
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, part)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        // Variable not found, return empty string
        return '';
      }
    }

    // Convert value to string
    if (value === null || value === undefined) {
      return '';
    }
    
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  });
}

/**
 * Replace variables in an object recursively
 * @param obj - Object that may contain {{placeholder}} strings
 * @param variables - Object with variable values
 * @returns New object with all variables replaced
 */
export function replaceVariablesInObject(obj: unknown, variables: Record<string, unknown>): unknown {
  if (typeof obj === 'string') {
    return replaceVariables(obj, variables);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => replaceVariablesInObject(item, variables));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(obj as object)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      result[key] = replaceVariablesInObject((obj as Record<string, unknown>)[key], variables);
    }
    return result;
  }

  return obj;
}

/**
 * Traverse a dot-separated path through an arbitrary object.
 * Returns the value at the path, or `undefined` if any segment is missing.
 *
 * Example: getNestedValue({ lead: { name: 'Alice' } }, 'lead.name') → 'Alice'
 *
 * @param obj  - Root object to traverse (typically `context.variables`)
 * @param path - Dot-separated field path (e.g. "lead.status", "job.contact.name")
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cursor: unknown = obj;
  for (const part of parts) {
    if (DANGEROUS_KEYS.has(part)) {
      return undefined;
    }
    if (cursor && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, part)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

