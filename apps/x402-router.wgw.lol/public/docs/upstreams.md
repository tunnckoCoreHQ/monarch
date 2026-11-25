---
title: Upstreams
description: How the router orders facilitators, routes payments, and falls back.
---

The router sends each payment to one of five upstream facilitators.

| Name     | Facilitator                 | Key                 | Networks                          |
| -------- | --------------------------- | ------------------- | --------------------------------- |
| `primev` | `facilitator.primev.xyz`    | none                | Ethereum Mainnet                  |
| `cdp`    | `api.cdp.coinbase.com`      | CDP token, required | EVM and Solana                    |
| `payai`  | `facilitator.payai.network` | PayAI key, optional | EVM and Solana, testnets included |
| `dexter` | `x402.dexter.cash`          | none                | EVM and Solana                    |
| `x402`   | `x402.org/facilitator`      | none                | Testnets                          |

Without a key, PayAI uses its free credits. Each receiving wallet gets 1,000 credits, and PayAI then needs a key.

## Order

The router builds one order for each network. The same order decides which upstream serves a kind in `/supported` and which upstream `/verify` and `/settle` try first.

1. The router starts from the default list: `primev`, `cdp`, `payai`, `dexter`, `x402`.
2. The seller's preference moves the upstreams it names to the front. For example, the preference `["dexter", "payai"]` gives `dexter`, `payai`, `primev`, `cdp`, `x402`.
3. Upstreams with a key in the request go before upstreams without one. Both groups keep the order from step 2.
4. CDP drops out when the request has no CDP token.

With the default list:

- With both keys, CDP goes first.
- With a CDP token only, CDP goes first.
- With a PayAI key only, PayAI goes first.
- With no keys, PayAI goes first on its free credits, then Dexter.

With the preference `eip155: ["payai", "cdp", "dexter"]` and both keys, PayAI goes first.

## Seller preference

A seller sets the preference per CAIP-2 namespace, such as `eip155` or `solana`, or per full network, such as `eip155:8453`. A full network beats its namespace.

```ts
import { createRouterAuthHeaders } from "@tunnckocore/x402-router";

const facilitator = new HTTPFacilitatorClient({
  url: "https://x402-router.wgw.lol",
  createAuthHeaders: () =>
    createRouterAuthHeaders({
      preference: {
        eip155: ["cdp", "payai", "dexter"],
        solana: ["payai", "dexter", "cdp"],
      },
    }),
});
```

The helper sends the preference in the `X-X402-Router-Preference` header on every call, `/supported` included. The x402 SDK reads `/supported` once at startup, so a new preference takes effect when the seller restarts.

## Routing

Some payments name the facilitator that must settle them. The buyer signs these fields, so only that facilitator can settle the payment:

- `extra.feePayer` on Solana.
- `extra.facilitatorAddress` on `upto`.
- `extra.receiverAuthorizer` on `batch-settlement`.
- `extra.assetTransferMethod`, such as `permit2`.

The router skips any upstream whose kind has a different value for one of these fields. An EVM `exact` payment that uses EIP-3009 names no facilitator, so any upstream in the order can settle it.

`/supported` lists only `exact`, `upto`, and `batch-settlement`. The router forwards only `/verify` and `/settle`, so it drops schemes that need other endpoints, such as Dexter's `tab`.

## Fallback

The router tries the upstreams in order. It moves to the next upstream when an upstream:

- is out of credits,
- rejects the key or needs one,
- does not support the payment,
- is rate limited or unavailable,
- returns a 5xx status, or cannot be reached.

The router stops when the payment itself is invalid, for example a bad signature, too little balance, or an expired authorization. Every facilitator would reject that payment.

A `/settle` that failed with a 5xx status or a network error may have reached the chain. The router still tries the next upstream. If no upstream settles the payment, the router answers `settlement_state_unknown`.

## Errors

A failed `/verify` or `/settle` keeps the upstream's reason and adds a message for the buyer:

| Case | Message |
| --- | --- |
| Permit2 approval missing | This payment needs a one-time Permit2 approval of the token on the network from your wallet. Approve it, or pay on another network. |
| Out of credits, no other path | The seller's payment provider is out of credits. Try again later, or pay on another network. |
| Every upstream failed | No facilitator can settle this payment on the network right now. |
| Settle failed midway | The payment may have settled. Check your wallet before you pay again. |

The response also has `extra.router.tried`, with each upstream the router tried and its answer. When PayAI is out of credits, `extra.router.topUpUrl` has PayAI's top-up link.

## Support discovery

`GET /supported` asks every upstream for its live kinds. If an upstream fails, the router uses that upstream's static `supportedKinds` instead.

A response for a request with keys or a preference is private to that seller. It has `cache-control: private` and a `vary` header for the routing headers.
