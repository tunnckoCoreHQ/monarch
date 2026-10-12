import type { Env } from "./env";
import { base64url, fromBase64url, HttpError, now } from "./util";

const encoder = new TextEncoder();

// Wrapped repository keys are "v1", and new secret values are "v2". A "v1" secret value was sealed
// either with its repository key, before "v2" existed, or with the Worker-wide key that repository
// keys replaced, which no longer exists.
const WRAP_VERSION = "v1";
const SECRET_VERSION = "v2";

async function seal(
  key: CryptoKey,
  version: string,
  context: string,
  plain: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    plain,
  );
  return `${version}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

async function open(
  key: CryptoKey,
  context: string,
  sealed: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const [, iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode(context) },
    key,
    fromBase64url(data),
  );
  return new Uint8Array(plain);
}

function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

let master: Promise<CryptoKey> | undefined;

/** The master key from Secrets Store: 32 bytes, base64. It only wraps repository keys. */
function masterKey(env: Env): Promise<CryptoKey> {
  master ??= env.SECRETS_KEK.get()
    .then((value) => aesKey(Uint8Array.from(atob(value), (char) => char.charCodeAt(0))))
    .catch((error: unknown) => {
      // A failed read must not stick; the next request tries again.
      master = undefined;
      throw error;
    });
  return master;
}

/**
 * The repository's own AES-256 key. The first call makes one and stores it wrapped by the master
 * key, with the repository id as associated data, so a wrapped key cannot move to another repo.
 */
async function repoKey(env: Env, repoId: string): Promise<CryptoKey> {
  const select = env.DB.prepare("SELECT wrapped FROM repo_keys WHERE repo_id = ?").bind(repoId);
  let row = await select.first<{ wrapped: string }>();
  if (row === null) {
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await seal(await masterKey(env), WRAP_VERSION, `repo-key:${repoId}`, fresh);
    // Two first writes may race; the one that lands first wins and both read it back.
    await env.DB.prepare(
      "INSERT INTO repo_keys (repo_id, wrapped, created_at) VALUES (?, ?, ?) ON CONFLICT (repo_id) DO NOTHING",
    )
      .bind(repoId, wrapped, now())
      .run();
    row = await select.first<{ wrapped: string }>();
  }
  if (row === null) {
    throw new Error(`no key for repository ${repoId}`);
  }
  return aesKey(
    new Uint8Array(await open(await masterKey(env), `repo-key:${repoId}`, row.wrapped)),
  );
}

/** AES-256-GCM with the repository's key, and the environment and name as associated data. */
export async function sealSecret(
  env: Env,
  repoId: string,
  context: string,
  value: string,
): Promise<string> {
  return seal(await repoKey(env, repoId), SECRET_VERSION, context, encoder.encode(value));
}

export async function openSecret(
  env: Env,
  repoId: string,
  context: string,
  sealed: string,
): Promise<string> {
  const key = await repoKey(env, repoId);
  try {
    return new TextDecoder().decode(await open(key, context, sealed));
  } catch (error) {
    // A "v1" value the repository key cannot open was sealed with the retired Worker-wide key.
    const failed = error instanceof DOMException && error.name === "OperationError";
    if (failed && !sealed.startsWith(`${SECRET_VERSION}.`)) {
      const name = context.split(":").at(-1);
      throw new HttpError(
        409,
        `${name} was sealed with a retired key and cannot be opened; set it again`,
        "secret_retired",
      );
    }
    throw error;
  }
}
