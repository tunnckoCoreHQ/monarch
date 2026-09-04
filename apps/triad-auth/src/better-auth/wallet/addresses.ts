import { isRecord } from "../../utils";
import { openEncryptedData, sealEncryptedData } from "../identity/encryption";
import type { WalletProfileId } from "./profiles";
import type { WalletNamespace } from "./protocol";

export const WALLET_CAPABILITY_ADDRESS_KEY = "capability";

export interface DerivedWalletKey {
  namespace: WalletNamespace;
  namespaceSubject: string;
  walletProfile: WalletProfileId;
  accountIndex: number;
}

export function derivedWalletAddressKey(key: DerivedWalletKey): string {
  return `${key.namespace}\0${key.namespaceSubject}\0${key.walletProfile}\0${key.accountIndex}`;
}

function addressRecordBinding(userId: string, passkeyId: string): string {
  return `${userId}\0${passkeyId}`;
}

export async function openDerivedWalletAddresses(
  encryptionSecrets: string,
  userId: string,
  passkeyId: string,
  envelope: string | null,
): Promise<Record<string, string>> {
  if (!envelope) {
    return {};
  }

  const record = await openEncryptedData(
    encryptionSecrets,
    "passkey",
    addressRecordBinding(userId, passkeyId),
    envelope,
  );
  if (!isRecord(record) || Object.values(record).some((address) => typeof address !== "string")) {
    throw new Error("Derived Wallet address record is invalid");
  }

  return record as Record<string, string>;
}

export async function sealDerivedWalletAddresses(
  encryptionSecrets: string,
  userId: string,
  passkeyId: string,
  record: Record<string, string>,
): Promise<string> {
  return sealEncryptedData(
    encryptionSecrets,
    "passkey",
    addressRecordBinding(userId, passkeyId),
    record,
  );
}
