# @tunnckocore/ethscriptions-server

An Ethscriptions API server built on [Hono](https://hono.dev). It caches, validates, and unifies the responses of the Ethscriptions API, according to [ESIP-9](https://github.com/ethscriptions-protocol/ESIP-Discussion/issues/18). It also estimates ethscribing costs, creates and checks SHA-256 digests, and resolves ENS and Ethscriptions names.

It runs the Calldata Ethscriptions API at [api.calldata.space](https://api.calldata.space), from the `ethscriptions-api-proxy` app in this repository.

## Install

Add the scope to `.npmrc`, so only `@tunnckocore` packages resolve from there:

```
@tunnckocore:registry=https://npm.wgw.lol/
```

Then install it:

```bash
pnpm add @tunnckocore/ethscriptions-server
```

## Usage

The server is a Hono app, so it runs on Cloudflare Workers, Bun, Deno, Node.js, and others.

```ts
import { createApp, withRoutes } from "@tunnckocore/ethscriptions-server";

// Mainnet, with the default title.
export default withRoutes(createApp());

// Another upstream, with its own home page title.
const sepolia = withRoutes(createApp(), "https://sepolia-api-v2.ethscriptions.com", {
  title: "Calldata Ethscriptions API (Sepolia)",
});
```

The home page and `/endpoints` show the build commit from the `COMMIT_SHA` binding or environment variable, and `local` when it is missing.

For frameworks like Next.js, `createRouteHandlers` returns one handler for each HTTP method. Pass another Hono adapter as the third argument for other platforms.

```ts
import { createRouteHandlers } from "@tunnckocore/ethscriptions-server";

export const { GET, POST, OPTIONS } = createRouteHandlers("https://api.ethscriptions.com/v2");
```

## License

Released under the MPL-2.0 License.
