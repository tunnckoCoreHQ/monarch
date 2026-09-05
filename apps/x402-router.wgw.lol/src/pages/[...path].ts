import { routerApi } from "../router-api";

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ request }) => routerApi(request);
export const POST: APIRoute = ({ request }) => routerApi(request);
export const OPTIONS: APIRoute = ({ request }) => routerApi(request);
