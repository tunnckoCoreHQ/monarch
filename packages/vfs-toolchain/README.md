# vfs-toolchain

`ultracite fix --type-aware --type-check` on an in-memory filesystem, in Node or in a Cloudflare Worker. The tools are the real oxlint 1.86.0, oxfmt 0.71.0, and tsgolint 7.0.2003 CLIs, built for `wasm32-wasip1`. Their only filesystem is a WASI view of a [just-bash](https://www.npmjs.com/package/just-bash) VFS, so they discover configs, nested configs, `.editorconfig`, ignore files, `tsconfig.json`, and `node_modules` on the VFS the way they do on disk.

```ts
import { Bash, InMemoryFs } from "just-bash/browser";
import { toolchainCommands } from "vfs-toolchain";

const bash = new Bash({
  fs,
  cwd: "/repo",
  customCommands: toolchainCommands({ engines, evaluateConfig }),
});
await bash.exec("ultracite fix --type-aware --type-check packages/zagora");
await bash.exec("oxlint -f unix src | grep no-floating-promises | wc -l");
```

- `oxlint`, `oxfmt`, and `ultracite check|fix` are just-bash commands (`defineCommand`), so they take `ctx.fs` and `ctx.cwd` and work with pipes, redirects, and `&&`/`||`.
- Each run copies the VFS into a WASI tree (`src/wasi.ts`). Symlinks stay symlinks, which pnpm layouts need (`src/wasi-fs.ts`). The tool then runs, and the files it changed are written back.
- oxlint runs tsgolint through a host import over the same tree, so tsgolint sees oxlint's fixes, as the native child process sees them on disk.
- `oxlint.config.ts` and `oxfmt.config.ts` are evaluated by `evaluateConfig`. In a Worker that is a Dynamic Worker (`dynamicWorkerEvaluator`), given the presets they import, which `scripts/bundle-presets.ts` bundles.
- oxfmt hands markdown and HTML to Prettier (`prettier/standalone`, the version oxfmt bundles). That call is asynchronous, so it needs JSPI: workerd has it, and Node needs `--experimental-wasm-jspi`. Without JSPI, those files are skipped.

## Run it

```sh
node scripts/snapshot-zagora.ts      # packages/zagora + repo configs + type packages -> fixtures/
node scripts/bundle-presets.ts       # ultracite presets -> fixtures/presets.json
node --experimental-wasm-jspi demo.ts
node worker/dev.ts "ultracite fix --type-aware --type-check packages/zagora"   # in local workerd
```

`wasm/oxlint.wasm`, `wasm/oxfmt.wasm`, and `wasm/tsgolint.wasm` are local build artifacts, not committed:

- oxlint and oxfmt are the oxc CLIs at tag `oxlint_v1.86.0`, patched to build for `wasm32-wasip1`:
  - one thread, and sequential directory walks;
  - tsgolint and Prettier calls go through host imports;
  - JS configs are read from a host-provided file.
- tsgolint is built unchanged with `GOOS=wasip1 GOARCH=wasm`.

Tests that need the artifacts skip without them.

## Differences from native

- JS plugins (`jsPlugins`, such as ultracite's anti-slop preset) are skipped with a warning.
- The CLIs run one thread, so output says `using 1 threads`.
- oxfmt does not sort Tailwind classes, and leaves Vue and Svelte files alone.
- Memory: tsgolint grows to about 290 MB of wasm memory type-checking zagora with its tests. Workers allow 128 MB per isolate. Local workerd does not enforce that limit, and this has not been run on Cloudflare.
