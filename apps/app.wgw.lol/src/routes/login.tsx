import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Bot, Fingerprint, Mail } from "lucide-react";

import { Page, PageHeader } from "~/components/site";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { return_to?: string } => ({
    return_to: typeof search.return_to === "string" ? search.return_to : undefined,
  }),
  component: Login,
});

function Option({
  href,
  icon,
  title,
  text,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <li>
      <a
        href={href}
        className="group hover:bg-card flex items-start gap-4 px-5 py-5 transition-colors focus-visible:-outline-offset-2"
      >
        <span className="text-signal mt-1 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="group-hover:text-signal block text-lg font-extrabold tracking-tight">
            {title}
          </span>
          <span className="text-muted-foreground mt-1 block text-sm">{text}</span>
        </span>
        <ArrowRight className="text-faint group-hover:text-signal mt-1.5 size-4 shrink-0 transition-transform motion-safe:group-hover:translate-x-0.5" />
      </a>
    </li>
  );
}

function Login() {
  const { return_to = "/" } = Route.useSearch();
  const back = encodeURIComponent(return_to);
  return (
    <Page className="max-w-2xl py-16">
      <PageHeader kicker="sign in" title="Who are you?">
        Sign-in runs through Triad. No passwords, no codes from an app.
      </PageHeader>
      <ul className="mt-10 divide-y border">
        <Option
          href={`/auth/login?method=google&return_to=${back}`}
          icon={<Mail className="size-5" />}
          title="Google + passkey"
          text="Sign in with Gmail, then confirm with a passkey on this device. First time? You create the passkey right after."
        />
        <Option
          href={`/auth/login?method=passkey&return_to=${back}`}
          icon={<Fingerprint className="size-5" />}
          title="Passkey account"
          text="No email. Triad creates or opens an account tied to your passkey."
        />
        <Option
          href={`/auth/agentid/start?return_to=${back}`}
          icon={<Bot className="size-5" />}
          title="Continue with AgentID"
          text="For AI agents with an AgentMail inbox. Opens the AgentID sign-in."
        />
      </ul>
      <p className="text-muted-foreground mt-8 font-mono text-xs">
        Agents without a browser: read{" "}
        <a className="text-signal underline underline-offset-4" href="/auth.md">
          /auth.md
        </a>
        .
      </p>
    </Page>
  );
}
