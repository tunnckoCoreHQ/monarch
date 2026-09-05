# @tunnckocore/x402-router

Standalone x402 v2 facilitator router for any WinterCG Fetch API runtime. Or call it "x402 facilitator multiplexer" if you want the fancy name. 😂

## Highlights

- **One facilitator URL.** The standard x402 stack talks to one endpoint; the router handles upstream choice.
- **Live support discovery.** `/supported` is built from the upstream facilitators, not a stale local list.
- **Protocol-level routing.** Requests route by x402 version, scheme, and network. No hard-coded "Base only" path.
- **Stateless CDP pass-through.** Sellers generate short-lived CDP JWTs locally; the router stores nothing.
- **PrimeV mainnet rail.** Ethereum payments use [PrimeV x402 facilitator](https://github.com/primev/mainnet-x402-facilitator) for 1.2s settlement and sponsored gas.
- **Self-hostable Fetch handler.** Run the same code on Cloudflare Workers, Node, Bun, Deno, or any Fetch API runtime.
- **Sustainable Open Source.** Fair source under FSL-1.1-ALv2, with automatic Apache-2.0 conversion after 2 years.

It exposes the normal facilitator surface:

```txt
GET  /supported
POST /verify
POST /settle
```

Default routing is explicit: Ethereum Mainnet goes to PrimeV; Base, Solana, and other CDP-supported networks go to CDP; public test/dev networks come from x402.org. `/supported` reports what those upstreams currently claim.

## Reasoning and routing

This package exists because facilitator support is fragmented. CDP covers its EVM/Solana rails, x402.org covers public test/dev networks, and PrimeV covers Ethereum Mainnet. The router gives sellers one facilitator URL without pretending every upstream supports every chain.

It does not add another account system. PrimeV gives us fast Ethereum settlement with sponsored gas. CDP keeps its own auth. The router stays thin.

For CDP-routed calls, the router does not need your CDP secret key. You generate a short-lived CDP JWT on your server. The router forwards that JWT only when it chooses CDP. No router-side secrets, accounts, storage, API keys, or auth layer.

Routing is decided from the request network, scheme, and x402 version. `/supported` is generated live from upstream facilitators.

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

CDP-routed requests require a short-lived bearer token for CDP, not for the router URL. Use the helper with the normal x402 facilitator client:

```ts
import { createCdpAuthHeaders } from "@tunnckocore/x402-router/cdp";

const facilitator = new HTTPFacilitatorClient({
  url: "https://x402-router.wgw.lol",
  createAuthHeaders: () =>
    // creates a short-lived JWT token for forwarded CDP requests
    createCdpAuthHeaders({
      apiKeyId: process.env.CDP_API_KEY_ID!,
      apiKeySecret: process.env.CDP_API_KEY_SECRET!,
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

The middleware still calls `/supported`, `/verify`, and `/settle` normally. The router serves `/supported` from its upstream list. The helper only supplies the forwarded CDP bearer header when `/verify` or `/settle` routes to CDP.

The CDP secrets stay on the seller's server. They are passed to the CDP SDK to generate a short-lived JWT, then used to authorize the CDP upstream request. The router remains stateless.

## License

Released under FSL-1.1-ALv2. Private use, non-commercial use, and self-hosting are free. The restriction is the do-not-compete clause for the first 2 years. After that, the source code license automatically converts to Apache-2.0. Read `LICENSE` for the exact terms.
