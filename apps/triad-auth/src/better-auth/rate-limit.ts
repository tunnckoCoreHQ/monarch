import type { BetterAuthOptions } from "better-auth";

import { hexEncode } from "../utils";

const RATE_LIMIT_CONTEXT = "triad-rate-limit:v1\0";
export const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_SECONDS * 1_000;
const CLEANUP_BATCH_SIZE = 100;

const CONSUME_BUCKET_SQL = `
  insert into "rateLimit" ("id", "key", "count", "lastRequest")
  values (?1, ?1, 1, ?2)
  on conflict do update set
    "count" = case
      when ?2 - "lastRequest" >= ?3 then 1
      else "count" + 1
    end,
    "lastRequest" = ?2
  where ?2 - "lastRequest" >= ?3 or "count" < ?4
  returning "count", "lastRequest"
`;

const CLEANUP_EXPIRED_BUCKETS_SQL = `
  delete from "rateLimit"
  where "id" in (
    select "id"
    from "rateLimit"
    where "lastRequest" < ?1
    order by "lastRequest"
    limit ?2
  )
`;

const READ_BUCKET_SQL = `
  select "count", "lastRequest"
  from "rateLimit"
  where "key" = ?1
`;

interface RateLimitRow {
  count: number;
  lastRequest: number;
}

type RateLimitStorage = NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]>;

export async function deriveRateLimitBucket(
  secret: string,
  betterAuthKey: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${RATE_LIMIT_CONTEXT}${betterAuthKey}`),
  );

  return hexEncode(digest);
}

function retryAfterSeconds(lastRequest: number, window: number, now: number): number {
  const remainingMilliseconds = lastRequest + window * 1_000 - now;

  return Math.max(1, Math.ceil(remainingMilliseconds / 1_000));
}

export function createD1RateLimitStorage(database: D1Database, secret: string): RateLimitStorage {
  return {
    async consume(betterAuthKey, rule) {
      const bucket = await deriveRateLimitBucket(secret, betterAuthKey);
      const now = Date.now();
      const windowMilliseconds = rule.window * 1_000;
      const cleanupCutoff = now - MAX_RATE_LIMIT_WINDOW_MS;

      const [consumeResult, _cleanupResult, storedBucketResult] =
        await database.batch<RateLimitRow>([
          database.prepare(CONSUME_BUCKET_SQL).bind(bucket, now, windowMilliseconds, rule.max),
          database.prepare(CLEANUP_EXPIRED_BUCKETS_SQL).bind(cleanupCutoff, CLEANUP_BATCH_SIZE),
          database.prepare(READ_BUCKET_SQL).bind(bucket),
        ]);
      const storedBucket = storedBucketResult.results[0];
      if (!storedBucket) {
        throw new Error("Rate-limit bucket disappeared during atomic consume");
      }
      if (consumeResult.results.length > 0) {
        return { allowed: true, retryAfter: null };
      }

      return {
        allowed: false,
        retryAfter: retryAfterSeconds(storedBucket.lastRequest, rule.window, now),
      };
    },
  };
}
