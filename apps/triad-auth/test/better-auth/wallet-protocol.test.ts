import { describe, expect, it } from "vite-plus/test";

import {
  parseWalletAuthorizationInput,
  signPrfWallet,
  verifyPrfWalletSignature,
  WALLET_CAPABILITY_ACCOUNT_INDEX,
  WALLET_CAPABILITY_PROFILE,
  WALLET_PROFILE_IDS,
  walletCapabilityPrfSaltBase64Url,
  walletCapabilitySigningMessage,
  walletDerivationPath,
  walletPrfSalt,
  walletProfile,
  walletRedirectUri,
  walletSigningMessage,
} from "../../src/better-auth/wallet";

const requestBody = {
  client_id: "https://client.example/metadata.json",
  redirect_uri: "https://client.example/callback",
  state: "state-with-entropy-123456",
  message: "Authorize this client challenge.",
};

describe("PRF wallet derivation protocol", () => {
  it.each([
    ["evm", "m/44'/60'/7'/0/0"],
    ["solana", "m/44'/501'/7'/0'"],
    ["bitcoin-native-segwit-mainnet", "m/84'/0'/7'/0/0"],
    ["bitcoin-native-segwit-testnet", "m/84'/1'/7'/0/0"],
    ["bitcoin-taproot-mainnet", "m/86'/0'/7'/0/0"],
    ["bitcoin-taproot-testnet", "m/86'/1'/7'/0/0"],
  ] as const)("maps %s to its standard account path", (profileId, path) => {
    expect(walletDerivationPath(walletProfile(profileId), 7)).toBe(path);
  });

  it("parses a profile request and defaults the account index and EVM chain ID", () => {
    expect(
      parseWalletAuthorizationInput({
        ...requestBody,
        namespace: "source",
        wallet_profile: "evm",
      }),
    ).toEqual({
      clientId: requestBody.client_id,
      redirectUri: requestBody.redirect_uri,
      state: requestBody.state,
      message: requestBody.message,
      namespace: "source",
      walletProfile: "evm",
      accountIndex: 0,
      path: "m/44'/60'/0'/0/0",
      chainId: 1,
    });
  });

  it("rejects raw paths, generic Bitcoin, and chain IDs outside EVM", () => {
    expect(() =>
      parseWalletAuthorizationInput({
        ...requestBody,
        wallet_profile: "evm",
        path: "m/0",
      }),
    ).toThrow("raw derivation path");
    expect(() =>
      parseWalletAuthorizationInput({ ...requestBody, wallet_profile: "bitcoin" }),
    ).toThrow("Wallet profile");
    expect(() =>
      parseWalletAuthorizationInput({
        ...requestBody,
        wallet_profile: "solana",
        chain_id: 1,
      }),
    ).toThrow("only valid for the EVM");
  });

  it("domain-separates account, client, and source wallet seeds", async () => {
    const [accountSalt, clientSalt, sourceSalt, repeatedAccountSalt] = await Promise.all([
      walletPrfSalt("account", "acc_abc"),
      walletPrfSalt("client", "pws_abc"),
      walletPrfSalt("source", "pid_github_abc"),
      walletPrfSalt("account", "acc_abc"),
    ]);

    expect(accountSalt).toEqual(repeatedAccountSalt);
    expect(
      new Set([accountSalt, clientSalt, sourceSalt].map((salt) => [...salt].join(","))),
    ).toHaveLength(3);
  });

  it("binds a dedicated Wallet Capability proof to the exact stored Passkey", async () => {
    const salt = await walletCapabilityPrfSaltBase64Url("acc_abc", "passkey_123");
    const otherSalt = await walletCapabilityPrfSaltBase64Url("acc_abc", "passkey_456");
    const message = walletCapabilitySigningMessage({
      origin: "https://triad.wgw.lol",
      accountSubject: "acc_abc",
      credentialId: "passkey_123",
      requestId: "00000000-0000-4000-8000-000000000000",
      issuedAt: "2026-08-12T00:00:00.000Z",
      expiresAt: "2026-08-12T00:05:00.000Z",
    });

    expect(salt).not.toBe(otherSalt);
    expect(message).toContain('"credential_id":"passkey_123"');
    expect(message).toContain(`"wallet_profile":"${WALLET_CAPABILITY_PROFILE}"`);
    expect(message).toContain(`"account_index":${WALLET_CAPABILITY_ACCOUNT_INDEX}`);
  });

  it.each(WALLET_PROFILE_IDS)("derives and verifies a %s wallet signature", async (profileId) => {
    const prfRoot = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const message = "Triad wallet profile signature fixture";
    const signed = await signPrfWallet(prfRoot, profileId, 0, message);

    await expect(
      verifyPrfWalletSignature(profileId, signed.address, signed.signature, message),
    ).resolves.toBe(true);
    await expect(
      verifyPrfWalletSignature(profileId, signed.address, signed.signature, `foo ${message} bar!`),
    ).resolves.toBe(false);
    expect(prfRoot).toEqual(new Uint8Array(32));
  });

  it("binds profile, account index, and EVM chain ID without changing the wallet path", () => {
    const message = walletSigningMessage({
      origin: "https://triad.wgw.lol",
      clientId: requestBody.client_id,
      requestId: "00000000-0000-4000-8000-000000000000",
      namespace: "client",
      namespaceSubject: "pws_abc",
      walletProfile: "evm",
      accountIndex: 2,
      path: "m/44'/60'/2'/0/0",
      chainId: 8453,
      message: requestBody.message,
      issuedAt: "2026-08-12T00:00:00.000Z",
      expiresAt: "2026-08-12T00:05:00.000Z",
    });

    expect(message).toContain('"wallet_profile":"evm"');
    expect(message).toContain('"account_index":2');
    expect(message).toContain('"chain_id":8453');
  });

  it("returns the complete wallet result in the registered redirect fragment", () => {
    const redirect = walletRedirectUri("https://client.example/callback?existing=1", {
      state: requestBody.state,
      requestId: "00000000-0000-4000-8000-000000000000",
      address: "0x0000000000000000000000000000000000000001",
      signature: `0x${"11".repeat(65)}`,
      namespace: "account",
      namespaceSubject: "acc_abc",
      walletProfile: "evm",
      accountIndex: 0,
      path: "m/44'/60'/0'/0/0",
      chainId: 1,
      message: "Triad Wallet Authorization v2\n{}",
      receipt: "signed-triad-receipt",
    });
    const target = new URL(redirect);
    const fragment = new URLSearchParams(target.hash.slice(1));

    expect(target.search).toBe("?existing=1");
    expect(fragment.get("state")).toBe(requestBody.state);
    expect(fragment.get("triad_wallet_profile")).toBe("evm");
    expect(fragment.get("triad_namespace")).toBe("account");
    expect(fragment.get("triad_chain_id")).toBe("1");
    expect(fragment.get("triad_receipt")).toBe("signed-triad-receipt");
  });
});
