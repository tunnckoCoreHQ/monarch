import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const page = readFileSync(new URL("../../src/pages/device/verify.astro", import.meta.url), "utf8");

describe("Better Auth device verification page", () => {
  it("requires a Triad session and links signed-out users to account sign-in", () => {
    expect(page).toContain("/api/auth/get-session");
    expect(page).toContain('href="/me"');
    expect(page).toContain("A Triad session is required");
  });

  it("uses only Better Auth's stock verification and decision routes", () => {
    expect(page).toContain("/api/auth/device?user_code=");
    expect(page).toContain("/api/auth/device/approve");
    expect(page).toContain("/api/auth/device/deny");
    expect(page).toContain("JSON.stringify({ userCode: input.value })");
    expect(page).not.toMatch(/\/api\/device|action="\/device\/verify"/);
  });

  it("shows the exact requested disclosures before enabling approval", () => {
    expect(page).toContain('id="device-disclosures"');
    expect(page).toContain("/api/auth/device/disclosure?user_code=");
    expect(page).toContain("renderDisclosures(disclosures, disclosureBody.scopes)");
    expect(page).toMatch(/renderDisclosures[\s\S]+setDecisionAvailable\(true\)/);
  });

  it("labels both device authorization contracts", () => {
    expect(page).toContain("DEVICE AUTHORIZATION");
    expect(page).toContain("TRIAD SESSION");
    expect(page).toContain("OAUTH TOKENS");
    expect(page).toContain("registered OAuth client receives scoped OAuth tokens");
  });

  it("removes unsupported custom broker data and retains both decisions", () => {
    expect(page).toContain("APPROVE REQUEST");
    expect(page).toContain("DENY REQUEST");
    expect(page).not.toMatch(/csrf_token|device-provider/i);
  });
});
