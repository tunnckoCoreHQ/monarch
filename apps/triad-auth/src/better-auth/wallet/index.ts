import {
  generateAuthenticationOptions,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { BetterAuthPlugin } from "better-auth";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { boundedString, concatenateBytes, hexEncode, isRecord } from "../../utils";
import { triadDatabase, type TriadDatabase } from "../database";
import {
  oauthClient,
  passkey as passkeyTable,
  user as userTable,
  walletCapabilityRequest as walletCapabilityRequestTable,
  walletRequest as walletRequestTable,
} from "../drizzle-schema";
import type { TriadEnv } from "../env";
import { isIdentityPasskey, storedPasskeyPublicKeyBytes } from "../identity/passkey-public-key";
import { isSocialProvider, pairwiseSubject } from "../identity/subjects";
import {
  derivedWalletAddressKey,
  openDerivedWalletAddresses,
  sealDerivedWalletAddresses,
  WALLET_CAPABILITY_ADDRESS_KEY,
} from "./addresses";
import type { WalletProfileId } from "./profiles";
import {
  parseWalletAuthorizationInput,
  WALLET_CAPABILITY_ACCOUNT_INDEX,
  WALLET_CAPABILITY_PROFILE,
  WALLET_REQUEST_BODY_LIMIT,
  WALLET_REQUEST_TTL_MS,
  type WalletAuthorizationInput,
  type WalletAuthorizationRequestBody,
  walletCapabilityPrfSaltBase64Url,
  walletCapabilitySigningMessage,
  walletErrorRedirectUri,
  walletNamespaceSubject,
  walletPrfSaltBase64Url,
  walletRedirectUri,
  walletSigningMessage,
} from "./protocol";
import { verifyPrfWalletSignature } from "./signatures";

const walletBrokerSchema = {
  walletRequest: {
    fields: {
      userId: {
        type: "string",
        required: true,
        references: { model: "user", field: "id", onDelete: "cascade" },
        index: true,
      },
      clientId: {
        type: "string",
        required: true,
        references: { model: "oauthClient", field: "clientId", onDelete: "cascade" },
        index: true,
      },
      credentialId: { type: "string", required: true },
      redirectUri: { type: "string", required: true },
      state: { type: "string", required: true },
      message: { type: "string", required: true },
      namespace: { type: "string", required: true },
      namespaceSubject: { type: "string", required: true },
      walletProfile: { type: "string", required: true },
      accountIndex: { type: "number", required: true },
      chainId: { type: "number", required: false },
      derivationPath: { type: "string", required: true },
      challenge: { type: "string", required: true },
      signingMessage: { type: "string", required: true },
      expiresAt: { type: "date", required: true, index: true },
      consumedAt: { type: "date", required: false },
      createdAt: { type: "date", required: true },
    },
  },
  walletCapabilityRequest: {
    fields: {
      userId: {
        type: "string",
        required: true,
        references: { model: "user", field: "id", onDelete: "cascade" },
        index: true,
      },
      credentialId: { type: "string", required: true },
      challenge: { type: "string", required: true },
      signingMessage: { type: "string", required: true },
      expiresAt: { type: "date", required: true, index: true },
      consumedAt: { type: "date", required: false },
      createdAt: { type: "date", required: true },
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

export const walletBrokerPlugin = {
  id: "wallet-broker",
  schema: walletBrokerSchema,
} satisfies BetterAuthPlugin;

interface WalletAuthService {
  api: {
    getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
    signJWT(input: { body: { payload: Record<string, unknown> } }): Promise<{ token: string }>;
  };
}

interface OAuthClientRecord {
  clientId: string;
  name: string | null;
  redirectUris: string;
}

interface IdentityRecord {
  id: string;
  provider: string;
  providerSub: string;
}

interface PasskeyRecord {
  id: string;
  name: string | null;
  credentialID: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  backedUp: boolean;
  createdAt: Date | null;
  walletCapable: boolean;
  encryptedData: string | null;
}

interface WalletContext {
  user: IdentityRecord;
  client: OAuthClientRecord;
  request: WalletAuthorizationInput;
  namespaceSubject: string;
  passkeys: PasskeyRecord[];
}

class WalletBrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalletBrokerError";
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

function invalid(message: string): never {
  throw new WalletBrokerError(400, "invalid_request", message);
}

function parseRedirectUris(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((uri) => typeof uri === "string")) {
      return parsed;
    }
  } catch {
    // Malformed client metadata does not authorize a redirect.
  }

  return [];
}

function webAuthnTransports(value: string | null): AuthenticatorTransport[] | undefined {
  if (!value) {
    return undefined;
  }
  const supported = new Set<string>(["ble", "hybrid", "internal", "nfc", "usb"]);
  const transports = value
    .split(",")
    .filter((transport): transport is AuthenticatorTransport => supported.has(transport));

  return transports.length > 0 ? transports : undefined;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) {
    invalid("A JSON request body is required");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > WALLET_REQUEST_BODY_LIMIT) {
    throw new WalletBrokerError(413, "request_too_large", "Wallet requests are limited to 16 KiB");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > WALLET_REQUEST_BODY_LIMIT) {
      await reader.cancel();
      throw new WalletBrokerError(
        413,
        "request_too_large",
        "Wallet requests are limited to 16 KiB",
      );
    }
    chunks.push(value);
  }

  const bytes = concatenateBytes(...chunks);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("Request body must be valid JSON");
  }
  if (!isRecord(parsed)) {
    invalid("Request body must be a JSON object");
  }

  return parsed;
}

