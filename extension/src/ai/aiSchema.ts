/**
 * A small validator for the JSON Schema subset the AI tool input schemas use. VS Code
 * validates tool input itself, but the tool core cannot assume its caller is VS Code (a
 * later transport, or another extension calling the tool), so the core checks again.
 *
 * Supported: type (object, string, integer, number, boolean, array), enum, required,
 * properties, additionalProperties (false or a schema), minLength, maxLength, pattern,
 * minimum, maximum, minItems, maxItems, maxProperties. Anything else in a schema is a
 * programming error and is rejected when the schema is used.
 */
export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  enum?: readonly (string | number | boolean)[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxProperties?: number;
  default?: unknown;
}

export class AiInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AiInputError';
  }
}

export function validateInput(schema: JsonSchema, value: unknown, path = 'input'): void {
  if (schema.enum && !schema.enum.includes(value as never)) {
    throw new AiInputError(`${path} must be one of: ${schema.enum.map(String).join(', ')}.`);
  }

  switch (schema.type) {
    case 'object':
      return validateObject(schema, value, path);
    case 'array':
      return validateArray(schema, value, path);
    case 'string':
      if (typeof value !== 'string') throw new AiInputError(`${path} must be a string.`);
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new AiInputError(`${path} must have at least ${schema.minLength} characters.`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new AiInputError(`${path} must have at most ${schema.maxLength} characters.`);
      }
      // regexp disposition: schema is the static tool definition literal from aiToolDefinitions.ts (validateInput is called with definition.inputSchema); the only pattern is '^[0-9]{1,18}$', so it cannot be attacker-influenced.
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
        throw new AiInputError(`${path} has an invalid format.`);
      }
      return;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
        throw new AiInputError(`${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}.`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new AiInputError(`${path} must be at least ${schema.minimum}.`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new AiInputError(`${path} must be at most ${schema.maximum}.`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new AiInputError(`${path} must be true or false.`);
      return;
    default:
      throw new Error(`Unsupported schema at ${path}.`);
  }
}

function validateObject(schema: JsonSchema, value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiInputError(`${path} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    throw new AiInputError(`${path} may have at most ${schema.maxProperties} entries.`);
  }
  for (const required of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(record, required) || record[required] === undefined) {
      throw new AiInputError(`${path}.${required} is required.`);
    }
  }

  for (const key of keys) {
    const property = schema.properties?.[key];
    if (property && Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      validateInput(property, record[key], `${path}.${key}`);
    } else if (schema.additionalProperties === false || schema.additionalProperties === undefined) {
      throw new AiInputError(`${path} has an unknown property.`);
    } else if (typeof schema.additionalProperties === 'object') {
      validateInput(schema.additionalProperties, record[key], `${path}[entry]`);
    }
  }
}

function validateArray(schema: JsonSchema, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new AiInputError(`${path} must be an array.`);
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new AiInputError(`${path} must have at least ${schema.minItems} items.`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new AiInputError(`${path} must have at most ${schema.maxItems} items.`);
  }
  if (schema.items) {
    value.forEach((item, index) => validateInput(schema.items as JsonSchema, item, `${path}[${index}]`));
  }
}
