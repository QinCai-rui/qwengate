import type { JsonSchema } from '../types/openai.ts';
import { SchemaValidationError } from './schema.ts';

interface ValidationContext {
  rootSchema: JsonSchema;
}

export function validateObject(
  value: unknown, schema: JsonSchema, path: string, ctx: ValidationContext,
  validate: (v: unknown, s: JsonSchema, p: string, c: ValidationContext) => unknown
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new SchemaValidationError(`Expected object at ${path}, got ${value === null ? 'null' : 'undefined'}`, path, value);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaValidationError(`Expected object at ${path}, got ${typeof value}`, path, value);
  }
  const obj = value as Record<string, unknown>;
  const validated: Record<string, unknown> = {};
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in obj) || obj[req] === undefined) {
        throw new SchemaValidationError(`Missing required property '${req}' at ${path}`, `${path}.${req}`, undefined);
      }
    }
  }
  const keys = Object.keys(obj);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    throw new SchemaValidationError(`Object at ${path} has ${keys.length} properties, minimum is ${schema.minProperties}`, path, value);
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    throw new SchemaValidationError(`Object at ${path} has ${keys.length} properties, maximum is ${schema.maxProperties}`, path, value);
  }
  const properties = schema.properties || {};
  const patternProperties = schema.patternProperties || {};
  const seenKeys = new Set<string>();
  for (const [key, val] of Object.entries(obj)) {
    seenKeys.add(key);
    const propSchema = properties[key];
    if (propSchema) {
      validated[key] = validate(val, propSchema, `${path}.${key}`, ctx);
    } else {
      let matchedPattern = false;
      for (const [pattern, patSchema] of Object.entries(patternProperties)) {
        if (new RegExp(pattern).test(key)) {
          validated[key] = validate(val, patSchema, `${path}.${key}`, ctx);
          matchedPattern = true;
        }
      }
      if (!matchedPattern) {
        if (schema.additionalProperties === false) {
          throw new SchemaValidationError(`Unexpected property '${key}' at ${path} (additionalProperties is false)`, `${path}.${key}`, val);
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          validated[key] = validate(val, schema.additionalProperties as JsonSchema, `${path}.${key}`, ctx);
        } else {
          validated[key] = val;
        }
      }
    }
  }
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!seenKeys.has(key) && (propSchema as JsonSchema).default !== undefined) {
      validated[key] = (propSchema as JsonSchema).default;
    }
  }
  return validated;
}

export function validateArray(
  value: unknown, schema: JsonSchema, path: string, ctx: ValidationContext,
  validate: (v: unknown, s: JsonSchema, p: string, c: ValidationContext) => unknown
): unknown[] {
  if (!Array.isArray(value)) {
    throw new SchemaValidationError(`Expected array at ${path}, got ${typeof value}`, path, value);
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new SchemaValidationError(`Array at ${path} has ${value.length} items, minimum is ${schema.minItems}`, path, value);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new SchemaValidationError(`Array at ${path} has ${value.length} items, maximum is ${schema.maxItems}`, path, value);
  }
  if (schema.uniqueItems) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i], value[j])) {
          throw new SchemaValidationError(`Array at ${path} has duplicate items at indices ${i} and ${j} (uniqueItems is true)`, path, value);
        }
      }
    }
  }
  if (schema.items) {
    if (Array.isArray(schema.items)) {
      const itemsArray = schema.items as JsonSchema[];
      return value.map((item, i) => {
        const itemSchema = i < itemsArray.length ? itemsArray[i] : (schema.additionalProperties as JsonSchema | undefined);
        if (itemSchema) { return validate(item, itemSchema, `${path}[${i}]`, ctx); }
        return item;
      });
    }
    return value.map((item, i) => validate(item, schema.items as JsonSchema, `${path}[${i}]`, ctx));
  }
  return value;
}

export function validateString(value: unknown, schema: JsonSchema, path: string): string {
  if (typeof value !== 'string') {
    throw new SchemaValidationError(`Expected string at ${path}, got ${typeof value}`, path, value);
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new SchemaValidationError(`String at ${path} is ${value.length} chars, minimum is ${schema.minLength}`, path, value);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new SchemaValidationError(`String at ${path} is ${value.length} chars, maximum is ${schema.maxLength}`, path, value);
  }
  if (schema.pattern) {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        throw new SchemaValidationError(`String at ${path} does not match pattern '${schema.pattern}'`, path, value);
      }
    } catch (e) { if (e instanceof SchemaValidationError) throw e; }
  }
  if (schema.format) { validateFormat(value, schema.format, path); }
  return value;
}

export function validateFormat(value: string, format: string, path: string): void {
  switch (format) {
    case 'date-time': if (isNaN(Date.parse(value))) throw new SchemaValidationError(`String at ${path} is not a valid date-time: '${value}'`, path, value); break;
    case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) throw new SchemaValidationError(`String at ${path} is not a valid date: '${value}'`, path, value); break;
    case 'email': if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new SchemaValidationError(`String at ${path} is not a valid email: '${value}'`, path, value); break;
    case 'uri': case 'url': try { new URL(value); } catch { throw new SchemaValidationError(`String at ${path} is not a valid URI: '${value}'`, path, value); } break;
    case 'uuid': if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new SchemaValidationError(`String at ${path} is not a valid UUID: '${value}'`, path, value); break;
  }
}

export function validateNumber(value: unknown, schema: JsonSchema, path: string, type: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new SchemaValidationError(`Expected number at ${path}, got ${typeof value}`, path, value);
  }
  if (type === 'integer' && !Number.isInteger(value)) {
    throw new SchemaValidationError(`Expected integer at ${path}, got float ${value}`, path, value);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new SchemaValidationError(`Number ${value} at ${path} is below minimum ${schema.minimum}`, path, value);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new SchemaValidationError(`Number ${value} at ${path} is above maximum ${schema.maximum}`, path, value);
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    throw new SchemaValidationError(`Number ${value} at ${path} is not greater than exclusive minimum ${schema.exclusiveMinimum}`, path, value);
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    throw new SchemaValidationError(`Number ${value} at ${path} is not less than exclusive maximum ${schema.exclusiveMaximum}`, path, value);
  }
  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    const remainder = value % schema.multipleOf;
    if (Math.abs(remainder) > 1e-10 && Math.abs(remainder - schema.multipleOf) > 1e-10) {
      throw new SchemaValidationError(`Number ${value} at ${path} is not a multiple of ${schema.multipleOf}`, path, value);
    }
  }
  return value;
}

export function validateBoolean(value: unknown, _schema: JsonSchema, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaValidationError(`Expected boolean at ${path}, got ${typeof value}`, path, value);
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => key in bObj && deepEqual(aObj[key], bObj[key]));
  }
  return false;
}
