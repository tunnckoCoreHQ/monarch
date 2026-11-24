import { describe, expect, it } from "vitest";

import {
  createTriadDeviceAuthorization,
  DEVICE_AUTHORIZATION_EXPIRES_IN,
  DEVICE_AUTHORIZATION_INTERVAL,
  DEVICE_AUTHORIZATION_VERIFICATION_URI,
  type TriadDeviceAuthorizationPlugin,
} from "../../src/better-auth/device";

function validateClient(plugin: TriadDeviceAuthorizationPlugin) {
  const validate = plugin.options.validateClient;
  if (!validate) {
    throw new Error("Device client validation is missing");
  }

  return validate;
}

describe("Triad Better Auth device authorization", () => {
  it("exports a composable plugin with fixed device policy", () => {
    const plugin = createTriadDeviceAuthorization();

    expect(plugin.id).toBe("device-authorization");
    expect(plugin.options).toMatchObject({
      expiresIn: DEVICE_AUTHORIZATION_EXPIRES_IN,
      interval: DEVICE_AUTHORIZATION_INTERVAL,
      verificationUri: DEVICE_AUTHORIZATION_VERIFICATION_URI,
    });
    expect(DEVICE_AUTHORIZATION_EXPIRES_IN).toBe("10m");
    expect(DEVICE_AUTHORIZATION_INTERVAL).toBe("5s");
    expect(DEVICE_AUTHORIZATION_VERIFICATION_URI).toBe("/device/verify");
  });

  it.each([
    "https://auth.example.com",
    "https://auth.example.com/",
    "https://auth.example.com/device",
    "https://auth.example.com?client=device",
    "https://other.example.com",
    "registered-device-client",
    "not-a-url",
  ])("leaves client ID %s to OAuth Provider", async (clientId) => {
    const plugin = createTriadDeviceAuthorization();

    await expect(Promise.resolve(validateClient(plugin)(clientId))).resolves.toBe(false);
  });

  it("accepts the triad-auth client ID as the first-party client", async () => {
    const plugin = createTriadDeviceAuthorization();

    await expect(Promise.resolve(validateClient(plugin)("triad-auth"))).resolves.toBe(true);
  });

  it("exposes Better Auth's device routes and the OAuth device schema", () => {
    const plugin = createTriadDeviceAuthorization();

    expect(Object.values(plugin.endpoints).map((endpoint) => endpoint.path)).toEqual([
      "/device/code",
      "/device/token",
      "/device",
      "/device/approve",
      "/device/deny",
    ]);
    expect(Object.keys(plugin.schema.deviceCode.fields)).toEqual(
      expect.arrayContaining(["deviceCode", "userCode", "userId", "clientId", "oauthClientId"]),
    );
  });
});
