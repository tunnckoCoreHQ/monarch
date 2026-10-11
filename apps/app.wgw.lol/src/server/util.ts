import type { Context } from "hono";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const byte of bytes) {
    out += ID_ALPHABET[byte % 32];
  }
  return `${prefix}_${out}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Lowercase letters, digits, and single dashes, 1 to 39 characters. */
export function toHandle(value: string): string {
  const handle = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 39);
  return handle === "" ? "user" : handle;
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    NAME_PATTERN.test(value) &&
    !value.endsWith(".git") &&
    value !== "." &&
    value !== ".."
  );
}

/** The rule isName checks, for error messages. */
export const NAME_RULE =
  "1 to 100 letters, digits, dots, dashes, or underscores; it starts with a letter or digit and does not end in .git";

export type FieldType = "string" | "number" | "boolean" | "array";

/**
 * Checks the type of each listed field of a JSON object and returns those fields. A missing or
 * null field is left out; any other wrong type is a 400 that names the field.
 */
export function fields<T>(
  value: unknown,
  types: { [K in keyof T]-?: FieldType },
  label = "the body",
): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be a JSON object`, "invalid_request");
  }
  const input = new Map(Object.entries(value));
  const output: Record<string, unknown> = {};
  for (const [field, type] of Object.entries<FieldType>(types)) {
    const item = input.get(field) ?? undefined;
    if (item === undefined) {
      continue;
    }
    if (type === "array" ? !Array.isArray(item) : typeof item !== type) {
      const name = label === "the body" ? field : `${label}.${field}`;
      throw new HttpError(
        400,
        `${name} must be ${type === "array" ? "an array" : `a ${type}`}`,
        "invalid_request",
      );
    }
    output[field] = item;
  }
  // SAFETY: each field of T was checked against its type above, and no other field is kept.
  return output as T;
}

/** Reads a JSON object body and checks its field types with `fields`. An empty body is `{}`. */
export async function readJson<T>(c: Context, types: { [K in keyof T]-?: FieldType }): Promise<T> {
  const text = await c.req.text();
  let value: unknown = {};
  if (text.trim() !== "") {
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(400, "the body must be JSON", "invalid_request");
    }
  }
  return fields<T>(value, types);
}
