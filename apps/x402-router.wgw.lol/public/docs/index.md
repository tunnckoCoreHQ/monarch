---
title: x402-router
description: Standalone x402 v2 facilitator router for the normal x402 stack.
---

x402-router is a hosted x402 v2 facilitator router at https://x402-router.wgw.lol. It keeps the public surface boring on purpose:

```txt
GET  /supported
POST /verify
POST /settle
GET  /health
```

Use it as the facilitator URL in a standard x402 integration, or self-host the same package as a Fetch handler.

## What it does

- Routes Ethereum Mainnet payments to PrimeV for 1.2s settlement and sponsored gas.
- Routes EVM and Solana payments to PayAI, Dexter, or CDP, testnets included, and to x402.org for testnets.
- Routes XRP payments on XRP Ledger Mainnet to Sluzen, and on XRP Ledger Testnet to x402.org.
- Tries the next facilitator when one fails, and tells the buyer what went wrong when none can settle.
- Uses a CDP token or a PayAI key only when the seller sends one. The seller signs it on its own server.
- Pulls `/supported` from upstream facilitators so clients see current upstream support.
- Stays stateless: no router accounts, no stored seller keys, no database.

## What it is not

This is not a wallet, billing system, entitlement database, or hosted account layer. It is the routing boundary between the normal x402 stack and multiple facilitators.
