/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { Plus, SettingsIcon } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { fire, Page, PageHeader, Pending, RouteError, useMe } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { api, getMe, type Me } from "~/lib/api";
import { cn } from "~/lib/utils";

import css from "~/styles.css?url";

const NAV_LINK =
  "text-muted-foreground hover:text-foreground data-[status=active]:text-foreground relative flex h-full shrink-0 cursor-pointer items-center font-mono text-xs tracking-wider uppercase after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 data-[status=active]:after:bg-signal focus-visible:-outline-offset-2";

const TITLE = "wgw · git for agents on Cloudflare";
const DESCRIPTION = "Git hosting on Cloudflare Artifacts and Workers. CLI-first and agent-first.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      // Only the root head runs on the server. On public repository pages the Worker rewrites
      // the three og values to the repository card, in src/server/og.ts.
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:image", content: "https://app.wgw.lol/og.png" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  loader: async () => ({ me: await getMe() }),
  shellComponent: Shell,
  component: Layout,
  pendingComponent: () => (
    <Frame me={undefined}>
      <Pending />
    </Frame>
  ),
  notFoundComponent: NotFound,
  errorComponent: ({ error }) => <RootError error={error} />,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Layout() {
  const me = useMe();
  return (
    <Frame me={me}>
      <Outlet />
    </Frame>
  );
}

function RootError({ error }: { error: unknown }) {
  const me = useMe();
  return (
    <Frame me={me}>
      <RouteError error={error} />
    </Frame>
  );
}

function NotFound() {
  return (
    <Page className="py-16 md:py-24">
      <PageHeader danger kicker="error 404" title="Nothing here.">
        No page lives at this address.
      </PageHeader>
      <Button asChild size="lg" variant="outline" className="mt-8">
        <Link to="/explore">Explore public repositories</Link>
      </Button>
    </Page>
  );
}

/** The page chrome. `me` is undefined while the session is still loading. */
function Frame({ me, children }: { me: Me | null | undefined; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header me={me} />
      <main className="flex-1">{children}</main>
      <footer className="border-t">
        <div className="text-muted-foreground mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 font-mono text-xs md:flex-row md:justify-between md:gap-6">
          <p>Git in Cloudflare Artifacts. Runs on Workers, Durable Objects, D1, R2, and Queues.</p>
          <p>
            Sign-in by{" "}
            <a
              className="hover:text-foreground underline underline-offset-4"
              href="https://triad-auth-nightly.wgw.lol"
            >
              Triad
            </a>{" "}
            and passkeys.
          </p>
        </div>
      </footer>
    </div>
  );
}

const noSubscription = () => () => undefined;

function Header({ me }: { me: Me | null | undefined }) {
  const router = useRouter();
  // The server renders the shell before any route loads, so the bar waits for hydration.
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const loading = useRouterState({ select: (state) => state.isLoading }) && hydrated;
  const signedIn = me !== null && me !== undefined;

  const signOut = async () => {
    await api("/auth/logout", { method: "POST" });
    await router.invalidate();
    await router.navigate({ to: "/" });
  };

  return (
    <header className="bg-background sticky top-0 z-20 border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 px-6">
        <Link to="/" className="flex h-14 items-center gap-2 font-black tracking-tighter">
          <span className="bg-signal inline-block size-3" />
          <span className="text-xl">wgw</span>
          <span className="text-muted-foreground hidden font-mono text-xs font-normal sm:inline">
            /git
          </span>
        </Link>
        {/* Below md the nav drops to its own full-width row. The account links start at zero
            width and grow, so a long handle truncates instead of wrapping the top row. */}
        <nav
          aria-label="Site"
          className="order-last -mx-6 flex h-10 w-[calc(100%+3rem)] [scrollbar-width:none] items-stretch gap-5 overflow-x-auto border-t px-6 md:order-none md:mx-0 md:h-14 md:w-auto md:overflow-visible md:border-t-0 md:px-0"
        >
          <Link to="/explore" className={NAV_LINK}>
            Explore
          </Link>
          <a href="/skill.md" className={NAV_LINK}>
            skill.md
          </a>
          <a href="/auth.md" className={NAV_LINK}>
            auth.md
          </a>
          {signedIn ? (
            <button
              type="button"
              onClick={fire(signOut)}
              className={cn(NAV_LINK, "ml-auto md:hidden")}
            >
              Sign out
            </button>
          ) : null}
        </nav>
        <div className="flex h-14 min-w-0 grow basis-0 items-stretch justify-end gap-4">
          {me === null ? (
            <Button asChild size="sm" className="self-center">
              <Link to="/login">Sign in</Link>
            </Button>
          ) : null}
          {signedIn ? (
            <>
              <Button asChild size="sm" variant="outline" className="self-center">
                <Link to="/new">
                  <Plus />
                  New
                </Link>
              </Button>
              <Link
                to="/$owner"
                params={{ owner: me.handle }}
                activeOptions={{ exact: true }}
                className="hover:text-signal data-[status=active]:text-signal flex min-w-0 items-center gap-2 font-mono text-sm"
              >
                <span className="max-w-32 truncate sm:max-w-48">@{me.handle}</span>
                {me.kind === "agent" ? (
                  <Badge variant="violet" className="hidden sm:inline-flex">
                    agent
                  </Badge>
                ) : null}
              </Link>
              <Link to="/settings" aria-label="Settings" className={NAV_LINK}>
                <SettingsIcon className="size-4 md:hidden" />
                <span className="hidden md:inline">Settings</span>
              </Link>
              <button
                type="button"
                onClick={fire(signOut)}
                className={cn(NAV_LINK, "hidden md:flex")}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </div>
      {loading ? (
        <div aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
          <div className="bg-signal motion-safe:animate-progress h-full w-full origin-left" />
        </div>
      ) : null}
    </header>
  );
}
