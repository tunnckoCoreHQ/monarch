import { betterAuth } from "better-auth";
import { describe, expect, it } from "vite-plus/test";

describe("Better Auth direct D1 runtime", () => {
  it("initializes from a D1 binding without an adapter", async () => {
    const statement = {
      bind: () => statement,
      all: async () => ({
        success: true,
        results: [],
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: 0,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      }),
    } as unknown as D1PreparedStatement;
    const database = {
      prepare: () => statement,
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
    } as unknown as D1Database;
    const auth = betterAuth({
      database,
      baseURL: "http://localhost",
      secret: "test-secret-that-is-at-least-32-characters",
    });

    const response = await auth.handler(new Request("http://localhost/api/auth/get-session"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toBeNull();
  });
});
