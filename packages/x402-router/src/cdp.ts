import { CDP_FACILITATOR_URL, CDP_FORWARD_TOKEN_HEADER } from "./defaults";

export type CdpX402Endpoint = "verify" | "settle" | "supported";

export type CdpRequestTarget = {
  requestHost: string;
  requestMethod: "GET" | "POST";
  requestPath: string;
};

export type GenerateCdpJwtOptions = {
  apiKeyId: string;
  apiKeySecret: string;
  endpoint: CdpX402Endpoint;
  expiresIn?: number;
  facilitatorUrl?: string;
};

export type CdpAuthHeaders = {
  bazaar?: Record<string, string>;
  settle: Record<string, string>;
  supported: Record<string, string>;
  verify: Record<string, string>;
};

export type CreateCdpAuthHeadersOptions = Omit<GenerateCdpJwtOptions, "endpoint"> & {
  forwardedHeader?: string;
  generateAuthorizationHeader?: (options: GenerateCdpJwtOptions) => Promise<string>;
  /** Headers for `/supported`. Defaults to a CDP token signed for `GET /supported`. */
  supported?: Record<string, string>;
};

export function cdpRequestTarget(
  endpoint: CdpX402Endpoint,
  facilitatorUrl = CDP_FACILITATOR_URL,
): CdpRequestTarget {
  const url = new URL(facilitatorUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;

  return {
    requestHost: url.host,
    requestMethod: endpoint === "supported" ? "GET" : "POST",
    requestPath: `${basePath}/${endpoint}`,
  };
}

export async function generateCdpJwt(options: GenerateCdpJwtOptions): Promise<string> {
  const { generateJwt } = await import("@coinbase/cdp-sdk/auth");
  const target = cdpRequestTarget(options.endpoint, options.facilitatorUrl);

  return generateJwt({
    apiKeyId: options.apiKeyId,
    apiKeySecret: options.apiKeySecret,
    expiresIn: options.expiresIn ?? 120,
    requestHost: target.requestHost,
    requestMethod: target.requestMethod,
    requestPath: target.requestPath,
  });
}

export async function generateCdpAuthorizationHeader(
  options: GenerateCdpJwtOptions,
): Promise<string> {
  return `Bearer ${await generateCdpJwt(options)}`;
}

/**
 * Builds `HTTPFacilitatorClient` auth headers for CDP. The `/supported` token lets the router
 * give this seller CDP's payment kinds, such as CDP's Solana fee payer.
 */
export async function createCdpAuthHeaders(
  options: CreateCdpAuthHeadersOptions,
): Promise<CdpAuthHeaders> {
  const forwardedHeader = options.forwardedHeader ?? CDP_FORWARD_TOKEN_HEADER;
  const generateAuthorizationHeader =
    options.generateAuthorizationHeader ?? generateCdpAuthorizationHeader;
  const token = async (endpoint: CdpX402Endpoint) => ({
    [forwardedHeader]: await generateAuthorizationHeader({ ...options, endpoint }),
  });

  return {
    settle: await token("settle"),
    supported: options.supported ?? (await token("supported")),
    verify: await token("verify"),
  };
}

export { CDP_FACILITATOR_URL } from "./defaults";
