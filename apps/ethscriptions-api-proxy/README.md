# ethscriptions-api-proxy

The Calldata Ethscriptions API at [api.calldata.space](https://api.calldata.space). It is a Cloudflare Worker that runs [`@tunnckocore/ethscriptions-server`](../../packages/ethscriptions-server) for Ethereum mainnet and Sepolia.

| URL                            | Network |
| ------------------------------ | ------- |
| `api.calldata.space/*`         | mainnet |
| `api.calldata.space/mainnet/*` | mainnet |
| `api.calldata.space/sepolia/*` | Sepolia |
| `sepolia-api.calldata.space/*` | Sepolia |

The Worker stores successful GET responses in the Workers cache for the `s-maxage` that the server sets in `cdn-cache-control`. Errors and 404 responses are never cached. `/llms.txt` lists the endpoints.

Run `pnpm --filter ethscriptions-api-proxy run dev` for a local Worker. A merge to `master` deploys it with `deploy:nightly`.
