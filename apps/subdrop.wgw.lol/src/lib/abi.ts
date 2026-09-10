export { subdropAbi } from "./subdrop-abi";
export { erc20Abi } from "viem";

export const CANNOT_UNWRAP = 1;
export const PARENT_CANNOT_CONTROL = 1 << 16;
export const DEFAULT_FUSES = PARENT_CANNOT_CONTROL | CANNOT_UNWRAP;

export const nameWrapperAbi = [
  {
    type: "function",
    name: "getData",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "fuses", type: "uint32" },
      { name: "expiry", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setFuses",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "ownerControlledFuses", type: "uint16" },
    ],
    outputs: [{ name: "newFuses", type: "uint32" }],
  },
] as const;
