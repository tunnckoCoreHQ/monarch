import { cose, decodeCredentialPublicKey, isoCBOR } from "@simplewebauthn/server/helpers";

import { base64UrlEncode, type PublicJwk } from "../../utils";
import { passkeyUpstreamId, providerSubject } from "./subjects";

type PasskeyKeyMaterial =
  | {
      algorithm: cose.COSEALG;
      curve: cose.COSECRV.P256 | cose.COSECRV.P384 | cose.COSECRV.P521;
      keyType: cose.COSEKTY.EC2;
      kind: "EC";
      x: Uint8Array;
      y: Uint8Array;
    }
  | {
      algorithm: cose.COSEALG;
      curve: cose.COSECRV.ED25519;
      keyType: cose.COSEKTY.OKP;
      kind: "OKP";
      x: Uint8Array;
    }
  | {
      algorithm: cose.COSEALG;
      exponent: Uint8Array;
      keyType: cose.COSEKTY.RSA;
      kind: "RSA";
      modulus: Uint8Array;
    };

function ecCurveName(
  curve: Extract<PasskeyKeyMaterial, { kind: "EC" }>["curve"],
): "P-256" | "P-384" | "P-521" {
  if (curve === cose.COSECRV.P256) {
    return "P-256";
  }
  if (curve === cose.COSECRV.P384) {
    return "P-384";
  }
  if (curve === cose.COSECRV.P521) {
    return "P-521";
  }

  throw new Error("Passkey EC2 public key curve is unsupported");
}

function passkeyKeyMaterial(credentialPublicKey: Uint8Array<ArrayBuffer>): PasskeyKeyMaterial {
  const key = decodeCredentialPublicKey(credentialPublicKey);
  const keyType = key.get(cose.COSEKEYS.kty);
  const algorithm = key.get(cose.COSEKEYS.alg);
  if (!cose.isCOSEKty(keyType) || !cose.isCOSEAlg(algorithm)) {
    throw new Error("Passkey public key type or algorithm is invalid");
  }

  if (cose.isCOSEPublicKeyEC2(key)) {
    const curve = key.get(cose.COSEKEYS.crv);
    const x = key.get(cose.COSEKEYS.x);
    const y = key.get(cose.COSEKEYS.y);
    if (curve !== cose.COSECRV.P256 && curve !== cose.COSECRV.P384 && curve !== cose.COSECRV.P521) {
      throw new Error("Passkey EC2 public key is invalid");
    }
    // Pinned coordinate lengths keep the canonical encoding a pure function of the key.
    const coordinateBytes =
      curve === cose.COSECRV.P256 ? 32 : curve === cose.COSECRV.P384 ? 48 : 66;
    if (x?.length !== coordinateBytes || y?.length !== coordinateBytes) {
      throw new Error("Passkey EC2 public key is invalid");
    }

    return { algorithm, curve, keyType: cose.COSEKTY.EC2, kind: "EC", x, y };
  }

  if (cose.isCOSEPublicKeyOKP(key)) {
    const curve = key.get(cose.COSEKEYS.crv);
    const x = key.get(cose.COSEKEYS.x);
    if (curve !== cose.COSECRV.ED25519 || x?.length !== 32) {
      throw new Error("Passkey OKP public key is invalid");
    }

    return { algorithm, curve, keyType: cose.COSEKTY.OKP, kind: "OKP", x };
  }

  if (cose.isCOSEPublicKeyRSA(key)) {
    const modulus = key.get(cose.COSEKEYS.n);
    const exponent = key.get(cose.COSEKEYS.e);
    if (!modulus?.length || !exponent?.length) {
      throw new Error("Passkey RSA public key is invalid");
    }

    return { algorithm, exponent, keyType: cose.COSEKTY.RSA, kind: "RSA", modulus };
  }

  throw new Error("Passkey public key type is unsupported");
}

export function storedPasskeyPublicKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Stored passkey public key is invalid");
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Stored passkey public key is invalid");
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function canonicalPasskeyPublicKey(
  credentialPublicKey: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const material = passkeyKeyMaterial(credentialPublicKey);
  const canonical = new Map<number, number | Uint8Array>([
    [cose.COSEKEYS.kty, material.keyType],
    [cose.COSEKEYS.alg, material.algorithm],
  ]);
  if (material.kind === "EC") {
    canonical.set(cose.COSEKEYS.crv, material.curve);
    canonical.set(cose.COSEKEYS.x, material.x);
    canonical.set(cose.COSEKEYS.y, material.y);
  } else if (material.kind === "OKP") {
    canonical.set(cose.COSEKEYS.crv, material.curve);
    canonical.set(cose.COSEKEYS.x, material.x);
  } else {
    canonical.set(cose.COSEKEYS.n, material.modulus);
    canonical.set(cose.COSEKEYS.e, material.exponent);
  }

  return Uint8Array.from(isoCBOR.encode(canonical));
}

export function passkeyPublicJwk(credentialPublicKey: Uint8Array<ArrayBuffer>): PublicJwk {
  const material = passkeyKeyMaterial(credentialPublicKey);
  if (material.kind === "EC") {
    return {
      crv: ecCurveName(material.curve),
      kty: "EC",
      x: base64UrlEncode(material.x),
      y: base64UrlEncode(material.y),
    };
  }
  if (material.kind === "OKP") {
    return { crv: "Ed25519", kty: "OKP", x: base64UrlEncode(material.x) };
  }

  return {
    e: base64UrlEncode(material.exponent),
    kty: "RSA",
    n: base64UrlEncode(material.modulus),
  };
}

export function storedPasskeyPublicJwk(publicKey: string): PublicJwk {
  return passkeyPublicJwk(storedPasskeyPublicKeyBytes(publicKey));
}

export function storedPasskeyCoseKey(publicKey: string): string {
  const coseKey = storedPasskeyPublicKeyBytes(publicKey);
  passkeyKeyMaterial(coseKey);

  return base64UrlEncode(coseKey);
}

export async function isIdentityPasskey(
  identifierSecret: string,
  providerSub: string,
  storedPublicKey: string,
): Promise<boolean> {
  let canonicalPublicKey: Uint8Array<ArrayBuffer>;
  try {
    canonicalPublicKey = canonicalPasskeyPublicKey(storedPasskeyPublicKeyBytes(storedPublicKey));
  } catch {
    return false;
  }
  const upstreamId = await passkeyUpstreamId(canonicalPublicKey);

  return providerSub === (await providerSubject(identifierSecret, "passkey", upstreamId));
}
