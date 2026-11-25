import type { BetterAuthOptions } from "better-auth";
import { eq, gte, inArray, lt, or, sql } from "drizzle-orm";

import { hexEncode } from "../utils";
import type { TriadDatabase } from "./database";
import { rateLimit } from "./drizzle-schema";

const RATE_LIMIT_CONTEXT = "triad-rate-limit:v1\0";
export const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_SECONDS * 1_000;
const CLEANUP_BATCH_SIZE = 100;

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

export function createD1RateLimitStorage(
  database: TriadDatabase,
  secret: string,
): RateLimitStorage {
  return {
    async consume(betterAuthKey, rule) {
      const bucket = await deriveRateLimitBucket(secret, betterAuthKey);
      const now = Date.now();
      const windowMilliseconds = rule.window * 1_000;
      const cleanupCutoff = now - MAX_RATE_LIMIT_WINDOW_MS;
      const windowElapsed = gte(sql`${now} - ${rateLimit.lastRequest}`, windowMilliseconds);
      const bucketColumns = { count: rateLimit.count, lastRequest: rateLimit.lastRequest };

      // One D1 batch runs as one transaction, so the consume step stays atomic.
      const [consumed, _cleanup, storedBuckets] = await database.batch([
        database
          .insert(rateLimit)
          .values({ id: bucket, key: bucket, count: 1, lastRequest: now })
          .onConflictDoUpdate({
            target: rateLimit.id,
            set: {
              count: sql`case when ${windowElapsed} then 1 else ${rateLimit.count} + 1 end`,
              lastRequest: now,
            },
            setWhere: or(windowElapsed, lt(rateLimit.count, rule.max)),
          })
          .returning(bucketColumns),
        database
          .delete(rateLimit)
          .where(
            inArray(
              rateLimit.id,
              database
                .select({ id: rateLimit.id })
                .from(rateLimit)
                .where(lt(rateLimit.lastRequest, cleanupCutoff))
                .orderBy(rateLimit.lastRequest)
                .limit(CLEANUP_BATCH_SIZE),
            ),
          ),
        database.select(bucketColumns).from(rateLimit).where(eq(rateLimit.key, bucket)),
      ]);
      const storedBucket = storedBuckets[0];
      if (!storedBucket) {
        throw new Error("Rate-limit bucket disappeared during atomic consume");
      }
      if (consumed.length > 0) {
        return { allowed: true, retryAfter: null };
      }

      return {
        allowed: false,
        retryAfter: retryAfterSeconds(storedBucket.lastRequest, rule.window, now),
      };
    },
  };
}
