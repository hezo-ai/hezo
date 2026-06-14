/**
 * Fatal, operator-actionable migration conditions. Both carry a human-readable
 * `.message` that the process entry point prints verbatim before exiting — same
 * shape as `PgDataCorruptError` (see `src/db/client.ts`).
 */

/**
 * The data directory was migrated by a newer Hezo version than the running
 * binary (downgrade). The binary can't safely run against a schema it doesn't
 * understand, so it must exit and ask the operator to upgrade.
 */
export class DbNewerThanAppError extends Error {
	constructor(readonly unknownMigrations: string[]) {
		super(
			`This data directory was migrated by a newer version of Hezo. ` +
				`It contains migration(s) this binary does not recognize: ` +
				`${unknownMigrations.join(', ')}. ` +
				`Upgrade Hezo to the latest version to use this database.`,
		);
		this.name = 'DbNewerThanAppError';
	}
}

/**
 * A pending migration failed while being applied to a *temporary copy* of the
 * database. The live data directory was left completely untouched, so the
 * operator can downgrade to the previous Hezo version and start again — it will
 * pick up the existing database exactly as it was, no restore needed.
 */
export class MigrationFailedError extends Error {
	constructor(
		readonly pending: string[],
		readonly dataDir: string,
		readonly cause: unknown,
	) {
		const causeMsg = cause instanceof Error ? cause.message : String(cause);
		super(
			`Database migration failed while applying ${pending.join(', ')} to a temporary copy. ` +
				`Your existing database at ${dataDir} was left untouched. ` +
				`Downgrade to the previous Hezo version and start again — it will use your ` +
				`existing database as-is. (cause: ${causeMsg})`,
		);
		this.name = 'MigrationFailedError';
	}
}
