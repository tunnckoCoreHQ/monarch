// SeaDrop allowlist merkle root generator for the neko-pfp drop.
//
// One leaf per allowlisted wallet: 3 free mints (price 0, lifetime cap 3, stage 1).
// Everything beyond that is the public phase. SeaDrop caps count all mints a wallet
// ever made, so the public cap includes these free ones.
//
// Leaf encoding matches SeaDrop.mintAllowList exactly:
//   keccak256(abi.encode(minter, MintParams))
// verified with OpenZeppelin MerkleProof (sorted pairs).
//
// Usage:
//   START_TIME=<unix> END_TIME=<unix> \
//   node scripts/allowlist-merkle.ts wallets.txt > allowlist.json
//
// wallets.txt: one 0x address per line. Blank lines and lines starting with # are skipped.
// Output: { root, leaves: [{ minter, mintParams, proof }] }. Host the file at a URI and
// pass root + URI to ConfigureDrop.s.sol `allowlist()`. OpenSea and any custom mint
// frontend read the proofs from that URI.

import { readFileSync } from "node:fs";
import { concat, encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";

const INTENDED_SUPPLY = 4663n;
const OPENSEA_FEE_BPS = 1000n; // OpenSea's 10% primary drop fee; moot at price 0
const FREE_STAGE_INDEX = 1n;
const FREE_CAP = 3n;

interface MintParams {
  mintPrice: bigint;
  maxTotalMintableByWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  dropStageIndex: bigint;
  maxTokenSupplyForStage: bigint;
  feeBps: bigint;
  restrictFeeRecipients: boolean;
}

const MINT_PARAMS_ABI = [
  { type: "address" },
  {
    type: "tuple",
    components: [
      { name: "mintPrice", type: "uint256" },
      { name: "maxTotalMintableByWallet", type: "uint256" },
      { name: "startTime", type: "uint256" },
      { name: "endTime", type: "uint256" },
      { name: "dropStageIndex", type: "uint256" },
      { name: "maxTokenSupplyForStage", type: "uint256" },
      { name: "feeBps", type: "uint256" },
      { name: "restrictFeeRecipients", type: "bool" },
    ],
  },
] as const;

function leafHash(minter: Address, params: MintParams): Hex {
  return keccak256(encodeAbiParameters(MINT_PARAMS_ABI, [minter, params]));
}

// OpenZeppelin MerkleProof pairing: sort the two nodes, hash the concatenation.
function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function buildTree(leaves: Hex[]): { root: Hex; proofs: Hex[][] } {
  if (leaves.length === 0) {
    throw new Error("no leaves");
  }

  const layers: Hex[][] = [leaves];
  while (layers[0].length > 1) {
    const current = layers[0];
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i]);
    }
    layers.unshift(next);
  }

  const proofs = leaves.map((_, index) => {
    const proof: Hex[] = [];
    let position = index;
    for (let level = layers.length - 1; level > 0; --level) {
      const layer = layers[level];
      const sibling = position ^ 1;
      if (sibling < layer.length) {
        proof.push(layer[sibling]);
      }
      position = Math.floor(position / 2);
    }
    return proof;
  });

  return { root: layers[0][0], proofs };
}

function envBigInt(name: string): bigint {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return BigInt(value);
}

const walletsFile = process.argv[2];
if (!walletsFile) {
  throw new Error("usage: node scripts/allowlist-merkle.ts <wallets.txt>");
}

const freeParams: MintParams = {
  mintPrice: 0n,
  maxTotalMintableByWallet: FREE_CAP,
  startTime: envBigInt("START_TIME"),
  endTime: envBigInt("END_TIME"),
  dropStageIndex: FREE_STAGE_INDEX,
  maxTokenSupplyForStage: INTENDED_SUPPLY,
  feeBps: OPENSEA_FEE_BPS,
  restrictFeeRecipients: true,
};

const wallets = [
  ...new Set(
    readFileSync(walletsFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => getAddress(line)),
  ),
];

const { root, proofs } = buildTree(wallets.map((minter) => leafHash(minter, freeParams)));

const output = {
  root,
  wallets: wallets.length,
  leaves: wallets.map((minter, index) => ({
    minter,
    mintParams: Object.fromEntries(
      Object.entries(freeParams).map(([key, value]) => [
        key,
        typeof value === "bigint" ? value.toString() : value,
      ]),
    ),
    proof: proofs[index],
  })),
};

console.log(JSON.stringify(output, null, 2));
