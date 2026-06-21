import type { CodeMigration } from '../../migrate';
import { migration as githubActionsToolset } from './015_github_actions_toolset';

/**
 * Registry of **code migrations** — schema/data migrations whose data transform
 * needs application-side logic that SQL can't express (e.g. re-encrypting
 * master-key-encrypted secrets, parsing a bespoke encoding). Each is a real TS
 * module, so `bun build --compile` embeds it into the binary via the static
 * import below — the same module-graph mechanism the SQL bundle relies on, but
 * with no serialization (a function can't travel through JSON).
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
 *
 * `loadMigrations()` in `startup.ts` merges this with the SQL migrations into a
 * single ordered `Record<string, Migration>` the runner applies.
 */
export const codeMigrations: Record<string, CodeMigration> = {
	'015_github_actions_toolset': githubActionsToolset,
};
