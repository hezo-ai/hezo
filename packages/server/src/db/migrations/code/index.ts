import type { CodeMigration } from '../../migrate';

/**
 * Registry of **code migrations** — schema/data migrations whose data transform
 * needs application-side logic that SQL can't express (e.g. re-encrypting
 * master-key-encrypted secrets, parsing a bespoke encoding). Each is a real TS
 * module, so `bun build --compile` embeds it into the binary via a static import
 * here — the same module-graph mechanism the SQL bundle relies on, but with no
 * serialization (a function can't travel through JSON).
 *
 * The registry is currently empty: at the v1.0 launch the historical migrations
 * were collapsed into the fresh `001_initial_schema.sql` baseline, and no code
 * migration has landed since.
 *
 * To add one:
 *   1. Create `src/db/migrations/code/NNN_description.ts` exporting a
 *      `CodeMigration` (`{ run, checksum }`). Pick the next free `NNN` across
 *      BOTH `migrations/*.sql` and this directory — the numbers share one
 *      ordered sequence.
 *   2. Import it here and add it to `codeMigrations` keyed by its full name
 *      (`'NNN_description'`, no extension) so it sorts correctly against the
 *      SQL migrations.
 *   3. Set an explicit `checksum` on the migration (a short stable string) so a
 *      rebuild can't shift it.
 *   4. Ship a data-preservation test (`test/migrate-NNN-description.test.ts`)
 *      using `createDataPreservationHarness()` — see AGENTS.md › Database migrations.
 *
 * `loadMigrations()` in `startup.ts` merges this with the SQL migrations into a
 * single ordered `Record<string, Migration>` the runner applies.
 */
export const codeMigrations: Record<string, CodeMigration> = {};
