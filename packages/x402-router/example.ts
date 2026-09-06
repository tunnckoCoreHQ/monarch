import { serve } from "@hono/node-server";
import { BASE_MAINNET, ETHEREUM_MAINNET, SOLANA_MAINNET } from "@tunnckocore/x402-router";
import { createCdpAuthHeaders } from "@tunnckocore/x402-router/cdp";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { Hono } from "hono";

const app = new Hono();

const facilitator = new HTTPFacilitatorClient({
  url: "https://x402-router.wgw.lol",
  createAuthHeaders: () =>
    createCdpAuthHeaders({
      apiKeyId: process.env.CDP_API_KEY_ID!,
      apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    }),
});

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

app.get("/paid", (c) =>
  c.json({
    ok: true,
    message: "paid endpoint reached",
  }),
);

serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 4021),
});
