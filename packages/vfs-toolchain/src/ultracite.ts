import { defineCommand } from "just-bash/browser";

const USAGE = `Usage: ultracite <check|fix> [options] [paths...]

  check   oxfmt --check, then oxlint
  fix     oxlint --fix, then oxfmt --write (--unsafe: oxlint --fix-dangerously)

Other options (--type-aware, --type-check, --quiet, ...) go to oxlint, as with ultracite.
`;

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * `ultracite check|fix` for the oxlint provider, as ultracite runs it: both tools always run, and
 * the command fails if either does. Here the tools are the virtual `oxlint` and `oxfmt` commands,
 * run in the same shell.
 */
export const ultraciteCommand = defineCommand("ultracite", async (args, ctx) => {
  const [subcommand, ...rest] = args;
  if (subcommand !== "check" && subcommand !== "fix") {
    return {
      stdout: "",
      stderr: USAGE,
      exitCode: subcommand === undefined || subcommand === "--help" ? 0 : 2,
    };
  }
  if (!ctx.exec) {
    return { stdout: "", stderr: "ultracite: this shell cannot run subcommands\n", exitCode: 1 };
  }
  const flags = rest.filter((arg) => arg.startsWith("-") && arg !== "--unsafe");
  const paths = rest.filter((arg) => !arg.startsWith("-"));
  const targets = (paths.length > 0 ? paths : ["."]).map(quote).join(" ");
  const oxlintFlags = flags.map(quote).join(" ");
  const steps =
    subcommand === "fix"
      ? [
          `oxlint ${rest.includes("--unsafe") ? "--fix-dangerously" : "--fix"} ${oxlintFlags} ${targets}`,
          `oxfmt --write --no-error-on-unmatched-pattern ${targets}`,
        ]
      : [
          `oxfmt --check --no-error-on-unmatched-pattern ${targets}`,
          `oxlint ${oxlintFlags} ${targets}`,
        ];

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const step of steps) {
    const result = await ctx.exec(step, { cwd: ctx.cwd });
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) {
      exitCode = 1;
    }
  }
  return { stdout, stderr, exitCode };
});
