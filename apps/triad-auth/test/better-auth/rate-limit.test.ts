import { describe, expect, it, vi } from "vite-plus/test";

import { createD1RateLimitStorage, deriveRateLimitBucket } from "../../src/better-auth/rate-limit";

const RATE_LIMIT_SECRET = "test-rate-limit-secret-with-enough-entropy-1234567890";

interface QueryCapture {
  bindings: unknown[][];
  queries: string[];
}

function d1Result<T>(results: T[]): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
  };
}

function createDatabase(batchResults: D1Result[], capture: QueryCapture): D1Database {
  return {
    prepare(query: string) {
      capture.queries.push(query);

      return {
        bind(...values: unknown[]) {
          capture.bindings.push(values);

          return this;
        },
      } as D1PreparedStatement;
    },
    async batch<T = unknown>(_statements: D1PreparedStatement[]) {
      return batchResults as D1Result<T>[];
    },
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    withSession() {
      throw new Error("D1 sessions are not used by rate-limit storage");
    },
    dump: vi.fn(async () => new ArrayBuffer(0)),
  };
}

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

  it("atomically consumes and binds no raw request metadata to D1", async () => {
    const now = 1_786_147_200_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const rawKey = "203.0.113.42|/sign-in/social";
    const bucket = await deriveRateLimitBucket(RATE_LIMIT_SECRET, rawKey);
    const capture: QueryCapture = { bindings: [], queries: [] };
    const database = createDatabase(
      [
        d1Result([{ count: 1, lastRequest: now }]),
        d1Result([]),
        d1Result([{ count: 1, lastRequest: now }]),
      ],
      capture,
    );
    const storage = createD1RateLimitStorage(database, RATE_LIMIT_SECRET);

    await expect(storage.consume(rawKey, { window: 60, max: 10 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(capture.queries[0]).toContain("on conflict do update");
    expect(capture.queries[0]).toContain('where ?2 - "lastRequest" >= ?3 or "count" < ?4');
    expect(capture.queries[0]).toContain('returning "count", "lastRequest"');
    expect(capture.queries[1]).toContain("limit ?2");
    expect(capture.bindings[0][0]).toBe(bucket);
    expect(JSON.stringify(capture.bindings)).not.toContain("203.0.113.42");
    expect(JSON.stringify(capture.bindings)).not.toContain("/sign-in/social");
  });

  it("returns a bounded retry interval without incrementing a full bucket", async () => {
    const now = 1_786_147_200_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const capture: QueryCapture = { bindings: [], queries: [] };
    const database = createDatabase(
      [d1Result([]), d1Result([]), d1Result([{ count: 10, lastRequest: now - 12_000 }])],
      capture,
    );
    const storage = createD1RateLimitStorage(database, RATE_LIMIT_SECRET);

    await expect(storage.consume("opaque-input", { window: 60, max: 10 })).resolves.toEqual({
      allowed: false,
      retryAfter: 48,
    });
  });
});