const passkeyColumns = {
  id: passkeyTable.id,
  name: passkeyTable.name,
  credentialID: passkeyTable.credentialID,
  publicKey: passkeyTable.publicKey,
  counter: passkeyTable.counter,
  transports: passkeyTable.transports,
  backedUp: passkeyTable.backedUp,
  createdAt: passkeyTable.createdAt,
  walletCapable: passkeyTable.walletCapable,
  encryptedData: passkeyTable.encryptedData,
};

async function accountById(database: TriadDatabase, userId: string) {
  return database
    .select({ id: userTable.id, provider: userTable.provider, providerSub: userTable.providerSub })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .get();
}

async function passkeysByAccount(database: TriadDatabase, userId: string) {
  return database
    .select(passkeyColumns)
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId))
    .orderBy(asc(passkeyTable.createdAt));
}

async function passkeyById(database: TriadDatabase, userId: string, passkeyId: string) {
  return database
    .select(passkeyColumns)
    .from(passkeyTable)
    .where(and(eq(passkeyTable.id, passkeyId), eq(passkeyTable.userId, userId)))
    .get();
}

function requireSameOrigin(request: Request, env: TriadEnv): void {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(env.AUTH_ORIGIN).origin;
  } catch {
    throw new WalletBrokerError(500, "server_error", "Wallet broker origin is invalid");
  }
  if (request.headers.get("origin") !== expectedOrigin) {
    throw new WalletBrokerError(403, "forbidden", "Wallet requests require the Triad origin");
  }
}

async function authenticatedAccountId(
  request: Request,
  auth: WalletAuthService,
  message: string,
): Promise<string> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) {
    throw new WalletBrokerError(401, "authentication_required", message);
  }

  return session.user.id;
}

function walletPasskeys(user: IdentityRecord, passkeys: PasskeyRecord[]): PasskeyRecord[] {
  if (user.provider === "ethereum") {
    invalid("EVM Identity Sources do not provide Wallet Passkeys");
  }
  if (user.provider !== "passkey" && !isSocialProvider(user.provider)) {
    invalid("Identity Source does not support Wallet Passkeys");
  }

  return passkeys.filter((passkey) => passkey.walletCapable);
}

async function walletContext(
  body: WalletAuthorizationRequestBody,
  request: Request,
  env: TriadEnv,
  auth: WalletAuthService,
): Promise<WalletContext> {
  const accountId = await authenticatedAccountId(
    request,
    auth,
    "Sign in to authorize this wallet request",
  );

  let authorization: WalletAuthorizationInput;
  try {
    authorization = parseWalletAuthorizationInput(body);
  } catch (reason) {
    invalid(reason instanceof Error ? reason.message : "Wallet authorization request is invalid");
  }

  const database = triadDatabase(env.DB);
  const [user, client, passkeys] = await Promise.all([
    accountById(database, accountId),
    database
      .select({
        clientId: oauthClient.clientId,
        name: oauthClient.name,
        redirectUris: oauthClient.redirectUris,
      })
      .from(oauthClient)
      .where(
        and(
          eq(oauthClient.clientId, authorization.clientId),
          or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)),
        ),
      )
      .get(),
    passkeysByAccount(database, accountId),
  ]);
  if (!user) {
    throw new WalletBrokerError(401, "authentication_required", "Triad account is unavailable");
  }
  if (!client || !parseRedirectUris(client.redirectUris).includes(authorization.redirectUri)) {
    invalid("Client ID and redirect URI do not match a registered application");
  }

  const clientSubject = await pairwiseSubject(env.IDENTIFIER_SECRET, user.id, client.clientId);
  const namespaceSubject = walletNamespaceSubject(authorization.namespace, {
    account: user.id,
    client: clientSubject,
    source: user.providerSub,
  });

  return {
    user,
    client,
    request: authorization,
    namespaceSubject,
    passkeys: walletPasskeys(user, passkeys),
  };
}

