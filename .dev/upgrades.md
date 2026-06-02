# Upgrades, release binaries, and migration safety

How Hezo ships new versions, how the single binary stays self-contained, how
the running instance learns about updates, and how the database is protected
across migrations.

## Release flow

Releases run as a PR flow (see `.github/workflows/`):

1. **`release.yml`** (manual dispatch) computes the next version from
   Conventional Commits, bumps the per-package `package.json` versions, updates
   `CHANGELOG.md`, and opens a `release/<version>` PR.
2. Merging that PR fires **`release-publish.yml`**, which tags the merge commit
   (plain semver, no `v` prefix), builds the cross-platform binaries
   (`bun run build:release`), and publishes a GitHub Release with the
   binaries + `SHA256SUMS` attached.

## Building the binaries

`bun run build:release` (→ `scripts/build.ts --release`) cross-compiles every
supported platform from a single host (Bun cross-compiles all targets):

| Asset | Target |
|---|---|
| `hezo-linux-x64` | `bun-linux-x64` |
| `hezo-linux-arm64` | `bun-linux-arm64` |
| `hezo-windows-x64.exe` | `bun-windows-x64` |
| `hezo-darwin-x64` | `bun-darwin-x64` |
| `hezo-darwin-arm64` | `bun-darwin-arm64` |

Plus a `SHA256SUMS` manifest (`sha256sum -c` compatible). `bun run build:compile`
builds just the current platform to `dist/hezo` for local testing.

### Everything is embedded, served from memory

`bun build --compile` only embeds what's reachable through the module graph —
**not** files read at runtime via `new URL(..., import.meta.url)` or `readFile`
(those resolve to `/$bunfs/...` and ENOENT). So each embeddable asset is pulled
in through the graph and served from memory; the binary touches no sibling files:

- **Migrations** — `scripts/bundle-migrations.ts` writes a plain
  `{ filename: sql }` JSON map; `db/migrate.ts` pulls it in with a literal
  dynamic `import('./migrations-bundle.json')` and runs it straight from memory.
- **Agent roles** — same pattern in `db/agent-roles.ts` (`agents-bundle.json`).
- **Frontend** — `scripts/bundle-static.ts` packs `packages/web/dist` into
  `static-bundle.json` (path → base64); `startup.ts` serves it from an in-memory
  map. No temp-dir extraction.
- **PGlite runtime** — `scripts/bundle-pglite.ts` copies `postgres.wasm`,
  `postgres.data`, and `vector.tar.gz` into `src/generated/pglite/`;
  `db/pglite-assets.ts` embeds them (`import ... with { type: 'file' }`),
  compiles the WASM, and feeds PGlite `wasmModule` + `fsBundle` from memory. The
  one exception is the pgvector bundle: PGlite's extension loader reads its
  `bundlePath` via `fs`, so that single ~330 KB tarball is extracted once to
  `<dataDir>/.pglite/vector.tar.gz`.

In dev (`bun run`) none of the generated bundles exist; every loader catches the
missing import and falls back to the filesystem / `node_modules`, so dev is
unchanged.

### Version

The version is injected at compile time via
`bun build --define process.env.HEZO_VERSION="<v>"` (read from the server
package.json). `src/version.ts` exposes `HEZO_VERSION`; in dev the define is
absent and it reads the package.json off disk. It's surfaced at `/api/status`.

### Known limitations

- **Semantic search is unavailable in the standalone binary.** The embedding
  model (`@huggingface/transformers` → `onnxruntime-node`) is a native addon
  that can't be embedded and whose platform-specific `require` breaks
  cross-compilation, so it's marked `--external`. Its loader fails soft (guarded
  dynamic import), so the rest of the app is unaffected. Running from source
  (`bun run`) still has full semantic search.
- **macOS binaries are unsigned / un-notarized** (built on Linux). Gatekeeper
  quarantines them on download; clear it with
  `xattr -d com.apple.quarantine ./hezo-darwin-*`. Code signing is out of scope
  pre-v1.

## Update notifications

The running instance learns about new releases and prompts the user:

- **Server:** `GET /api/updates/latest` queries the GitHub Releases API for
  `hezo-ai/hezo`, compares the latest tag against `HEZO_VERSION`, and returns
  `{ current, latest, updateAvailable, url }`. The result is cached ~1h and
  **fails soft** (no network / rate limit → `updateAvailable: false`).
- **Web:** a dismissible "update available" banner (`components/update-banner.tsx`)
  links to the GitHub Release to download. Dismissal is remembered per-version.

### Replacing a running binary (operator's manual upgrade)

The banner links to the download; swapping the binary is a manual step today.
The platform mechanics, for reference / a future in-place updater:

- **POSIX (Linux/macOS):** a running executable is held by inode, so you can
  atomically `rename` a freshly downloaded binary over `process.execPath` while
  the old process keeps running on the old inode. The new version takes effect
  on the next launch. No need to stop first to replace the file — only to run
  the new one.
- **Windows:** a running `.exe` can't be overwritten or deleted, but it *can* be
  renamed. The pattern is: rename the current `hezo.exe` → `hezo.old.exe`, move
  the new binary into place, relaunch, then delete `hezo.old.exe` on next start.

The data directory (`~/.hezo`) is independent of the binary, so data survives a
swap.

## Migration safety: pre-migration backup + restore

The DB is **PGlite** (embedded Postgres) — the "database file" is the
`~/.hezo/pgdata/` directory. Migrations are forward-only and run on every
startup (tracked in `_migrations` by filename + SHA-256 checksum).

**Before applying pending migrations to an already-initialized instance**
(`startup.ts` → `runAvailableMigrations`):

1. Compute the pending set (bundled filenames not in `_migrations`).
2. If there are pending migrations **and** the instance already has applied
   migrations (i.e. a real upgrade, not a fresh DB), snapshot the database with
   PGlite's `dumpDataDir('gzip')` to
   `<dataDir>/backups/pgdata-<ISO>-pre-<version>.tar.gz` (+ a sidecar `.json`
   recording the version and pending list). The last 5 snapshots are kept.
   `dumpDataDir` gives a consistent snapshot of the open DB — safer than copying
   a live `pgdata` directory.
3. If the backup fails, migrations are aborted (don't migrate without a safety
   net). If a migration fails, the error names the backup directory and the
   restore command.

**Recovery (manual downgrade):**

```
hezo restore <dataDir>/backups/pgdata-<...>.tar.gz [--data-dir <dir>]
```

This wipes `pgdata` and reloads the snapshot (PGlite `loadDataDir`), then exits.
Run the previous Hezo version against the restored data dir. The restored DB
keeps its original master key.
