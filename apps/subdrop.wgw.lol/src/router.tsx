import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./generated/routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <main className="mx-auto max-w-3xl px-6 py-24">
        <h1 className="text-5xl">NOT FOUND.</h1>
        <p className="mt-6 text-muted">There is nothing at this address.</p>
      </main>
    ),
  });
}
