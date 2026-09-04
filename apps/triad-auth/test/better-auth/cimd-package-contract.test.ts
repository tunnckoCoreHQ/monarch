import { validateCimdMetadata } from "@better-auth/cimd";
import { describe, expect, it } from "vite-plus/test";

const clientId = "https://client.example/metadata.json";
const validMetadata = {
  client_id: clientId,
  client_name: "Example client",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
};

const validationOptions = { metadataProfile: "mcp-2026-07-28" } as const;

describe("CIMD package contract", () => {
  it("requires a nonempty client name", () => {
    const { client_name: _name, ...missingName } = validMetadata;

    expect(validateCimdMetadata(clientId, missingName, validationOptions)).toMatchObject({
      valid: false,
    });
    expect(
      validateCimdMetadata(clientId, { ...validMetadata, client_name: "   " }, validationOptions),
    ).toMatchObject({ valid: false });
  });
});
