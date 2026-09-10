import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Subdrop · mint an ENS subname, get the token" },
      {
        name: "description",
        content:
          "Mint-to-earn for ENS names. The owner funds a token reward once; every subname mint pays it out in the same transaction.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        <header className="border-b border-line">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4 text-xs uppercase tracking-[0.15em]">
            <Link to="/" className="font-bold text-ink">
              Subdrop
            </Link>
            <div className="flex gap-6">
              <Link
                to="/"
                className="text-muted hover:text-ink"
                activeProps={{ className: "text-ink" }}
                activeOptions={{ exact: true }}
              >
                Mint
              </Link>
              <Link
                to="/launch"
                className="text-muted hover:text-ink"
                activeProps={{ className: "text-ink" }}
              >
                Launch a drop
              </Link>
            </div>
          </nav>
        </header>
        {children}
        <footer className="mx-auto max-w-5xl border-t border-line px-6 py-8 text-xs text-muted">
          Contracts live in{" "}
          <a
            className="underline underline-offset-4"
            href="https://github.com/tunnckoCoreHQ/monarch/tree/master/solidity/subdrop"
            target="_blank"
            rel="noreferrer"
          >
            tunnckoCoreHQ/monarch
          </a>
          . Works with wrapped ENS names on Ethereum mainnet and Sepolia.
        </footer>
        <Scripts />
      </body>
    </html>
  );
}
