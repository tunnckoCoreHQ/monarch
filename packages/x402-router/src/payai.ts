import { PAYAI_FORWARD_TOKEN_HEADER } from "./defaults";

export type PayAIAuthHeaders = {
  settle: Record<string, string>;
  supported: Record<string, string>;
  verify: Record<string, string>;
};

export type CreatePayAIAuthHeadersOptions = {
  apiKeyId: string;
  /** An Ed25519 PKCS#8 key in base64, with or without the `payai_sk_` prefix. */
  apiKeySecret: string;
  /** Seconds until the JWT expires. PayAI recommends 120. */
  expiresIn?: number;
  forwardedHeader?: string;
};

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/, "");
}

function base64UrlJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function secretBytes(secret: string) {
  const base64 = secret.trim().replace(/^payai_sk_/, "");

  return Uint8Array.from(atob(base64.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.codePointAt(0)!,
  );
}

/** Signs a PayAI merchant JWT with Web Crypto, as PayAI's authentication docs describe. */
export async function generatePayAIJwt(
  options: Omit<CreatePayAIAuthHeadersOptions, "forwardedHeader">,
) {
  const now = Math.floor(Date.now() / 1000);
  const message = `${base64UrlJson({ alg: "EdDSA", kid: options.apiKeyId, typ: "JWT" })}.${base64UrlJson(
    {
      exp: now + (options.expiresIn ?? 120),
      iat: now,
      iss: "payai-merchant",
      jti: crypto.randomUUID(),
      sub: options.apiKeyId,
    },
  )}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    secretBytes(options.apiKeySecret),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message));

  return `${message}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * Builds `HTTPFacilitatorClient` auth headers for PayAI. Each endpoint gets its own JWT,
 * because PayAI rejects a reused `jti`. The router forwards the token only to PayAI.
 */
export async function createPayAIAuthHeaders(
  options: CreatePayAIAuthHeadersOptions,
): Promise<PayAIAuthHeaders> {
  const header = options.forwardedHeader ?? PAYAI_FORWARD_TOKEN_HEADER;
  const token = async () => ({ [header]: `Bearer ${await generatePayAIJwt(options)}` });

  return { settle: await token(), supported: await token(), verify: await token() };
}
