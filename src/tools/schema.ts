import type { JsonSchema } from '../types/openai.ts';
import { validateObject, validateArray, validateString, validateNumber, validateBoolean, deepEqual } from './schemaValidators.ts';

export class SchemaValidationError extends Error {
  public readonly path: string;
  public readonly value: unknown;
  constructor(message: string, path: string, value?: unknown) {
    super(message);
    this.name = 'SchemaValidationError';
    this.path = path;
    this.value = value;
  }
}

interface ValidationContext {
  rootSchema: JsonSchema;
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema, path: string = '$'): unknown {
  const ctx: ValidationContext = { rootSchema: schema };
  return validate(value, schema, path, ctx);
}

function validate(value: unknown, schema: JsonSchema, path: string, ctx: ValidationContext): unknown {
  if (typeof schema === 'boolean') {
    if (!schema) throw new SchemaValidationError(`Schema is false — no value allowed at ${path}`, path, value);
    return value;
  }
  if (Object.keys(schema).length === 0) return value;
  if (schema.nullable && (value === null || value === undefined)) return value;
  if (schema.$ref) { const resolved = resolveRef(schema.$ref, ctx); return validate(value, resolved, path, ctx); }
  if (schema.allOf) { value = validateAllOf(value, schema.allOf, path, ctx); }
  if (schema.anyOf) { value = validateAnyOf(value, schema.anyOf, path, ctx); }
  if (schema.oneOf) { value = validateOneOf(value, schema.oneOf, path, ctx); }
  if (schema.not) { validateNot(value, schema.not, path, ctx); }
  if (schema.if) { value = validateIfThenElse(value, schema, path, ctx); }
  const schemaType = schema.type;
  if (schemaType) {
    const types = Array.isArray(schemaType) ? schemaType : [schemaType];
    let matched = false;
    let lastError: SchemaValidationError | null = null;
    for (const t of types) {
      if (t === 'null' && value === null) { matched = true; break; }
      try {
        const result = validateByType(value, t, schema, path, ctx);
        value = result;
        matched = true;
        break;
      } catch (e) { if (e instanceof SchemaValidationError) lastError = e; }
    }
    if (!matched) {
      throw lastError || new SchemaValidationError(`Value at ${path} does not match any of types [${types.join(', ')}]`, path, value);
    }
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some(e => deepEqual(e, value))) {
      throw new SchemaValidationError(`Value at ${path} is not one of [${schema.enum.map(e => JSON.stringify(e)).join(', ')}]`, path, value);
    }
  }
  if (schema.const !== undefined) {
    if (!deepEqual(schema.const, value)) {
      throw new SchemaValidationError(`Value at ${path} does not match const ${JSON.stringify(schema.const)}`, path, value);
    }
  }
  return value;
}

function validateByType(value: unknown, type: string, schema: JsonSchema, path: string, ctx: ValidationContext): unknown {
  switch (type) {
    case 'object': return validateObject(value, schema, path, ctx, validate);
    case 'array': return validateArray(value, schema, path, ctx, validate);
    case 'string': return validateString(value, schema, path);
    case 'number': case 'integer': return validateNumber(value, schema, path, type);
    case 'boolean': return validateBoolean(value, schema, path);
    case 'null': if (value !== null) throw new SchemaValidationError(`Expected null at ${path}, got ${typeof value}`, path, value); return null;
    default: return value;
  }
}

function resolveRef(ref: string, ctx: ValidationContext): JsonSchema {
  if (!ref.startsWith('#/')) throw new SchemaValidationError(`External $ref '${ref}' is not supported`, '$', ref);
  const parts = ref.substring(2).split('/');
  let current: unknown = ctx.rootSchema;
  for (const part of parts) {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current && typeof current === 'object' && decoded in current) {
      current = (current as Record<string, unknown>)[decoded];
    } else { throw new SchemaValidationError(`$ref '${ref}' could not be resolved — '${decoded}' not found`, '$', ref); }
  }
  return current as JsonSchema;
}

function validateAllOf(value: unknown, schemas: JsonSchema[], path: string, ctx: ValidationContext): unknown {
  let result = value;
  for (let i = 0; i < schemas.length; i++) { result = validate(result, schemas[i], `${path}/allOf[${i}]`, ctx); }
  return result;
}

function validateAnyOf(value: unknown, schemas: JsonSchema[], path: string, ctx: ValidationContext): unknown {
  const errors: string[] = [];
  for (let i = 0; i < schemas.length; i++) {
    try { return validate(value, schemas[i], path, ctx); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  throw new SchemaValidationError(`Value at ${path} does not match any of ${schemas.length} anyOf schemas: ${errors.join('; ')}`, path, value);
}

function validateOneOf(value: unknown, schemas: JsonSchema[], path: string, ctx: ValidationContext): unknown {
  let matchCount = 0;
  let matchedValue: unknown = value;
  for (let i = 0; i < schemas.length; i++) {
    try { matchedValue = validate(value, schemas[i], path, ctx); matchCount++; } catch { /* expected */ }
  }
  if (matchCount === 0) throw new SchemaValidationError(`Value at ${path} does not match any of ${schemas.length} oneOf schemas`, path, value);
  if (matchCount > 1) throw new SchemaValidationError(`Value at ${path} matches ${matchCount} oneOf schemas (must match exactly one)`, path, value);
  return matchedValue;
}

function validateNot(value: unknown, schema: JsonSchema, path: string, ctx: ValidationContext): void {
  try {
    validate(value, schema, path, ctx);
    throw new SchemaValidationError(`Value at ${path} must NOT match the "not" schema`, path, value);
  } catch (e) {
    if (e instanceof SchemaValidationError && e.message.includes('must NOT match')) throw e;
  }
}

function validateIfThenElse(value: unknown, schema: JsonSchema, path: string, ctx: ValidationContext): unknown {
  let conditionMet = false;
  try { validate(value, schema.if!, path, ctx); conditionMet = true; } catch { conditionMet = false; }
  if (conditionMet && schema.then) return validate(value, schema.then, path, ctx);
  if (!conditionMet && schema.else) return validate(value, schema.else, path, ctx);
  return value;
}
