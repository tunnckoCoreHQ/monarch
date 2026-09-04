import { base64UrlEncode, boundedString } from "../../utils";
import {
  evmChainId,
  walletAccountIndex,
  walletDerivationPath,
  walletProfile,
  type WalletProfileId,
} from "./profiles";

export const WALLET_REQUEST_TTL_MS = 5 * 60 * 1_000;
export const WALLET_REQUEST_BODY_LIMIT = 16 * 1_024;
export const WALLET_CAPABILITY_PROFILE = "evm" satisfies WalletProfileId;
export const WALLET_CAPABILITY_ACCOUNT_INDEX = 0;

export type WalletNamespace = "account" | "client" | "source";

export interface WalletAuthorizationInput {
  clientId: string;
  redirectUri: string;
  state: string;
  message: string;
  namespace: WalletNamespace;
  walletProfile: WalletProfileId;
  accountIndex: number;
  path: string;
  chainId?: number;
}

export interface WalletAuthorizationRequestBody {
  client_id?: unknown;
  redirect_uri?: unknown;
  state?: unknown;
  message?: unknown;
  namespace?: unknown;
  wallet_profile?: unknown;
  account_index?: unknown;
  chain_id?: unknown;
  path?: unknown;
}

interface WalletMessageInput {
  origin: string;
  clientId: string;
  requestId: string;
  namespace: WalletNamespace;
  namespaceSubject: string;
  walletProfile: WalletProfileId;
  accountIndex: number;
  path: string;
  chainId?: number;
  message: string;
  issuedAt: string;
  expiresAt: string;
}

interface WalletCapabilityMessageInput {
  origin: string;
  accountSubject: string;
  credentialId: string;
  requestId: string;
  issuedAt: string;
  expiresAt: string;
}

export function parseWalletAuthorizationInput(
  body: WalletAuthorizationRequestBody,
): WalletAuthorizationInput {
  if (body.path !== undefined) {
    throw new Error("Client applications cannot supply a raw derivation path");
  }

  const clientId = boundedString(body.client_id, "Client ID", 1, 512);
  const redirectUri = boundedString(body.redirect_uri, "Redirect URI", 1, 2_048);
  const state = boundedString(body.state, "State", 16, 512);
  const message = boundedString(body.message, "Message", 1, 4_096);
  const namespace = body.namespace ?? "client";
  if (namespace !== "account" && namespace !== "client" && namespace !== "source") {
    throw new Error("Wallet namespace must be account, client, or source");
  }

  const profile = walletProfile(body.wallet_profile);
  const accountIndex = walletAccountIndex(body.account_index);
  const chainId = evmChainId(profile, body.chain_id);

  return {
    clientId,
    redirectUri,
    state,
    message,
    namespace,
    walletProfile: profile.id,
    accountIndex,
    path: walletDerivationPath(profile, accountIndex),
    ...(chainId ? { chainId } : {}),
  };
}

export function walletNamespaceSubject(
  namespace: WalletNamespace,
  subjects: { account: string; client: string; source: string },
): string {
  return subjects[namespace];
}

export async function walletPrfSalt(
  namespace: WalletNamespace,
  namespaceSubject: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new TextEncoder().encode(`triad-wallet-prf-v2\0${namespace}\0${namespaceSubject}`);
  const digest = await crypto.subtle.digest("SHA-256", input);

  return new Uint8Array(digest);
}

export async function walletPrfSaltBase64Url(
  namespace: WalletNamespace,
  namespaceSubject: string,
): Promise<string> {
  return base64UrlEncode(await walletPrfSalt(namespace, namespaceSubject));
}

export async function walletCapabilityPrfSaltBase64Url(
  accountSubject: string,
  credentialId: string,
): Promise<string> {
  const input = new TextEncoder().encode(
    `triad-wallet-capability-prf-v1\0${accountSubject}\0${credentialId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", input);

  return base64UrlEncode(new Uint8Array(digest));
}

export function walletCapabilitySigningMessage(input: WalletCapabilityMessageInput): string {
  return [
    "Triad Wallet Capability v1",
    JSON.stringify({
      origin: input.origin,
      account_subject: input.accountSubject,
      credential_id: input.credentialId,
      request_id: input.requestId,
      wallet_profile: WALLET_CAPABILITY_PROFILE,
      account_index: WALLET_CAPABILITY_ACCOUNT_INDEX,
      issued_at: input.issuedAt,
      expires_at: input.expiresAt,
    }),
  ].join("\n");
}

export function walletSigningMessage(input: WalletMessageInput): string {
  return [
    "Triad Wallet Authorization v2",
    JSON.stringify({
      origin: input.origin,
      client_id: input.clientId,
      request_id: input.requestId,
      namespace: input.namespace,
      namespace_subject: input.namespaceSubject,
      wallet_profile: input.walletProfile,
      account_index: input.accountIndex,
      derivation_path: input.path,
      ...(input.chainId ? { chain_id: input.chainId } : {}),
      message: input.message,
      issued_at: input.issuedAt,
      expires_at: input.expiresAt,
    }),
  ].join("\n");
}

export function walletRedirectUri(
  redirectUri: string,
  result: {
    state: string;
    requestId: string;
    address: string;
    signature: string;
    namespace: WalletNamespace;
    namespaceSubject: string;
    walletProfile: WalletProfileId;
    accountIndex: number;
    path: string;
    chainId?: number;
    message: string;
    receipt: string;
  },
): string {
  const target = new URL(redirectUri);
  const fragment = new URLSearchParams({
    state: result.state,
    triad_request_id: result.requestId,
    triad_address: result.address,
    triad_signature: result.signature,
    triad_namespace: result.namespace,
    triad_namespace_subject: result.namespaceSubject,
    triad_wallet_profile: result.walletProfile,
    triad_account_index: String(result.accountIndex),
    triad_path: result.path,
    ...(result.chainId ? { triad_chain_id: String(result.chainId) } : {}),
    triad_message: base64UrlEncode(new TextEncoder().encode(result.message)),
    triad_receipt: result.receipt,
  });
  target.hash = fragment.toString();

  return target.href;
}

export function walletErrorRedirectUri(redirectUri: string, state: string, error: string): string {
  const target = new URL(redirectUri);
  target.hash = new URLSearchParams({ state, error }).toString();

  return target.href;
}
