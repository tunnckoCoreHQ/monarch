# subdrop.wgw.lol

Frontend for the `solidity/subdrop` contracts. TanStack Start on Cloudflare Workers, built with the Cloudflare Vite plugin.

## Pages

- `/` explains the deal and opens a mint page for any ENS name.
- `/launch` is the owner console: checks the wrapped name, burns `CANNOT_UNWRAP`, approves Subdrop as an operator, then launches a new token or configures an existing one with price, reward, and cap. Shows the live drop with a pause toggle.
- `/mint/$name` is the public mint page: shows price, reward, remaining, and parent expiry, checks label availability as you type, and mints.

All reads go straight to the chain through viem. Wallet access uses the injected EIP-1193 provider. There is no server state.

## Contract addresses

`src/lib/chains.ts` holds the Subdrop and NameWrapper addresses per chain. Subdrop is zero until it is deployed on that chain, and the pages say so. Set the address after deploying the contract.

## Scripts

```
vp run dev       # vite dev server with the Workers runtime
vp run build     # vite build, outputs dist/client and dist/server
vp run deploy    # build, then wrangler deploy from dist/server/wrangler.json
vp run types     # wrangler types
```

The route tree is generated into `src/generated/routeTree.gen.ts`, which the repo lint and format ignore.
