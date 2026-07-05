# thoth-opendesign-runtime

Self-contained **headless** runtime bundles of [open-design](https://github.com/nexu-io/open-design)
(`nexu-io/open-design`, Apache-2.0), built for **thoth**'s browser feature library.

thoth embeds open-design as a browser feature module. Instead of depending on a dev checkout — whose
native-module ABI (`better-sqlite3`, `node-pty`) drifts with whatever Node built it — thoth downloads a
self-contained runtime from this repo's **Releases** and unpacks it into a sandbox
(`<userData>/opendesign-runtime/`). No system Node, no build toolchain, no ABI drift on the user's machine.

## What's in a bundle

Each per-platform `.tar.gz` unpacks to:

```
apps/daemon/   open-design `od` daemon: dist + bin + flattened node_modules
               (pnpm deploy --prod; @open-design/* workspace deps inlined; better-sqlite3 + node-pty
               prebuilt natives; no sharp — that's web-only)
apps/web/out/  Next.js static export (served by the daemon via express.static — no Next server process)
node/bin/node  official nodejs.org static Node (relocatable; ABI-matched to the prebuilt natives)
manifest.json  { version, platform, arch, node, builtAt }
```

The layout is **load-bearing**: the daemon must live at `apps/daemon/` so open-design's
`resolveProjectRoot(dist)` resolves `<root>/apps/web/out` and serves the web UI.

Run it:

```
node/bin/node apps/daemon/bin/od.mjs daemon start --serve-web --no-open --host 127.0.0.1 --port 7456
# → GET /api/health {"ok":true,...}   |   GET / → 200 (Open Design web UI)
```

## Releases

Tag `od-runtime-vX.Y.Z` wraps open-design `open-design-vX.Y.Z`. Assets are named
`opendesign-runtime-X.Y.Z-<platform>-<arch>.tar.gz`.

| platform | arch | status |
|---|---|---|
| darwin | x64 | ✅ |
| darwin | arm64 | ⏳ CI |
| linux | x64 | ⏳ CI |
| win32 | x64 | ❌ TODO (producer needs `.zip` node extraction) |

thoth matches its own `process.platform`/`process.arch` to pick the asset.

## Build

```
node build-opendesign-runtime.mjs --repo <open-design checkout> --out <dir> [--platform … --arch … --node vX.Y.Z]
```

Requires **Node 24** + **corepack pnpm@10.33.2** (open-design pins these). `--repo` must have
`apps/web/out` already built (`pnpm --filter @open-design/web build`). One platform per run.

`.github/workflows/build-release.yml` runs the matrix on GitHub-hosted runners and publishes the release.

## License / attribution

This repo's build scripts: MIT. The **bundles** redistribute:
- [open-design](https://github.com/nexu-io/open-design) — Apache-2.0 (see `LICENSE-open-design`)
- its npm dependencies (MIT / BSD / ISC / Apache-2.0)
- [Node.js](https://nodejs.org) — MIT

open-design already publicly distributes these same components in its own Apache-2.0 releases; this repo
re-hosts a headless subset for thoth's consumption.
