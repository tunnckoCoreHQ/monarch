import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import {
  Address,
  NETWORK,
  OutScript,
  RawWitness,
  TEST_NETWORK,
  Transaction,
  p2tr,
  p2wpkh,
} from "@scure/btc-signer";
import { verifyMessage } from "viem";

import { concatenateBytes, uint32BigEndian } from "../../utils";
import { walletDerivationPath, walletProfile, type WalletProfileId } from "./profiles";

interface WalletSignature {
  address: string;
  signature: string;
}

const textEncoder = new TextEncoder();
const empty32 = new Uint8Array(32);

function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  const segments = path.split("/");
  if (
    segments[0] !== "m" ||
    segments.slice(1).some((segment) => !/^(0|[1-9][0-9]*)'$/.test(segment))
  ) {
    throw new Error("Solana derivation paths must contain only hardened indexes");
  }

  let material = hmac(sha512, textEncoder.encode("ed25519 seed"), seed);
  let privateKey = material.slice(0, 32);
  let chainCode = material.slice(32);
  material.fill(0);

  for (const segment of segments.slice(1)) {
    const index = Number(segment.slice(0, -1));
    if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31) {
      privateKey.fill(0);
      chainCode.fill(0);
      throw new Error("Solana derivation path index is invalid");
    }

    material = hmac(
      sha512,
      chainCode,
      concatenateBytes(Uint8Array.of(0), privateKey, uint32BigEndian(index + 2 ** 31)),
    );
    privateKey.fill(0);
    chainCode.fill(0);
    privateKey = material.slice(0, 32);
    chainCode = material.slice(32);
    material.fill(0);
  }

  chainCode.fill(0);

  return privateKey;
}

function bitcoinNetwork(network: "mainnet" | "testnet") {
  return network === "mainnet" ? NETWORK : TEST_NETWORK;
}

function bip322MessageHash(message: string): Uint8Array {
  return schnorr.utils.taggedHash("BIP0322-signed-message", textEncoder.encode(message));
}

function bip322ToSign(challengeScript: Uint8Array, message: string): Transaction {
  const messageHash = bip322MessageHash(message);
  const toSpend = new Transaction({ version: 0, allowUnknownVersion: true });
  toSpend.addOutput({ amount: 0n, script: challengeScript });
  toSpend.addInput({
    txid: empty32,
    index: 0xffff_ffff,
    sequence: 0,
    finalScriptSig: concatenateBytes(Uint8Array.of(0, 32), messageHash),
  });

  const toSign = new Transaction({
    version: 0,
    allowUnknownVersion: true,
    allowUnknownOutputs: true,
  });
  toSign.addInput({
    txid: toSpend.id,
    index: 0,
    sequence: 0,
    witnessUtxo: { amount: 0n, script: challengeScript },
  });
  toSign.addOutput({ amount: 0n, script: Uint8Array.of(0x6a) });

  return toSign;
}

function signBitcoin(
  privateKey: Uint8Array,
  profileId: WalletProfileId,
  message: string,
): WalletSignature {
  const profile = walletProfile(profileId);
  if (profile.chain !== "bitcoin") {
    throw new Error("Bitcoin wallet profile is invalid");
  }

  const network = bitcoinNetwork(profile.network);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const payment =
    profile.addressType === "native-segwit"
      ? p2wpkh(publicKey, network)
      : p2tr(publicKey.slice(1), undefined, network);
  const toSign = bip322ToSign(payment.script, message);
  if (profile.addressType === "taproot") {
    toSign.updateInput(0, { tapInternalKey: publicKey.slice(1) });
  }
  toSign.signIdx(privateKey, 0);
  toSign.finalizeIdx(0);
  const witness = toSign.getInput(0).finalScriptWitness;
  if (!witness) {
    throw new Error("Bitcoin wallet signature was not finalized");
  }

  return { address: payment.address, signature: base64.encode(RawWitness.encode(witness)) };
}

