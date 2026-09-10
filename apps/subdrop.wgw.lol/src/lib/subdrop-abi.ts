// Generated from solidity/subdrop with `forge inspect Subdrop abi --json`.
export const subdropAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "nameWrapper_",
        type: "address",
        internalType: "address",
      },
      {
        name: "resolver_",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "DEFAULT_FUSES",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "available",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "label",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "configure",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "config",
        type: "tuple",
        internalType: "struct Subdrop.DropConfig",
        components: [
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "feeRecipient",
            type: "address",
            internalType: "address",
          },
          {
            name: "price",
            type: "uint96",
            internalType: "uint96",
          },
          {
            name: "reward",
            type: "uint96",
            internalType: "uint96",
          },
          {
            name: "fuses",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "maxMints",
            type: "uint32",
            internalType: "uint32",
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "drops",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "feeRecipient",
        type: "address",
        internalType: "address",
      },
      {
        name: "price",
        type: "uint96",
        internalType: "uint96",
      },
      {
        name: "reward",
        type: "uint96",
        internalType: "uint96",
      },
      {
        name: "fuses",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "maxMints",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "minted",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "paused",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "launch",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "symbol",
        type: "string",
        internalType: "string",
      },
      {
        name: "supply",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "config",
        type: "tuple",
        internalType: "struct Subdrop.DropConfig",
        components: [
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "feeRecipient",
            type: "address",
            internalType: "address",
          },
          {
            name: "price",
            type: "uint96",
            internalType: "uint96",
          },
          {
            name: "reward",
            type: "uint96",
            internalType: "uint96",
          },
          {
            name: "fuses",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "maxMints",
            type: "uint32",
            internalType: "uint32",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "label",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [
      {
        name: "node",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "nameWrapper",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract INameWrapper",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "onERC1155Received",
    inputs: [
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes4",
        internalType: "bytes4",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "remaining",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "count",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "resolver",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setPaused",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "paused",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "tokenImplementation",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "DropConfigured",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "feeRecipient",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "price",
        type: "uint96",
        indexed: false,
        internalType: "uint96",
      },
      {
        name: "reward",
        type: "uint96",
        indexed: false,
        internalType: "uint96",
      },
      {
        name: "fuses",
        type: "uint32",
        indexed: false,
        internalType: "uint32",
      },
      {
        name: "maxMints",
        type: "uint32",
        indexed: false,
        internalType: "uint32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DropPaused",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "paused",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Minted",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "node",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "minter",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "label",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "price",
        type: "uint96",
        indexed: false,
        internalType: "uint96",
      },
      {
        name: "reward",
        type: "uint96",
        indexed: false,
        internalType: "uint96",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      {
        name: "parentNode",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "holder",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "supply",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "DropIsPaused",
    inputs: [],
  },
  {
    type: "error",
    name: "DropNotFound",
    inputs: [],
  },
  {
    type: "error",
    name: "IncorrectPayment",
    inputs: [
      {
        name: "actual",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "expected",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidFuses",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidLabel",
    inputs: [],
  },
  {
    type: "error",
    name: "LabelTaken",
    inputs: [],
  },
  {
    type: "error",
    name: "MintedOut",
    inputs: [],
  },
  {
    type: "error",
    name: "NotParentOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "ParentCannotBurnFuses",
    inputs: [],
  },
  {
    type: "error",
    name: "ParentOwnerChanged",
    inputs: [],
  },
  {
    type: "error",
    name: "UnexpectedToken",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
] as const;
