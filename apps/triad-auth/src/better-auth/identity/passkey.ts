import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { toHex } from "viem";

import { base64UrlDecode, base64UrlEncode, isRecord } from "../../utils";
import type { TriadEnv } from "../env";
import {
  canonicalPasskeyUsername,
  createPasskeyUsernameGenerator,
  passkeyAccountSubject,
  passkeyDisplayName,
  type PasskeyUsernameGeneratorOptions,
} from "./passkey-username";
import { canonicalPasskeyPublicKey, isIdentityPasskey } from "./passkey-public-key";
import { sealProfileEncryptedData } from "./profile";
import { isSocialProvider, passkeyUpstreamId, providerSubject } from "./subjects";

const PASSKEY_ATTACHMENT_FRESHNESS_MS = 5 * 60 * 1_000;

const passkeyUsernameSchema = {
  passkeyUsername: {
    fields: {
      username: { type: "string", required: true, unique: true },
      accountSub: {
        type: "string",
        required: true,
        unique: true,
        references: { model: "user", field: "id" },
      },
      createdAt: { type: "date", required: true },
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

function rejectPasskey(message: string): never {
  throw new APIError("BAD_REQUEST", { message });
}

function sessionProvider(session: Awaited<ReturnType<typeof getSessionFromCtx>>): unknown {
  return session?.user.provider;
}

function validateAttachmentProvider(session: Awaited<ReturnType<typeof getSessionFromCtx>>): void {
  const provider = sessionProvider(session);
  if (provider === "ethereum") {
    rejectPasskey("EVM Identity Sources cannot attach passkeys");
  }
  if (provider !== "passkey" && !isSocialProvider(provider)) {
    rejectPasskey("Triad account identity source is invalid");
  }
}

async function requireFreshAttachmentSession(ctx: Parameters<typeof getSessionFromCtx>[0]) {
  const session = await getSessionFromCtx(ctx);
  if (!session) {
    return undefined;
  }

  const createdAt = new Date(session.session.createdAt).getTime();
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > PASSKEY_ATTACHMENT_FRESHNESS_MS) {
    rejectPasskey("Sign in again before attaching a passkey");
  }

  return session;
}

export function createPasskeyAuthentication(
  env: TriadEnv,
  usernameOptions: PasskeyUsernameGeneratorOptions = {},
) {
  const origin = new URL(env.AUTH_ORIGIN);
  // prf here is a provisioning hint, never a requirement: authenticators without
  // PRF ignore it, while hmac-secret must be enabled at creation time to allow
  // Wallet Capability later. Do not enforce PRF at registration.
  const registrationExtensions: AuthenticationExtensionsClientInputs = {
    credProps: true,
    prf: {},
  };
  const createUsername = createPasskeyUsernameGenerator(usernameOptions);

  const passkeyPlugin = passkey({
    rpID: origin.hostname,
    rpName: "Triad",
    origin: origin.origin,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    registration: {
      requireSession: false,
      resolveUser: async ({ ctx, context }) => {
        let username: string;
        try {
          username = createUsername(context ?? "");
        } catch (reason) {
          rejectPasskey(reason instanceof Error ? reason.message : "Passkey username is invalid");
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const existing = await ctx.context.adapter.findOne({
            model: "passkeyUsername",
            where: [{ field: "username", value: username }],
          });
          if (!existing) {
            const accountSub = await passkeyAccountSubject(username);

            return {
              id: accountSub,
              name: username,
              displayName: passkeyDisplayName(username),
            };
          }

          username = createUsername(context ?? "");
        }

        rejectPasskey("Triad could not create a unique passkey username; try again");
      },
      extensions: async ({ ctx }) => {
        await requireFreshAttachmentSession(ctx);

        return registrationExtensions;
      },
      afterVerification: async ({ ctx, verification, user: registrationUser }) => {
        if (!verification.registrationInfo?.userVerified) {
          rejectPasskey("Passkey registration requires user verification");
        }
        const session = await requireFreshAttachmentSession(ctx);
        if (session?.user.id) {
          validateAttachmentProvider(session);
          const credential = verification.registrationInfo.credential;

          const existingCredential = await ctx.context.adapter.findOne({
            model: "passkey",
            where: [{ field: "credentialID", value: credential.id }],
          });
          if (existingCredential) {
            rejectPasskey("This passkey is already registered");
          }

          return { userId: session.user.id };
        }

        const username = canonicalPasskeyUsername(registrationUser.name);
        const accountSub = await passkeyAccountSubject(username);
        if (registrationUser.id !== accountSub) {
          rejectPasskey("Passkey registration returned an invalid account identity");
        }

        const credential = verification.registrationInfo.credential;
        const canonicalPublicKey = canonicalPasskeyPublicKey(Uint8Array.from(credential.publicKey));
        const upstreamId = await passkeyUpstreamId(canonicalPublicKey);
        const providerSub = await providerSubject(env.IDENTIFIER_SECRET, "passkey", upstreamId);
        const [existingCredential, existingAccount, existingUsername] = await Promise.all([
          ctx.context.adapter.findOne({
            model: "passkey",
            where: [{ field: "credentialID", value: credential.id }],
          }),
          ctx.context.internalAdapter.findUserById(accountSub),
          ctx.context.adapter.findOne({
            model: "passkeyUsername",
            where: [{ field: "username", value: username }],
          }),
        ]);
        if (existingCredential || existingAccount || existingUsername) {
          rejectPasskey("This passkey is already registered; sign in with it instead");
        }

        const encryptedData = await sealProfileEncryptedData(env.ENCRYPTION_SECRETS, accountSub, {
          profileHandle: username,
        });
        if (!encryptedData) {
          rejectPasskey("Triad could not store the passkey username");
        }

        const createdUser = await ctx.context.internalAdapter.createUser(
          {
            id: providerSub,
            name: accountSub,
            email: `${accountSub}@identity.invalid`,
            emailVerified: false,
            image: "",
            provider: "passkey",
            providerSub,
            encryptedData,
          },
          { method: "passkey" },
        );

        try {
          await ctx.context.adapter.create({
            model: "passkeyUsername",
            data: { username, accountSub, createdAt: new Date() },
          });
        } catch {
          await ctx.context.internalAdapter.deleteUser(createdUser.id);
          rejectPasskey("Triad could not register this passkey username; try again");
        }

        return {
          userId: createdUser.id,
          name: registrationUser.displayName ?? passkeyDisplayName(username),
        };
      },
    },
    authentication: {
      afterVerification: async ({ ctx, verification, clientData }) => {
        if (!verification.authenticationInfo.userVerified) {
          rejectPasskey("Passkey authentication requires user verification");
        }

        const userHandle = clientData.response.userHandle;
        if (userHandle) {
          let accountSub: string;
          try {
            if (!/^[A-Za-z0-9_-]{43}$/.test(userHandle)) {
              throw new Error("Passkey user handle is invalid");
            }

            const userHandleBytes = base64UrlDecode(userHandle);
            if (userHandleBytes.length !== 32 || base64UrlEncode(userHandleBytes) !== userHandle) {
              throw new Error("Passkey user handle is invalid");
            }
            accountSub = `acc_${toHex(userHandleBytes).slice(2)}`;
          } catch (reason) {
            rejectPasskey(
              reason instanceof Error ? reason.message : "Passkey user handle is invalid",
            );
          }

          const storedPasskey = await ctx.context.adapter.findOne({
            model: "passkey",
            where: [{ field: "credentialID", value: clientData.id }],
          });
          const storedUserId = Reflect.get(storedPasskey ?? {}, "userId");
          if (typeof storedUserId !== "string" || storedUserId !== accountSub) {
            rejectPasskey("Passkey user handle does not match its Triad account");
          }
        }
      },
    },
  });

  return {
    ...passkeyPlugin,
    schema: {
      ...passkeyPlugin.schema,
      passkey: {
        ...passkeyPlugin.schema?.passkey,
        fields: {
          ...passkeyPlugin.schema?.passkey?.fields,
          walletCapable: { type: "boolean" as const, required: true, defaultValue: false },
          encryptedData: { type: "string" as const, required: false },
        },
      },
      ...passkeyUsernameSchema,
    },
    hooks: {
      before: [
        {
          matcher: (context: HookEndpointContext) => context.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (
              !session ||
              sessionProvider(session) !== "passkey" ||
              !isRecord(ctx.body) ||
              typeof ctx.body.id !== "string"
            ) {
              return;
            }

            const storedPasskey = await ctx.context.adapter.findOne({
              model: "passkey",
              where: [
                { field: "id", value: ctx.body.id },
                { field: "userId", value: session.user.id },
              ],
            });
            const publicKey = Reflect.get(storedPasskey ?? {}, "publicKey");
            const providerSub = Reflect.get(session.user, "providerSub");
            if (
              typeof publicKey === "string" &&
              typeof providerSub === "string" &&
              (await isIdentityPasskey(env.IDENTIFIER_SECRET, providerSub, publicKey))
            ) {
              rejectPasskey("The Identity Passkey cannot be removed");
            }
          }),
        },
      ],
    },
  };
}