function publicContext(context: WalletContext) {
  return {
    client: {
      id: context.client.clientId,
      name: context.client.name?.trim() || context.client.clientId,
    },
    request: {
      message: context.request.message,
      namespace: context.request.namespace,
      namespace_subject: context.namespaceSubject,
      wallet_profile: context.request.walletProfile,
      account_index: context.request.accountIndex,
      derivation_path: context.request.path,
      ...(context.request.chainId ? { chain_id: context.request.chainId } : {}),
    },
    identity_source: context.user.provider,
    cancel_uri: walletErrorRedirectUri(
      context.request.redirectUri,
      context.request.state,
      "access_denied",
    ),
    passkeys: context.passkeys.map((passkey) => ({
      id: passkey.id,
      name: passkey.name?.trim() || "Unnamed passkey",
      backed_up: passkey.backedUp,
      created_at: passkey.createdAt?.getTime() ?? null,
    })),
  };
}

async function inspectWalletRequest(request: Request, env: TriadEnv, auth: WalletAuthService) {
  const body = await readBoundedJson(request);
  const context = await walletContext(body, request, env, auth);

  return json(publicContext(context));
}

async function inspectAccountPasskeys(request: Request, env: TriadEnv, auth: WalletAuthService) {
  await readBoundedJson(request);
  const accountId = await authenticatedAccountId(request, auth, "Sign in to manage passkeys");

  const database = triadDatabase(env.DB);
  const [user, storedPasskeys] = await Promise.all([
    accountById(database, accountId),
    passkeysByAccount(database, accountId),
  ]);
  if (!user) {
    throw new WalletBrokerError(401, "authentication_required", "Triad account is unavailable");
  }

  const passkeys = await Promise.all(
    storedPasskeys.map(async (passkey) => {
      const identity =
        user.provider === "passkey" &&
        (await isIdentityPasskey(env.IDENTIFIER_SECRET, user.providerSub, passkey.publicKey));
      return {
        id: passkey.id,
        name: passkey.name,
        backedUp: passkey.backedUp,
        createdAt: passkey.createdAt?.getTime() ?? null,
        role: identity ? "identity" : "attached",
        walletCapable: passkey.walletCapable,
        removable: !identity,
      };
    }),
  );

  return json(passkeys);
}

