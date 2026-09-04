export type PublicJwk =
  | { crv: "P-256" | "P-384" | "P-521"; kty: "EC"; x: string; y: string }
  | { crv: "Ed25519"; kty: "OKP"; x: string }
  | { e: string; kty: "RSA"; n: string };

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function getArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);

  return copy.buffer;
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid encrypted data encoding");
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid encrypted data encoding");
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicKeyParameter(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1) {
    return false;
  }

  try {
    const decoded = base64UrlDecode(value);

    return (
      decoded.length > 0 &&
      (expectedBytes === undefined || decoded.length === expectedBytes) &&
      base64UrlEncode(decoded) === value
    );
  } catch {
    return false;
  }
}

function publicJwkEcCurve(
  curve: unknown,
): { coordinateBytes: number; name: "P-256" | "P-384" | "P-521" } | undefined {
  if (curve === "P-256") {
    return { coordinateBytes: 32, name: curve };
  }
  if (curve === "P-384") {
    return { coordinateBytes: 48, name: curve };
  }
  if (curve === "P-521") {
    return { coordinateBytes: 66, name: curve };
  }

  return undefined;
}

export function decodePublicJwk(value: unknown): PublicJwk {
  if (!isRecord(value)) {
    throw new Error("Public key claim must contain a public JWK");
  }

  if (value.kty === "EC") {
    const curve = publicJwkEcCurve(value.crv);
    if (
      !curve ||
      !publicKeyParameter(value.x, curve.coordinateBytes) ||
      !publicKeyParameter(value.y, curve.coordinateBytes)
    ) {
      throw new Error("Public key claim contains an invalid EC public JWK");
    }

    return { crv: curve.name, kty: "EC", x: value.x, y: value.y };
  }

  if (value.kty === "OKP") {
    if (value.crv !== "Ed25519" || !publicKeyParameter(value.x, 32)) {
      throw new Error("Public key claim contains an invalid OKP public JWK");
    }

    return { crv: value.crv, kty: "OKP", x: value.x };
  }

  if (value.kty === "RSA") {
    if (!publicKeyParameter(value.n) || !publicKeyParameter(value.e)) {
      throw new Error("Public key claim contains an invalid RSA public JWK");
    }

    return { e: value.e, kty: "RSA", n: value.n };
  }

  throw new Error("Public key claim contains an unsupported public JWK");
}

export function boundedString(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${name} must contain ${minimum} to ${maximum} characters`);
  }

  return value;
}

export function concatenateBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }

  return result;
}

export function uint32BigEndian(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

export function hexEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function responseError(body: unknown, fallback: string): Error {
  if (!isRecord(body)) {
    return new Error(fallback);
  }

  const message = body.error_description ?? body.message ?? body.error;

  return new Error(typeof message === "string" ? message : fallback);
}

export async function jsonResponse<Value>(
  response: Response,
  fallback: string,
  decode: (value: unknown) => Value,
): Promise<Value> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || body === undefined) {
    throw responseError(body, fallback);
  }

  try {
    return decode(body);
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error(fallback);
  }
}

export function isoDate(value: string | number | null | undefined, fallback: string): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const milliseconds = typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}