function verifyBitcoin(
  profileId: WalletProfileId,
  address: string,
  signature: string,
  message: string,
): boolean {
  try {
    const profile = walletProfile(profileId);
    if (profile.chain !== "bitcoin") {
      return false;
    }
    const network = bitcoinNetwork(profile.network);
    const decodedAddress = Address(network).decode(address);
    const challengeScript = OutScript.encode(decodedAddress);
    const witness = RawWitness.decode(base64.decode(signature));
    const toSign = bip322ToSign(challengeScript, message);

    if (profile.addressType === "native-segwit") {
      if (decodedAddress.type !== "wpkh" || witness.length !== 2) {
        return false;
      }
      const [encodedSignature, publicKey] = witness;
      if (!encodedSignature || !publicKey || encodedSignature.at(-1) !== 1) {
        return false;
      }
      const payment = p2wpkh(publicKey, network);
      if (payment.address !== address) {
        return false;
      }
      const scriptCode = Uint8Array.of(0x76, 0xa9, 0x14, ...payment.hash, 0x88, 0xac);
      const digest = toSign.preimageWitnessV0(0, scriptCode, 1, 0n);

      return secp256k1.verify(encodedSignature.slice(0, -1), digest, publicKey, {
        prehash: false,
        format: "der",
      });
    }

    if (decodedAddress.type !== "tr" || witness.length !== 1) {
      return false;
    }
    const encodedSignature = witness[0];
    if (!encodedSignature || (encodedSignature.length !== 64 && encodedSignature.length !== 65)) {
      return false;
    }
    const sighash = encodedSignature.length === 65 ? encodedSignature[64]! : 0;
    if (sighash !== 0) {
      return false;
    }
    const digest = toSign.preimageWitnessV1(0, [challengeScript], sighash, [0n]);

    return schnorr.verify(encodedSignature.slice(0, 64), digest, decodedAddress.pubkey);
  } catch {
    return false;
  }
}

export async function signPrfWallet(
  prfRoot: Uint8Array,
  profileId: WalletProfileId,
  accountIndex: number,
  message: string,
): Promise<WalletSignature> {
  if (prfRoot.length !== 32) {
    throw new Error("Passkey PRF roots must contain 32 bytes");
  }

  const profile = walletProfile(profileId);
  const path = walletDerivationPath(profile, accountIndex);
  if (profile.chain === "solana") {
    let privateKey: Uint8Array | undefined;
    try {
      privateKey = slip10Ed25519(prfRoot, path);
      const publicKey = ed25519.getPublicKey(privateKey);
      const signature = ed25519.sign(textEncoder.encode(message), privateKey);

      return { address: base58.encode(publicKey), signature: base58.encode(signature) };
    } finally {
      privateKey?.fill(0);
      prfRoot.fill(0);
    }
  }

  let root: HDKey | undefined;
  let derived: HDKey | undefined;
  try {
    root = HDKey.fromMasterSeed(prfRoot);
    derived = root.derive(path);
    const privateKey = derived.privateKey;
    if (!privateKey) {
      throw new Error("Wallet profile did not derive a private key");
    }
    if (profile.chain === "bitcoin") {
      return signBitcoin(privateKey, profile.id, message);
    }

    const { privateKeyToAccount } = await import("viem/accounts");
    const { toHex } = await import("viem");
    const account = privateKeyToAccount(toHex(privateKey));

    return { address: account.address, signature: await account.signMessage({ message }) };
  } finally {
    prfRoot.fill(0);
    root?.wipePrivateData();
    derived?.wipePrivateData();
  }
}

export async function verifyPrfWalletSignature(
  profileId: WalletProfileId,
  address: string,
  signature: string,
  message: string,
): Promise<boolean> {
  const profile = walletProfile(profileId);
  if (profile.chain === "bitcoin") {
    return verifyBitcoin(profileId, address, signature, message);
  }
  if (profile.chain === "solana") {
    try {
      const publicKey = base58.decode(address);
      const signatureBytes = base58.decode(signature);

      return (
        publicKey.length === 32 &&
        signatureBytes.length === 64 &&
        ed25519.verify(signatureBytes, textEncoder.encode(message), publicKey)
      );
    } catch {
      return false;
    }
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return false;
  }

  return verifyMessage({
    address: address as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });
}
