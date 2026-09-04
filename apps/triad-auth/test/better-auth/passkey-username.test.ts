import { describe, expect, it } from "vite-plus/test";

import {
  canonicalPasskeyUsername,
  createPasskeyUsernameGenerator,
  normalizePasskeyUsername,
  passkeyAccountSubject,
  passkeyDisplayName,
  passkeyWebAuthnUserId,
} from "../../src/better-auth/identity/passkey-username";

describe("passkey usernames", () => {
  it("normalizes a base username and adds a six-character CUID2 suffix", () => {
    const createUsername = createPasskeyUsernameGenerator({ random: () => 0.5 });

    expect(createUsername("  Alice-7 ")).toMatch(/^alice-7_[a-z][a-z0-9]{5}$/);
  });

  it.each(["", "ab", "has spaces", "has_underscore", "a".repeat(25), null])(
    "rejects an invalid base username: %s",
    (username) => {
      expect(() => normalizePasskeyUsername(username)).toThrow("Passkey username");
    },
  );

  it("accepts only the canonical username shape", () => {
    expect(canonicalPasskeyUsername("alice_abc123")).toBe("alice_abc123");
    expect(() => canonicalPasskeyUsername("alice_abc12")).toThrow(
      "Canonical passkey username is invalid",
    );
  });

  it("derives the account subject and WebAuthn user handle from the canonical username", async () => {
    const username = "alice_abc123";
    const accountSub = "acc_a19222ced53d0878898e3d2a094c6bf35f0b59960ae6f9f5a8f6893db43753dc";
    const userHandle = "oZIiztU9CHiJjj0qCUxr818LWZYK5vn1qPaJPbQ3U9w";

    await expect(passkeyAccountSubject(username)).resolves.toBe(accountSub);
    await expect(passkeyWebAuthnUserId(username)).resolves.toBe(userHandle);
  });

  it("puts the immutable username and UTC creation time in the passkey display name", () => {
    expect(passkeyDisplayName("alice_abc123", new Date("2026-08-08T16:42:30Z"))).toBe(
      "alice_abc123 · 2026-08-08 16:42 UTC",
    );
  });
});
