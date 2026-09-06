import { fetch as routerFetch } from "@tunnckocore/x402-router";

export function routerApi(request: Request): Promise<Response> {
  return routerFetch(request);
}
