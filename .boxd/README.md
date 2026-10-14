# CI on boxd

Monarch's CI runs on [boxd](https://docs.boxd.sh/use-cases/ci-runners) machines. GitHub sends the event and shows the result. One boxd machine, `monarch-ci`, holds the automation in `ci.run.ts`. For every pull request and every push to `master` it restores a fresh isolated machine from the snapshot of master's last green run, checks out the commit, and runs the jobs in `ci.json` in order. Each job reports its own check run, `monarch-ci/check`, `monarch-ci/test`, `monarch-ci/test-solidity`, and `monarch-ci/build`, after `monarch-ci/setup` for the restore, checkout, and install. A variant that posts one check for the whole run is kept as `ci.run-disabled.ts`. A green run on `master` saves its machine as the next snapshot, so the next run starts with that commit's `node_modules`, pnpm store, and turbo cache already on disk.

A green run's machine is deleted when the run ends. A failed run's machine is kept at least a day, so you can get into the failed state. See [When a run fails](#when-a-run-fails).

The turbo cache in the snapshot is CI's own. Laptops keep their local caches.

Once a night the `cold` schedule runs master's head from a clean tree with `TURBO_FORCE=true`, to catch what a warm snapshot hides. It never promotes. The same schedule deletes failed machines older than a day.

Every completed `monarch-ci/*` check has a Re-run this check button on its page in the Checks tab. It runs only that job again, on a fresh machine with the commit checked out, so a failed job can be rerun after its machine is gone. Re-run all checks on the pull request runs everything again.

## Setup, once

The boxd GitHub App must be installed on the `tunnckoCoreHQ` organization with access to this repository. An org admin does that from the GitHub App card on the console's Integrations page. The CLI has no command for the App itself. Once installed, `boxd manage integrations` lists it under the shared connections.

Create the machine. boxd leaves auto-suspend off by default, so without the two timeouts the machine would stay running, and billed, for four idle hours after every run. With them it drops to standby a minute after a run and hibernates five minutes after, to disk cost only. A GitHub event wakes it either way, in under 100 ms.

```sh
boxd machine new monarch-ci --vcpu 2 --auto-suspend-timeout 60 --auto-hibernate-timeout 300
boxd connect monarch-ci
```

Inside the machine, install the toolchain. The automation runs every step with `bash -lc`, a login shell, and Ubuntu's `.bashrc` returns early for non-interactive shells. So the installers' `.bashrc` additions do nothing for CI, and `PATH` goes in `~/.profile` instead.

```sh
curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
curl -fsSL https://foundry.paradigm.xyz | bash
cat >> ~/.profile <<'EOF'
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$HOME/.cargo/bin:$HOME/.wasmtime/bin:$PNPM_HOME/bin:$HOME/.local/share/fnm:$HOME/.foundry/bin:$PATH"
eval "$(fnm env)"
EOF
source ~/.profile
foundryup --install v1.7.1
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile default --no-modify-path
rustup target add wasm32-wasip1
# the crates' e2e suite runs the wasm32-wasip1 build under wasmtime, the version RWX pins
curl -fsSL https://wasmtime.dev/install.sh | bash -s -- --version v44.0.1

mkdir -p ~/work && cd ~/work
git clone https://github.com/tunnckoCoreHQ/monarch.git && cd monarch
fnm install && fnm default "$(cat .node-version)"
# pnpm's own installer, at the version in packageManager
curl -fsSL https://get.pnpm.io/install.sh |
  PNPM_VERSION="$(node -p "require('./package.json').packageManager.slice(5)")" sh -
CI=1 pnpm install --frozen-lockfile
forge build --root solidity/template
pnpm exec turbo run check test build          # warms the turbo cache
exit
```

Back on the laptop, save the first snapshot:

```sh
boxd snapshots save monarch-ci monarch-ci
```

Then put the two files on the machine and start the automation. It stays on `monarch-ci`, which suspends and then hibernates between events. boxd wakes it when GitHub sends one.

```sh
boxd machine exec monarch-ci -- mkdir -p /home/boxd/ci
boxd machine cp .boxd/ci.json monarch-ci:/home/boxd/ci/ci.json
boxd machine cp .boxd/ci.run.ts monarch-ci:/home/boxd/ci/ci.run.ts
boxd machine exec monarch-ci -- 'cd /home/boxd/ci && run ci.run.ts'
```

## Changing the CI

`ci.json` and `ci.run.ts` live in this repo, but the automation reads its own copies on `monarch-ci`. After editing either one, copy it over and start the file again. Starting the same file again replaces the running automation in place, which kills a run in progress. The new instance then cancels that run's checks on GitHub and deletes its machine, and Re-run on a cancelled check runs it again. Pushing the change to this repo also triggers a run, so deploy first, push second.

```sh
boxd machine cp .boxd/ci.json monarch-ci:/home/boxd/ci/ci.json
boxd machine cp .boxd/ci.run.ts monarch-ci:/home/boxd/ci/ci.run.ts
boxd machine exec monarch-ci -- 'cd /home/boxd/ci && run ci.run.ts'
```

## Watching it

```sh
boxd machine exec monarch-ci -- run jobs             # the automation and its state
boxd machine exec monarch-ci -- run logs <id> -f     # its live log, one line per step
boxd machine list                                    # run machines are named ci-<sha>-<n>
boxd snapshots list                                  # monarch-ci, a new version per green master run
```

On GitHub, the Details link of a `monarch-ci/*` check opens the check's own page. It shows the step table, the failing step's last 80 lines, and the machine to connect to. There is no link to anything outside GitHub.

## When a run fails

The failed check's summary names the run's machine, for example `ci-3f1c9ab-41237`. The machine hibernates five minutes after the run, so it costs disk only. The nightly cold run deletes the failed machines that are older than a day, so a machine lives between one and two days.

```sh
boxd connect ci-3f1c9ab-41237
```

Inside, the repo is at `/home/boxd/work/monarch` with the failed commit checked out, and the whole run's output is in `/home/boxd/ci.log`, one `=== step` header per step. The log holds only this run. It is emptied when a run starts, so the one in the snapshot never grows. The toolchain, `node_modules`, and the turbo cache are the ones the run used. Rerun the failing command there.

Delete the machine when done rather than waiting for the sweep. Every machine counts toward the organization's cap.

```sh
boxd machine remove ci-3f1c9ab-41237 -y
```
