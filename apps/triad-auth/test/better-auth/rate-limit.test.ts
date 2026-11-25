import { describe, expect, it, vi } from "vitest";

import { rateLimit } from "../../src/better-auth/drizzle-schema";
import { createD1RateLimitStorage, deriveRateLimitBucket } from "../../src/better-auth/rate-limit";
import { createTestDatabase } from "../database";

const RATE_LIMIT_SECRET = "test-rate-limit-secret-with-enough-entropy-1234567890";

describe("private D1 rate-limit storage", () => {
  it("derives stable, domain-separated opaque buckets", async () => {
    const betterAuthKey = "203.0.113.42|/sign-in/social";
    const sameBucket = await Promise.all([
      deriveRateLimitBucket(RATE_LIMIT_SECRET, betterAuthKey),
      deriveRateLimitBucket(RATE_LIMIT_SECRET, betterAuthKey),
    ]);
    const changedBuckets = await Promise.all([
      deriveRateLimitBucket(RATE_LIMIT_SECRET, "203.0.113.43|/sign-in/social"),
      deriveRateLimitBucket(RATE_LIMIT_SECRET, "203.0.113.42|/device/code"),
      deriveRateLimitBucket("rotated-rate-limit-secret-with-enough-entropy-123456", betterAuthKey),
    ]);

    expect(sameBucket[0]).toBe(sameBucket[1]);
    expect(sameBucket[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([sameBucket[0], ...changedBuckets])).toHaveLength(4);
  });

  it("stores only the opaque bucket and counts each request", async () => {
    const now = 1_786_147_200_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { database } = await createTestDatabase();
    const rawKey = "203.0.113.42|/sign-in/social";
    const bucket = await deriveRateLimitBucket(RATE_LIMIT_SECRET, rawKey);
    const storage = createD1RateLimitStorage(database, RATE_LIMIT_SECRET);

    await expect(storage.consume(rawKey, { window: 60, max: 10 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    await expect(storage.consume(rawKey, { window: 60, max: 10 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });

    const rows = await database.select().from(rateLimit);
    expect(rows).toEqual([{ id: bucket, key: bucket, count: 2, lastRequest: now }]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.42");
    expect(JSON.stringify(rows)).not.toContain("/sign-in/social");
  });

  it("returns a bounded retry interval without incrementing a full bucket", async () => {
    const now = 1_786_147_200_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { database } = await createTestDatabase();
    const bucket = await deriveRateLimitBucket(RATE_LIMIT_SECRET, "opaque-input");
    await database
      .insert(rateLimit)
      .values({ id: bucket, key: bucket, count: 10, lastRequest: now - 12_000 });
    const storage = createD1RateLimitStorage(database, RATE_LIMIT_SECRET);

    await expect(storage.consume("opaque-input", { window: 60, max: 10 })).resolves.toEqual({
      allowed: false,
      retryAfter: 48,
    });
    await expect(database.select().from(rateLimit)).resolves.toEqual([
      { id: bucket, key: bucket, count: 10, lastRequest: now - 12_000 },
    ]);
  });

  it("starts a new window and removes expired buckets", async () => {
    const now = 1_786_147_200_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { database } = await createTestDatabase();
    const bucket = await deriveRateLimitBucket(RATE_LIMIT_SECRET, "opaque-input");
    await database.insert(rateLimit).values([
      { id: bucket, key: bucket, count: 10, lastRequest: now - 60_000 },
      { id: "expired", key: "expired", count: 3, lastRequest: now - 61_000 },
    ]);
    const storage = createD1RateLimitStorage(database, RATE_LIMIT_SECRET);

    await expect(storage.consume("opaque-input", { window: 60, max: 10 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    await expect(database.select().from(rateLimit)).resolves.toEqual([
      { id: bucket, key: bucket, count: 1, lastRequest: now },
    ]);
  });
});
