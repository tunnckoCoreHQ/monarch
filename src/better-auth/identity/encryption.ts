import { base64UrlDecode, base64UrlEncode, getArrayBuffer, isRecord } from "../../utils";

const ENVELOPE_VERSION = "v1";
const ENCRYPTION_CONTEXT = "triad-encrypted-data:v1";
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

interface ParsedEncryptionSecrets {
  active: string;
  secrets: Record<string, Uint8Array<ArrayBuffer>>;
}

function parseEncryptionSecrets(serialized: string): ParsedEncryptionSecrets {
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("ENCRYPTION_SECRETS must be a JSON secret set");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("ENCRYPTION_SECRETS must contain valid JSON");
  }

  if (!isRecord(parsed) || typeof parsed.active !== "string") {
    throw new Error("ENCRYPTION_SECRETS must define an active secret ID");
  }
  if (!SECRET_ID_PATTERN.test(parsed.active)) {
    throw new Error("ENCRYPTION_SECRETS contains an invalid active secret ID");
  }
  if (!isRecord(parsed.secrets)) {
    throw new Error("ENCRYPTION_SECRETS must define keyed secret material");
  }

  const secrets: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const [secretId, secret] of Object.entries(parsed.secrets)) {
    if (!SECRET_ID_PATTERN.test(secretId)) {
      throw new Error("ENCRYPTION_SECRETS contains an invalid secret ID");
    }
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw new Error("ENCRYPTION_SECRETS values must be canonical base64url for exactly 32 bytes");
    }

    const decoded = base64UrlDecode(secret);
    if (decoded.length !== 32 || base64UrlEncode(decoded) !== secret) {
      throw new Error("ENCRYPTION_SECRETS values must be canonical base64url for exactly 32 bytes");
    }
    secrets[secretId] = decoded;
  }

  if (Object.keys(secrets).length === 0 || !secrets[parsed.active]) {
    throw new Error("ENCRYPTION_SECRETS active secret is not configured");
  }

  return { active: parsed.active, secrets };
}

export function validateEncryptionSecrets(
  serialized: string,
  forbiddenSecrets: readonly string[] = [],
): void {
  const encryption = parseEncryptionSecrets(serialized);
  const encoder = new TextEncoder();
  const reusesForbiddenSecret = Object.values(encryption.secrets).some((secret) =>
    forbiddenSecrets.some((forbidden) => {
      const forbiddenBytes = encoder.encode(forbidden);

      return (
        forbiddenBytes.length === secret.length &&
        forbiddenBytes.every((byte, index) => byte === secret[index])
      );
    }),
  );
  if (reusesForbiddenSecret) {
    throw new Error("ENCRYPTION_SECRETS must not reuse an identity or Better Auth secret");
  }
}

function additionalData(secretId: string, context: string, binding: string): Uint8Array {
  return new TextEncoder().encode(`${ENVELOPE_VERSION}\0${secretId}\0${context}\0${binding}`);
}

function validateContext(context: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(context)) {
    throw new Error("Encrypted data requires a valid context");
  }
}

async function encryptionKey(
  secret: Uint8Array<ArrayBuffer>,
  secretId: string,
  context: string,
  binding: string,
  usages: KeyUsage[],
) {
  const material = await crypto.subtle.importKey("raw", secret, { name: "HKDF" }, false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(ENCRYPTION_CONTEXT),
      info: new TextEncoder().encode(`${ENCRYPTION_CONTEXT}\0${secretId}\0${context}\0${binding}`),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

export async function sealEncryptedData(
  serializedSecrets: string,
  context: string,
  binding: string,
  value: unknown,
): Promise<string> {
  validateContext(context);
  const encryption = parseEncryptionSecrets(serializedSecrets);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(
    encryption.secrets[encryption.active],
    encryption.active,
    context,
    binding,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: getArrayBuffer(iv),
      additionalData: getArrayBuffer(additionalData(encryption.active, context, binding)),
    },
    key,
    getArrayBuffer(new TextEncoder().encode(JSON.stringify(value))),
  );

  return [
    ENVELOPE_VERSION,
    encryption.active,
    base64UrlEncode(iv),
    base64UrlEncode(new Uint8Array(encrypted)),
  ].join(".");
}

export async function openEncryptedData(
  serializedSecrets: string,
  context: string,
  binding: string,
  envelope: string,
): Promise<unknown> {
  validateContext(context);
  const encryption = parseEncryptionSecrets(serializedSecrets);
  const [version, secretId, encodedIv, encodedCiphertext] = envelope.split(".");
  if (
    version !== ENVELOPE_VERSION ||
    !secretId ||
    !encodedIv ||
    !encodedCiphertext ||
    !SECRET_ID_PATTERN.test(secretId) ||
    !encryption.secrets[secretId]
  ) {
    throw new Error("Invalid encrypted data envelope");
  }

  const iv = base64UrlDecode(encodedIv);
  if (iv.length !== 12) {
    throw new Error("Invalid encrypted data envelope");
  }

  let decrypted: ArrayBuffer;
  try {
    const key = await encryptionKey(encryption.secrets[secretId], secretId, context, binding, [
      "decrypt",
    ]);
    decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: getArrayBuffer(iv),
        additionalData: getArrayBuffer(additionalData(secretId, context, binding)),
      },
      key,
      getArrayBuffer(base64UrlDecode(encodedCiphertext)),
    );
  } catch {
    throw new Error("Unable to decrypt encrypted data");
  }

  try {
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    throw new Error("Invalid encrypted data payload");
  }
}
