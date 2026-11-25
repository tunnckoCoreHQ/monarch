import { type CreateCdpAuthHeadersOptions, createCdpAuthHeaders } from "./cdp";
import { type CreatePayAIAuthHeadersOptions, createPayAIAuthHeaders } from "./payai";
import { routerPreferenceHeaders, type X402RouterPreference } from "./preference";

/** A provider counts only with both parts of its key, so a missing env var leaves it out. */
function hasKey<T extends { apiKeyId?: string; apiKeySecret?: string }>(
  key: T | undefined,
): key is T & { apiKeyId: string; apiKeySecret: string } {
  return Boolean(key?.apiKeyId && key.apiKeySecret);
}
export type RouterAuthHeaders = {
  settle: Record<string, string>;
  supported: Record<string, string>;
  verify: Record<string, string>;
};

export type CreateRouterAuthHeadersOptions = {
  /** Left out when `apiKeyId` or `apiKeySecret` is empty. */
  cdp?: Partial<CreateCdpAuthHeadersOptions>;
  /** Left out when `apiKeyId` or `apiKeySecret` is empty. */
  payai?: Partial<CreatePayAIAuthHeadersOptions>;
  preference?: X402RouterPreference;
};

/**
 * Builds every router header for `HTTPFacilitatorClient`: the CDP token, the PayAI token, and
 * the seller's upstream preference. Keys stay on the seller; the router stores nothing.
 */
export async function createRouterAuthHeaders(
  options: CreateRouterAuthHeadersOptions,
): Promise<RouterAuthHeaders> {
  const parts = await Promise.all([
    hasKey(options.cdp) ? createCdpAuthHeaders(options.cdp) : undefined,
    hasKey(options.payai) ? createPayAIAuthHeaders(options.payai) : undefined,
  ]);
  const preference = options.preference ? routerPreferenceHeaders(options.preference) : {};
  const merge = (endpoint: keyof RouterAuthHeaders) =>
    Object.assign({}, preference, ...parts.map((part) => part?.[endpoint] ?? {}));

  return { settle: merge("settle"), supported: merge("supported"), verify: merge("verify") };
}
