import { describe, expect, it } from "vite-plus/test";

import {
  createTriadDeviceAuthorization,
  DEVICE_AUTHORIZATION_EXPIRES_IN,
  DEVICE_AUTHORIZATION_INTERVAL,
  DEVICE_AUTHORIZATION_VERIFICATION_URI,
  type TriadDeviceAuthorizationPlugin,
} from "../../src/better-auth/device";

function createDeviceEnv(registeredClients: readonly string[] = []) {
  return {
    AUTH_ORIGIN: "https://AUTH.EXAMPLE.com:443/",
    DB: {
      prepare: () => ({
        bind: (clientId: unknown) => ({
          first: async () =>
            typeof clientId === "string" && registeredClients.includes(clientId)
              ? { registered: 1 }
              : null,
        }),
      }),
    } as unknown as D1Database,
  };
}

function validateClient(plugin: TriadDeviceAuthorizationPlugin) {
  const validate = plugin.options.validateClient;
  if (!validate) {
    throw new Error("Device client validation is missing");
  }

  return validate;
}

describe("Triad Better Auth device authorization", () => {
  it("exports a composable plugin with fixed device policy", () => {
    const plugin = createTriadDeviceAuthorization(createDeviceEnv());

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
    "https://auth.example.com/",
    "https://auth.example.com/device",
    "https://auth.example.com?client=device",
    "https://other.example.com",
    "not-a-url",
  ])("rejects unknown client ID %s", async (clientId) => {
    const plugin = createTriadDeviceAuthorization(createDeviceEnv());

    await expect(Promise.resolve(validateClient(plugin)(clientId))).resolves.toBe(false);
  });

  it("accepts only the exact canonical configured origin", async () => {
    const plugin = createTriadDeviceAuthorization(createDeviceEnv());

    await expect(Promise.resolve(validateClient(plugin)("https://auth.example.com"))).resolves.toBe(
      true,
    );
  });

  it("accepts a registered OAuth client", async () => {
    const clientId = "registered-device-client";
    const plugin = createTriadDeviceAuthorization(createDeviceEnv([clientId]));

    await expect(Promise.resolve(validateClient(plugin)(clientId))).resolves.toBe(true);
  });

  it("exposes Better Auth's device routes and shared schema", () => {
    const plugin = createTriadDeviceAuthorization(createDeviceEnv());

    expect(Object.values(plugin.endpoints).map((endpoint) => endpoint.path)).toEqual([
      "/device/code",
      "/device/token",
      "/device",
      "/device/approve",
      "/device/deny",
    ]);
    expect(plugin.schema.deviceCode.fields).toEqual({
      deviceCode: { type: "string", required: true },
      userCode: { type: "string", required: true },
      userId: { type: "string", required: false },
      expiresAt: { type: "date", required: true },
      status: { type: "string", required: true },
      lastPolledAt: { type: "date", required: false },
      pollingInterval: { type: "number", required: false },
      clientId: { type: "string", required: false },
      scope: { type: "string", required: false },
      resource: { type: "string", required: false },
    });
  });
});
