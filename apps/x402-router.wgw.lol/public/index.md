# x402-router

Standalone x402 v2 facilitator router for the normal x402 stack.

- One facilitator URL: `https://x402-router.wgw.lol`
- Endpoints: `GET /supported`, `POST /verify`, `POST /settle`, `GET /health`
- Ethereum Mainnet: PrimeV, 1.2s settlement, sponsored gas
- EVM and Solana: PayAI, Dexter, and CDP, with fallback between them
- XRP Ledger: Sluzen on mainnet, x402.org on testnet
- Keys: optional CDP and PayAI JWTs, signed on the seller server
- License: Apache-2.0

Docs: https://x402-router.wgw.lol/llms.txt