async function createWalletRequest(request: Request, env: TriadEnv, auth: WalletAuthService) {
  const body = await readBoundedJson(request);
  const context = await walletContext(body, request, env, auth);
  const credentialId = body.credential_id;
  if (typeof credentialId !== "string") {
    invalid("Select a Wallet Passkey");
  }
  const passkey = context.passkeys.find((candidate) => candidate.id === credentialId);
  if (!passkey) {
    invalid("Selected passkey cannot supply a wallet seed for this Identity Source");
  }

  const database = triadDatabase(env.DB);
  const now = Date.now();
  await database.delete(walletRequestTable).where(lte(walletRequestTable.expiresAt, new Date(now)));
  const pending = await database.$count(
    walletRequestTable,
    and(
      eq(walletRequestTable.userId, context.user.id),
      isNull(walletRequestTable.consumedAt),
      gt(walletRequestTable.expiresAt, new Date(now)),
    ),
  );
  if (pending >= 10) {
    throw new WalletBrokerError(
      429,
      "too_many_requests",
      "Complete an existing wallet request before starting another",
    );
  }

  const origin = new URL(env.AUTH_ORIGIN);
  const options = await generateAuthenticationOptions({
    rpID: origin.hostname,
    userVerification: "required",
    allowCredentials: [
      { id: passkey.credentialID, transports: webAuthnTransports(passkey.transports) },
    ],
  });
  const requestId = crypto.randomUUID();
  const issuedAt = new Date(now);
  const expiresAt = new Date(now + WALLET_REQUEST_TTL_MS);
  const signingMessage = walletSigningMessage({
    origin: origin.origin,
    clientId: context.client.clientId,
    requestId,
    namespace: context.request.namespace,
    namespaceSubject: context.namespaceSubject,
    walletProfile: context.request.walletProfile,
    accountIndex: context.request.accountIndex,
    path: context.request.path,
    ...(context.request.chainId ? { chainId: context.request.chainId } : {}),
    message: context.request.message,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  await database.insert(walletRequestTable).values({
    id: requestId,
    userId: context.user.id,
    clientId: context.client.clientId,
    credentialId: passkey.id,
    redirectUri: context.request.redirectUri,
    state: context.request.state,
    message: context.request.message,
    namespace: context.request.namespace,
    namespaceSubject: context.namespaceSubject,
    walletProfile: context.request.walletProfile,
    accountIndex: context.request.accountIndex,
    chainId: context.request.chainId ?? null,
    derivationPath: context.request.path,
    challenge: options.challenge,
    signingMessage,
    expiresAt,
    consumedAt: null,
    createdAt: issuedAt,
  });

  return json({
    request_id: requestId,
    options,
    prf_salt: await walletPrfSaltBase64Url(context.request.namespace, context.namespaceSubject),
    signing_message: signingMessage,
    expires_at: expiresAt.toISOString(),
  });
}

async function createWalletCapabilityRequest(
  request: Request,
  env: TriadEnv,
  auth: WalletAuthService,
) {
  const accountId = await authenticatedAccountId(request, auth, "Sign in to manage passkeys");
  const body = await readBoundedJson(request);
  const credentialId = body.credential_id;
  if (typeof credentialId !== "string") {
    invalid("Select a Passkey");
  }

  const database = triadDatabase(env.DB);
  const [account, passkey] = await Promise.all([
    accountById(database, accountId),
    passkeyById(database, accountId, credentialId),
  ]);
  if (!account || account.provider === "ethereum") {
    invalid("This Identity Source cannot use Wallet Passkeys");
  }
  if (account.provider !== "passkey" && !isSocialProvider(account.provider)) {
    invalid("Identity Source does not support Wallet Passkeys");
  }
  if (!passkey) {
    invalid("Selected Passkey does not belong to this Triad Account");
  }
  if (passkey.walletCapable) {
    invalid("Selected Passkey already has Wallet Capability");
  }

  const now = Date.now();
  await database
    .delete(walletCapabilityRequestTable)
    .where(lte(walletCapabilityRequestTable.expiresAt, new Date(now)));
  const pending = await database.$count(
    walletCapabilityRequestTable,
    and(
      eq(walletCapabilityRequestTable.userId, accountId),
      isNull(walletCapabilityRequestTable.consumedAt),
      gt(walletCapabilityRequestTable.expiresAt, new Date(now)),
    ),
  );
  if (pending >= 10) {
    throw new WalletBrokerError(
      429,
      "too_many_requests",
      "Complete an existing Wallet Capability request before starting another",
    );
  }

  const origin = new URL(env.AUTH_ORIGIN);
  const options = await generateAuthenticationOptions({
    rpID: origin.hostname,
    userVerification: "required",
    allowCredentials: [
      { id: passkey.credentialID, transports: webAuthnTransports(passkey.transports) },
    ],
  });
  const requestId = crypto.randomUUID();
  const issuedAt = new Date(now);
  const expiresAt = new Date(now + WALLET_REQUEST_TTL_MS);
  const signingMessage = walletCapabilitySigningMessage({
    origin: origin.origin,
    accountSubject: accountId,
    credentialId: passkey.id,
    requestId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  await database.insert(walletCapabilityRequestTable).values({
    id: requestId,
    userId: accountId,
    credentialId: passkey.id,
    challenge: options.challenge,
    signingMessage,
    expiresAt,
    consumedAt: null,
    createdAt: issuedAt,
  });

  return json({
    request_id: requestId,
    options,
    prf_salt: await walletCapabilityPrfSaltBase64Url(accountId, passkey.id),
    signing_message: signingMessage,
    wallet_profile: WALLET_CAPABILITY_PROFILE,
    account_index: WALLET_CAPABILITY_ACCOUNT_INDEX,
    expires_at: expiresAt.toISOString(),
  });
}

function authenticationResponse(value: unknown): AuthenticationResponseJSON {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.rawId !== "string" ||
    value.type !== "public-key" ||
    !isRecord(value.response) ||
    typeof value.response.clientDataJSON !== "string" ||
    typeof value.response.authenticatorData !== "string" ||
    typeof value.response.signature !== "string" ||
    !isRecord(value.clientExtensionResults)
  ) {
    invalid("Passkey assertion is required");
  }

  // SAFETY: The required fields are checked above; WebAuthn verification checks the assertion.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- TypeScript does not retain these field checks on Record<string, unknown>.
  return value as unknown as AuthenticationResponseJSON;
}

function walletString(value: unknown, name: string, maximum: number): string {
  try {
    return boundedString(value, name, 1, maximum);
  } catch {
    invalid(`${name} is invalid`);
  }
}

async function verifyStoredPasskeyAssertion(
  env: TriadEnv,
  passkey: PasskeyRecord,
  response: AuthenticationResponseJSON,
  challenge: string,
): Promise<number> {
  let verification;
  try {
    const origin = new URL(env.AUTH_ORIGIN);
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin.origin,
      expectedRPID: origin.hostname,
      credential: {
        id: passkey.credentialID,
        publicKey: storedPasskeyPublicKeyBytes(passkey.publicKey),
        counter: passkey.counter,
        transports: webAuthnTransports(passkey.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    invalid("Triad rejected the passkey assertion");
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    invalid("Wallet authorization requires passkey user verification");
  }

  return verification.authenticationInfo.newCounter;
}

async function walletReceiptDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  return hexEncode(digest);
}

async function completeWalletRequest(request: Request, env: TriadEnv, auth: WalletAuthService) {
  const accountId = await authenticatedAccountId(
    request,
    auth,
    "Sign in to authorize this wallet request",
  );

  const body = await readBoundedJson(request);
  const requestId = body.request_id;
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/.test(requestId)) {
    invalid("Wallet request ID is invalid");
  }
  const address = walletString(body.address, "Derived wallet address", 128);
  const signature = walletString(body.signature, "Wallet signature", 2_048);
  const response = authenticationResponse(body.response);

  const database = triadDatabase(env.DB);
  const walletRequest = await database
    .select({
      id: walletRequestTable.id,
      clientId: walletRequestTable.clientId,
      credentialId: walletRequestTable.credentialId,
      redirectUri: walletRequestTable.redirectUri,
      state: walletRequestTable.state,
      namespace: sql<WalletAuthorizationInput["namespace"]>`${walletRequestTable.namespace}`,
      namespaceSubject: walletRequestTable.namespaceSubject,
      walletProfile: sql<WalletProfileId>`${walletRequestTable.walletProfile}`,
      accountIndex: walletRequestTable.accountIndex,
      chainId: walletRequestTable.chainId,
      derivationPath: walletRequestTable.derivationPath,
      challenge: walletRequestTable.challenge,
      signingMessage: walletRequestTable.signingMessage,
      expiresAt: walletRequestTable.expiresAt,
      consumedAt: walletRequestTable.consumedAt,
    })
    .from(walletRequestTable)
    .where(and(eq(walletRequestTable.id, requestId), eq(walletRequestTable.userId, accountId)))
    .get();
  if (
    !walletRequest ||
    walletRequest.consumedAt !== null ||
    walletRequest.expiresAt.getTime() <= Date.now()
  ) {
    invalid("Wallet request is missing, expired, or already used");
  }

  const passkey = await passkeyById(database, accountId, walletRequest.credentialId);
  if (!passkey || !passkey.walletCapable || response.id !== passkey.credentialID) {
    invalid("Wallet request passkey does not match the assertion");
  }

  // Claim the challenge before expensive cryptographic work so every request has one attempt.
  const consumedAt = new Date();
  const consumed = await database
    .update(walletRequestTable)
    .set({ consumedAt })
    .where(
      and(
        eq(walletRequestTable.id, requestId),
        eq(walletRequestTable.userId, accountId),
        isNull(walletRequestTable.consumedAt),
        gt(walletRequestTable.expiresAt, consumedAt),
      ),
    );
  if (consumed.meta.changes !== 1) {
    invalid("Wallet request is missing, expired, or already used");
  }

  const newCounter = await verifyStoredPasskeyAssertion(
    env,
    passkey,
    response,
    walletRequest.challenge,
  );

  if (
    !(await verifyPrfWalletSignature(
      walletRequest.walletProfile,
      address,
      signature,
      walletRequest.signingMessage,
    ))
  ) {
    invalid("Derived wallet signature does not match this request");
  }

  const addresses = await openDerivedWalletAddresses(
    env.ENCRYPTION_SECRETS,
    accountId,
    passkey.id,
    passkey.encryptedData,
  );
  const addressKey = derivedWalletAddressKey(walletRequest);
  const recordedAddress = addresses[addressKey];
  if (recordedAddress !== undefined && recordedAddress !== address) {
    invalid("Derived wallet address does not match the recorded address for this wallet");
  }

  // Resealing on every completion also moves the record to the active encryption secret.
  const envelope = await sealDerivedWalletAddresses(env.ENCRYPTION_SECRETS, accountId, passkey.id, {
    ...addresses,
    [addressKey]: address,
  });
  await database
    .update(passkeyTable)
    .set({ counter: newCounter, encryptedData: envelope })
    .where(and(eq(passkeyTable.id, passkey.id), eq(passkeyTable.userId, accountId)));

  const pairwiseSub = await pairwiseSubject(
    env.IDENTIFIER_SECRET,
    accountId,
    walletRequest.clientId,
  );
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const { token: receipt } = await auth.api.signJWT({
    body: {
      payload: {
        sub: pairwiseSub,
        aud: walletRequest.clientId,
        jti: walletRequest.id,
        iat: nowSeconds,
        exp: nowSeconds + 5 * 60,
        triad_wallet_authorization: {
          request_id: walletRequest.id,
          address,
          signing_envelope_sha256: await walletReceiptDigest(walletRequest.signingMessage),
          wallet_signature_sha256: await walletReceiptDigest(signature),
          namespace: walletRequest.namespace,
          namespace_subject: walletRequest.namespaceSubject,
          wallet_profile: walletRequest.walletProfile,
          account_index: walletRequest.accountIndex,
          derivation_path: walletRequest.derivationPath,
          ...(walletRequest.chainId ? { chain_id: walletRequest.chainId } : {}),
        },
      },
    },
  });

  return json({
    redirect_uri: walletRedirectUri(walletRequest.redirectUri, {
      state: walletRequest.state,
      requestId: walletRequest.id,
      address,
      signature,
      namespace: walletRequest.namespace,
      namespaceSubject: walletRequest.namespaceSubject,
      walletProfile: walletRequest.walletProfile,
      accountIndex: walletRequest.accountIndex,
      path: walletRequest.derivationPath,
      ...(walletRequest.chainId ? { chainId: walletRequest.chainId } : {}),
      message: walletRequest.signingMessage,
      receipt,
    }),
  });
}

async function completeWalletCapabilityRequest(
  request: Request,
  env: TriadEnv,
  auth: WalletAuthService,
) {
  const accountId = await authenticatedAccountId(request, auth, "Sign in to manage passkeys");
  const body = await readBoundedJson(request);
  const requestId = body.request_id;
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/.test(requestId)) {
    invalid("Wallet Capability request ID is invalid");
  }
  const address = walletString(body.address, "Derived wallet address", 128);
  const signature = walletString(body.signature, "Wallet signature", 2_048);
  const response = authenticationResponse(body.response);

  const database = triadDatabase(env.DB);
  const capabilityRequest = await database
    .select({
      credentialId: walletCapabilityRequestTable.credentialId,
      challenge: walletCapabilityRequestTable.challenge,
      signingMessage: walletCapabilityRequestTable.signingMessage,
      expiresAt: walletCapabilityRequestTable.expiresAt,
      consumedAt: walletCapabilityRequestTable.consumedAt,
    })
    .from(walletCapabilityRequestTable)
    .where(
      and(
        eq(walletCapabilityRequestTable.id, requestId),
        eq(walletCapabilityRequestTable.userId, accountId),
      ),
    )
    .get();
  if (
    !capabilityRequest ||
    capabilityRequest.consumedAt !== null ||
    capabilityRequest.expiresAt.getTime() <= Date.now()
  ) {
    invalid("Wallet Capability request is missing, expired, or already used");
  }

  const passkey = await passkeyById(database, accountId, capabilityRequest.credentialId);
  if (!passkey || response.id !== passkey.credentialID) {
    invalid("Wallet Capability Passkey does not match the assertion");
  }

  // Claim the challenge before expensive cryptographic work so every request has one attempt.
  const consumedAt = new Date();
  const consumed = await database
    .update(walletCapabilityRequestTable)
    .set({ consumedAt })
    .where(
      and(
        eq(walletCapabilityRequestTable.id, requestId),
        eq(walletCapabilityRequestTable.userId, accountId),
        isNull(walletCapabilityRequestTable.consumedAt),
        gt(walletCapabilityRequestTable.expiresAt, consumedAt),
      ),
    );
  if (consumed.meta.changes !== 1) {
    invalid("Wallet Capability request is missing, expired, or already used");
  }

  const newCounter = await verifyStoredPasskeyAssertion(
    env,
    passkey,
    response,
    capabilityRequest.challenge,
  );
  if (
    !(await verifyPrfWalletSignature(
      WALLET_CAPABILITY_PROFILE,
      address,
      signature,
      capabilityRequest.signingMessage,
    ))
  ) {
    invalid("Derived wallet signature does not prove Wallet Capability");
  }

  const addresses = await openDerivedWalletAddresses(
    env.ENCRYPTION_SECRETS,
    accountId,
    passkey.id,
    passkey.encryptedData,
  );
  const recordedAddress = addresses[WALLET_CAPABILITY_ADDRESS_KEY];
  if (recordedAddress !== undefined && recordedAddress !== address) {
    invalid("Derived wallet address does not match the recorded Wallet Capability proof");
  }

  const envelope = await sealDerivedWalletAddresses(env.ENCRYPTION_SECRETS, accountId, passkey.id, {
    ...addresses,
    [WALLET_CAPABILITY_ADDRESS_KEY]: address,
  });
  const updated = await database
    .update(passkeyTable)
    .set({ counter: newCounter, walletCapable: true, encryptedData: envelope })
    .where(and(eq(passkeyTable.id, passkey.id), eq(passkeyTable.userId, accountId)));
  if (updated.meta.changes !== 1) {
    invalid("Wallet Capability Passkey is no longer available");
  }

  return json({ wallet_capable: true });
}

export async function handleWalletBrokerRequest(
  request: Request,
  env: TriadEnv,
  auth: WalletAuthService,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  try {
    requireSameOrigin(request, env);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/wallet/passkeys") {
      return await inspectAccountPasskeys(request, env, auth);
    }
    if (pathname === "/api/wallet/capability/options") {
      return await createWalletCapabilityRequest(request, env, auth);
    }
    if (pathname === "/api/wallet/capability/complete") {
      return await completeWalletCapabilityRequest(request, env, auth);
    }
    if (pathname === "/api/wallet/inspect") {
      return await inspectWalletRequest(request, env, auth);
    }
    if (pathname === "/api/wallet/options") {
      return await createWalletRequest(request, env, auth);
    }
    if (pathname === "/api/wallet/complete") {
      return await completeWalletRequest(request, env, auth);
    }

    return json({ error: "not_found" }, 404);
  } catch (reason) {
    if (reason instanceof WalletBrokerError) {
      return json({ error: reason.code, message: reason.message }, reason.status);
    }

    return json(
      { error: "server_error", message: "Triad could not process the wallet request" },
      500,
    );
  }
}

export {
  parseWalletAuthorizationInput,
  WALLET_CAPABILITY_ACCOUNT_INDEX,
  WALLET_CAPABILITY_PROFILE,
  type WalletAuthorizationInput,
  type WalletNamespace,
  walletCapabilityPrfSaltBase64Url,
  walletCapabilitySigningMessage,
  walletPrfSalt,
  walletRedirectUri,
  walletSigningMessage,
} from "./protocol";
export {
  derivedWalletAddressKey,
  openDerivedWalletAddresses,
  sealDerivedWalletAddresses,
  WALLET_CAPABILITY_ADDRESS_KEY,
} from "./addresses";
export {
  WALLET_PROFILE_IDS,
  type WalletProfileId,
  walletAccountIndex,
  walletDerivationPath,
  walletProfile,
} from "./profiles";
export { signPrfWallet, verifyPrfWalletSignature } from "./signatures";
