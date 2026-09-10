import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button, Eyebrow, ExternalLink, Ledger, inputClass } from "../components/ui";
import { chainConfigs, isDeployed } from "../lib/chains";
import { parseName } from "../lib/ens";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const parsed = parseName(input);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed) {
      return;
    }

    void navigate({ to: "/mint/$name", params: { name: parsed.name } });
  };

  return (
    <main className="mx-auto max-w-5xl px-6">
      <section className="grid gap-10 py-20 md:grid-cols-[3fr_2fr] md:gap-16">
        <div>
          <Eyebrow>ENS subnames · mint to earn</Eyebrow>
          <h1 className="mt-4 text-5xl md:text-7xl">
            MINT A NAME.
            <br />
            GET THE TOKEN.
          </h1>
          <p className="mt-6 max-w-xl text-muted">
            A name owner funds a token reward once. Anyone who mints a subname under it pays the
            price and receives the reward in the same transaction. The owner keeps the name and the
            treasury.
          </p>
        </div>

        <form onSubmit={onSubmit} className="self-end border border-line bg-surface p-5">
          <label className="block text-xs uppercase tracking-[0.15em] text-muted" htmlFor="name">
            Find a drop
          </label>
          <input
            id="name"
            className={`${inputClass} mt-2`}
            placeholder="apple1.eth"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-xs text-muted">
              {input.length > 0 && !parsed ? "Not a valid ENS name." : " "}
            </span>
            <Button type="submit" disabled={!parsed}>
              Open mint page
            </Button>
          </div>
        </form>
      </section>

      <section className="py-12">
        <h2 className="text-3xl">HOW IT WORKS.</h2>
        <div className="mt-6">
          <Ledger
            rows={[
              {
                label: "Owner",
                value: "Wraps the name, approves Subdrop, sets price and reward.",
                note: "Either launch a fresh fixed-supply token or point at one you already hold and approve a budget.",
              },
              {
                label: "Minter",
                value: "Pays the price, gets the subname and the reward in one transaction.",
                note: "The subname resolves to the minter's wallet and cannot be taken back by the parent.",
              },
              {
                label: "Control",
                value: "Cut the allowance, pause, or set a cap, and minting stops.",
                note: "Subdrop never holds the name or the tokens. It only moves them during a mint.",
              },
            ]}
          />
        </div>
        <p className="mt-6 text-sm text-muted">
          Own a name?{" "}
          <Link to="/launch" className="text-ink underline underline-offset-4">
            Launch a drop
          </Link>
          .
        </p>
      </section>

      <section className="py-12">
        <h2 className="text-3xl">DEPLOYMENTS.</h2>
        <div className="mt-6">
          <Ledger
            rows={Object.values(chainConfigs).map((config) => ({
              label: config.chain.name,
              value: isDeployed(config) ? (
                <ExternalLink href={`${config.explorer}/address/${config.subdrop}`}>
                  {config.subdrop}
                </ExternalLink>
              ) : (
                "Not deployed yet."
              ),
              note: `NameWrapper ${config.nameWrapper}`,
            }))}
          />
        </div>
      </section>
    </main>
  );
}
