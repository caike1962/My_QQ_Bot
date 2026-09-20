export type JsonObject = Record<string, unknown>;
export type OneBotId = number | string;
export type OneBotMessage = string | unknown[];

export function requireObject(value: unknown, context = "arguments"): JsonObject {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

export function requireId(value: unknown, name: string): OneBotId {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${name} must be a number or non-empty string`);
}

export function optionalId(value: unknown, name: string): OneBotId | undefined {
  if (value == null) return undefined;
  return requireId(value, name);
}

export function requireMessage(value: unknown, name: string): OneBotMessage {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return value;
  throw new Error(`${name} must be a non-empty string or OneBot message segment array`);
}
