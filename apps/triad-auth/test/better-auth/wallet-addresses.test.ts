import { describe, expect, it } from "vite-plus/test";

import {
  derivedWalletAddressKey,
  openDerivedWalletAddresses,
  sealDerivedWalletAddresses,
  WALLET_CAPABILITY_ADDRESS_KEY,
} from "../../src/better-auth/wallet";
import { sealEncryptedData } from "../../src/better-auth/identity/encryption";
import { base64UrlEncode } from "../../src/utils";

const encryptionSecrets = JSON.stringify({
  active: "test",
  secrets: { test: base64UrlEncode(new Uint8Array(32).fill(7)) },
});
const record = {
  [WALLET_CAPABILITY_ADDRESS_KEY]: "0x0000000000000000000000000000000000000001",
  [derivedWalletAddressKey({
    namespace: "client",
    namespaceSubject: "pws_abc",
    walletProfile: "evm",
    accountIndex: 0,
  })]: "0x0000000000000000000000000000000000000002",
};

describe("Derived Wallet address record", () => {
  it("separates every namespace, subject, profile, and account index", () => {
    const keys = new Set([
      derivedWalletAddressKey({
        namespace: "client",
        namespaceSubject: "pws_abc",
        walletProfile: "evm",
        accountIndex: 0,
      }),
      derivedWalletAddressKey({
        namespace: "account",
        namespaceSubject: "pws_abc",
        walletProfile: "evm",
        accountIndex: 0,
      }),
      derivedWalletAddressKey({
        namespace: "client",
        namespaceSubject: "pws_xyz",
        walletProfile: "evm",
        accountIndex: 0,
      }),
      derivedWalletAddressKey({
        namespace: "client",
        namespaceSubject: "pws_abc",
        walletProfile: "solana",
        accountIndex: 0,
      }),
      derivedWalletAddressKey({
        namespace: "client",
        namespaceSubject: "pws_abc",
        walletProfile: "evm",
        accountIndex: 1,
      }),
    ]);

    expect(keys).toHaveLength(5);
    expect(keys).not.toContain(WALLET_CAPABILITY_ADDRESS_KEY);
  });

  it("returns an empty record for a passkey without a sealed envelope", async () => {
    await expect(
      openDerivedWalletAddresses(encryptionSecrets, "acc_1", "pk_1", null),
    ).resolves.toEqual({});
  });

  it("round-trips a sealed record for the exact account and passkey", async () => {
    const envelope = await sealDerivedWalletAddresses(encryptionSecrets, "acc_1", "pk_1", record);

    await expect(
      openDerivedWalletAddresses(encryptionSecrets, "acc_1", "pk_1", envelope),
    ).resolves.toEqual(record);
  });

  it("rejects an envelope moved to a different account or passkey", async () => {
    const envelope = await sealDerivedWalletAddresses(encryptionSecrets, "acc_1", "pk_1", record);

    await expect(
      openDerivedWalletAddresses(encryptionSecrets, "acc_2", "pk_1", envelope),
    ).rejects.toThrow("Unable to decrypt");
    await expect(
      openDerivedWalletAddresses(encryptionSecrets, "acc_1", "pk_2", envelope),
    ).rejects.toThrow("Unable to decrypt");
  });

  it("rejects a sealed payload that is not an address record", async () => {
    const envelope = await sealEncryptedData(encryptionSecrets, "passkey", "acc_1\0pk_1", "text");

    await expect(
      openDerivedWalletAddresses(encryptionSecrets, "acc_1", "pk_1", envelope),
    ).rejects.toThrow("Derived Wallet address record is invalid");
  });
});
