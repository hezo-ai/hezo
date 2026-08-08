# Writing a database migration

The contributor guide for authoring a migration and its data-preservation test. The rules that bind before you start — never edit a shipped migration, every migration preserves data and ships a test, extend an unshipped one rather than stacking — are in `AGENTS.md`; this is the how. For how migrations fit the release and upgrade story, see `architecture.md` § 12.

Migrations are real, tracked, append-only and data-preserving. Real instances hold real user data, so a migration that drops or corrupts it is a production incident. `packages/server/migrations/001_initial_schema.sql` is the **frozen baseline** — it was collapsed to a single fresh `001` at the v1.0 launch, a one-time reset done while all deployments were reset to fresh databases; from there the append-only rule holds and `001` stays frozen.

## Before you create a file

**Check for an unshipped migration to extend.** This is the first step, not a cleanup afterwards:

```sh
git fetch origin main
for f in packages/server/migrations/*.sql; do
  git cat-file -e "origin/main:$f" 2>/dev/null || echo "UNSHIPPED: $f"
done
```

Anything printed was added by this branch and applied nowhere. If one belongs to the change you are making, **put your DDL in that file** — extend its `CREATE TABLE`, extend its backfill `SELECT`, add an `ALTER` at its end — and add your assertions to that migration's existing test file. Only when nothing comes back, or nothing related, do you add a new `NNN_description.sql` at the next free number. Never edit `001` or any file the loop did **not** print; those have shipped.

## Append-only binds on *shipped*, not on *written*

A migration that exists on `main` could have been applied to a real instance and is frozen forever. One added by the branch you are still working on has been applied nowhere, so it is ordinary unmerged code: keep editing it, and **merge sibling migrations from the same unmerged PR into one file** rather than stacking `NNN`, `NNN+1`, `NNN+2` for what is one change. Two migrations in one PR is a smell — it leaves the released history longer than the change actually was, and presents a reviewer with a two-step reshaping of a table that never existed in the intermediate shape. Merge their data-preservation tests into that migration's one test file too.

Three things survive the merge:

- **Keep each `NNN` distinct from anything on `main`.** Concurrent PRs do collide (`026`, `037`, `038` and `048` each shipped twice), which is survivable since the runner sorts by full filename so the pair applies in a stable order — but it makes the sequence harder to read, so rebase if `main` took your number.
- **The whole file runs in one transaction**, so `ALTER TYPE … ADD VALUE` cannot have its new value *used* further down the same file. State predicates in terms of pre-existing values, as `049` does.
- **A dev instance that already applied the old version will not re-apply the edited one** — it is checksummed and apply-once, so the edit is logged as a warning and skipped. Reset the local data dir, or the schema you are coding against silently lacks the change.

## Code migrations

Data transforms SQL can't express (parse/re-encode/re-encrypt with app-side logic) go in a **code migration** TS module under `packages/server/src/db/migrations/code/`, registered in that dir's `index.ts`. SQL and code migrations share one ordered `NNN_` sequence and run in the same per-migration transaction.

## How they apply

On the **embedded** backend the runner migrates a *copy* of the database (`<dataDir>/.migrate-tmp`) and atomically swaps it in on success. On failure the live `pgdata` is left untouched, so downgrading to the previous binary just works.

An **external Postgres** has no datadir to copy, so it migrates **in place** instead — per-migration transactions under a session `pg_advisory_lock` (`applyPendingMigrationsExternal`) — which is why a migration must be safe to half-apply-and-roll-back on its own.

Either way, a data dir carrying migrations the binary doesn't recognize (a downgrade) makes the server **exit** and ask the operator to upgrade.

## The data-preservation test

One file per migration, named `packages/server/test/migrate-<NNN>-<slug>.test.ts` so it is findable from the migration's number, using `createDataPreservationHarness()` (`packages/server/test/helpers/migrate.ts`). Seed representative rows at the prior schema, apply the migration through the real `runMigrations`, then assert **both** that the pre-existing data survived **and** that the migration's schema/data change took effect. Don't just assert "the migration ran".

Every shipped migration has one except the frozen `001`, which `migrate-baseline-schema.test.ts` covers instead. The runner's generic guarantees (transactional BEGIN/COMMIT/ROLLBACK, sorted ordering, apply-once checksum, copy-migrate-swap) are covered by `migrate-data-preservation.test.ts`, `migrate-runner.test.ts` and `migrate-code-steps.test.ts`. Per-migration tests are additive on top.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '099_example.sql';

describe('099_example migration', () => {
  let h: DataPreservationHarness;
  let seededId: string;

  beforeAll(async () => {
    h = await createDataPreservationHarness();
    await h.applyUpToExclusive(TARGET);          // schema at N-1
    const r = await h.db.query<{ id: string }>(  // seed representative data
      `INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
    );
    seededId = r.rows[0].id;
    await h.applyTarget(TARGET);
  });
  afterAll(() => h.close());

  it('applies the change', async () => {
    const c = await h.db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM information_schema.columns
       WHERE table_name = 'teams' AND column_name = 'new_col'`,
    );
    expect(c.rows[0].c).toBe(1);
  });

  it('preserves pre-existing rows', async () => {
    const kept = await h.db.query(`SELECT 1 FROM teams WHERE id = $1`, [seededId]);
    expect(kept.rows.length).toBe(1);
  });
});
```
