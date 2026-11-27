# @tunnckocore/x402-router ![](https://badgen.net/static/license/Apache-2.0/blue?labelColor=black) [![built with depot](https://badgen.net/static/Built%20With%20Depot%20CI/%E2%98%85%E2%98%85%E2%98%85%E2%98%85%E2%98%85/black?labelColor=black)](https://depot.dev/products/ci?utm_source=tunnckoCoreHQ_monarch)

[![socket security](https://badges.wgw.lol/tunnckoCoreHQ/monarch/socket)](https://socket.dev?utm_source=tunnckoCoreHQ_monarch) [![ci: check](https://badges.wgw.lol/tunnckoCoreHQ/monarch/ci/check.svg)](https://badges.wgw.lol/tunnckoCoreHQ/monarch/ci/check) [![ci: test](https://badges.wgw.lol/tunnckoCoreHQ/monarch/ci/test.svg)](https://badges.wgw.lol/tunnckoCoreHQ/monarch/ci/test) [![ci: build](https://badges.wgw.lol/tunnckoCoreHQ/monarch/ci/build.svg)](https://badges.wgw.lol/tunnckoCoreHQ/monarch/ci/build) <!-- COV_BADGE:START -->![coverage](https://badgen.net/badge/coverage/91.14%25/99CC09)<!-- COV_BADGE:END -->

Standalone x402 v2 facilitator router for any WinterCG Fetch API runtime. Or call it "x402 facilitator multiplexer" if you want the fancy name. 😂

## Install

Add the scope to `.npmrc`, so it will resolve only `@tunnckocore` packages from there:

```
@tunnckocore:registry=https://npm.wgw.lol/
```

then install with package manager as usual

```bash
npm install @tunnckocore/x402-router
```

## Highlights

- **One facilitator URL.** The standard x402 stack talks to one endpoint; the router handles upstream choice.
- **Live support discovery.** `/supported` is built from the upstream facilitators, not a stale local list.
- **Protocol-level routing.** Requests route by x402 version, scheme, and network. No hard-coded "Base only" path.
- **Stateless key pass-through.** Sellers sign short-lived CDP and PayAI JWTs locally. The router stores nothing.
- **Fallback.** When a facilitator fails, the router tries the next one that can settle the payment, and it tells the buyer what went wrong when none can.
- **Works without keys.** PayAI free credits and Dexter cover EVM and Solana with no account.
- **PrimeV mainnet rail.** Ethereum payments use [PrimeV x402 facilitator](https://github.com/primev/mainnet-x402-facilitator) for 1.2s settlement and sponsored gas.
- **Self-hostable Fetch handler.** Run the same code on Cloudflare Workers, Node, Bun, Deno, or any Fetch API runtime.
- **Open source.** Apache-2.0.

It exposes the normal facilitator surface:

```txt
GET  /supported
POST /verify
POST /settle
```

Default routing: Ethereum Mainnet goes to PrimeV. EVM and Solana payments go to PayAI, Dexter, or CDP, testnets included. XRP payments on XRP Ledger Mainnet go to Sluzen. x402.org covers testnets, XRP Ledger Testnet included. A CDP token or a PayAI key puts that facilitator first. When a facilitator fails, the router tries the next one that can settle the payment. [Upstreams](https://x402-router.wgw.lol/docs/upstreams.md) has the full order, the fallback rules, and the error messages.

## Reasoning and routing

This package exists because facilitator support is fragmented. Each facilitator covers its own set of networks, keys, and fees. The router gives sellers one facilitator URL and picks a facilitator for each payment.

It does not add another account system. PrimeV gives fast Ethereum settlement with sponsored gas. Dexter charges no fee. PayAI works without a key on its free credits. CDP and PayAI keep their own auth.

The router does not need your secret keys. You sign short-lived JWTs on your server. The router forwards each JWT only to its own facilitator. It has no router-side secrets, accounts, or storage.

The router orders the facilitators for each network:

1. It starts from the default list: `primev`, `cdp`, `payai`, `dexter`, `sluzen`, `x402`.
2. The seller's preference moves the facilitators it names to the front.
3. Facilitators with a key in the request go before the rest. With both keys, CDP goes first.
4. CDP drops out when the request has no CDP token.

`/supported` takes each payment kind from the first facilitator in that order, so the Solana fee payer the seller gets is the fee payer of the facilitator that settles. A payment that names its facilitator, such as a Solana fee payer or an `upto` facilitator address, goes only to that facilitator.

`/supported` lists only `exact`, `upto`, and `batch-settlement`, because the router forwards only `/verify` and `/settle`.

## Usage for deployers

Self-host it on any standard Web Fetch API runtime: Cloudflare Workers, Node, Deno, Bun, or anything else that speaks `fetch`.

```ts
import { createX402Router } from "@tunnckocore/x402-router";

type X402RouterOptions = {
  cacheControl?: string | undefined;
  fetch?: X402RouterOutboundFetch | undefined;
  forwardedBearerHeader?: string;
  supported?: X402SupportedResponse;
  upstreams?: X402RouterUpstream[];
};

const handler = createX402Router({} as X402RouterOptions);

export default {
  async fetch(req: Request) {
    return handler.fetch(req);
  },
};
```

## Usage for seller

Point the normal x402 facilitator client at the router. Add keys and a preference only when you want them:

```ts
import { createRouterAuthHeaders } from "@tunnckocore/x402-router";

const facilitator = new HTTPFacilitatorClient({
  url: "https://x402-router.wgw.lol",
  createAuthHeaders: () =>
    createRouterAuthHeaders({
      // Optional. Puts CDP first.
      cdp: {
        apiKeyId: process.env.CDP_API_KEY_ID!,
        apiKeySecret: process.env.CDP_API_KEY_SECRET!,
      },
      // Optional. Without it, PayAI uses its free credits.
      payai: {
        apiKeyId: process.env.PAYAI_API_KEY_ID!,
        apiKeySecret: process.env.PAYAI_API_KEY_SECRET!,
      },
      // Optional. Upstream names to try first, per namespace or network.
      preference: {
        eip155: ["cdp", "payai", "dexter"],
        solana: ["payai", "dexter", "cdp"],
      },
    }),
});

// ///////////////////////////////////////////
// standard x402 setup below
// ///////////////////////////////////////////

const server = new x402ResourceServer(facilitator)
  .register(ETHEREUM_MAINNET, new ExactEvmScheme())
  .register(BASE_MAINNET, new ExactEvmScheme())
  .register(SOLANA_MAINNET, new ExactSvmScheme());

app.use(
  paymentMiddleware(
    {
      "GET /paid": {
        accepts: [
          {
            network: ETHEREUM_MAINNET,
            payTo: "0xYourEthereumMainnetAddress",
            price: "$1",
            scheme: "exact",
          },
          {
            network: BASE_MAINNET,
            payTo: "0xYourBaseAddress",
            price: "$1",
            scheme: "exact",
          },
          {
            network: SOLANA_MAINNET,
            payTo: "YourSolanaAddress",
            price: "$1",
            scheme: "exact",
          },
        ],
        description: "Paid example endpoint",
        mimeType: "application/json",
      },
    },
    server,
  ),
);
```

The middleware still calls `/supported`, `/verify`, and `/settle`. The helper sends the router headers on all three. The router forwards each token only to its own facilitator.

The secrets stay on the seller server. The helpers sign short-lived JWTs there: CDP through the CDP SDK, and PayAI through Web Crypto. The router stays stateless.

## License

Released under Apache-2.0. Read `LICENSE` for the exact terms.
