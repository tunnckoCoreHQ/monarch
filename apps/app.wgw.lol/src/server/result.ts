import { GitError } from "../git/repo";

/** RPC drops custom error fields, so Durable Object methods return failures as values. */
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export async function guard<T>(run: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof GitError) {
      return { ok: false, status: error.status, error: error.message };
    }
    console.error(error);
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : "internal error",
    };
  }
}
