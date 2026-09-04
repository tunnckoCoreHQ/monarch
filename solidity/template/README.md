# name of the project

Template solidity project for this monorepo with foundry and deps managed by Pnpm.

<!-- details for the project -->

## Build & Testing

Project is managed by Pnpm, VitePlus, and Foundry.

From the root of the monorepo:

```
# solidity tool chain: fmt/lint/test/build/checks
vp run solidity:check

# run only glyph protocol
vp run --filter glyph-protocol fmt
vp run --filter glyph-protocol lint
vp run --filter glyph-protocol test
vp run --filter glyph-protocol build

# or just `check` it runs everything needed
vp run --filter glyph-protocol check
```

from this project's folder

```
vp run fmt
vp run lint
vp run test
vp run build

# or just
vp run check
```

## License

Apache-2.0
