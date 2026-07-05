/**
 * Fatal, operator-actionable database conditions. Each carries a human-readable
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

/**
 * The external database (`--database-url` / `HEZO_DATABASE_URL`) could not be
 * used: unreachable, incompatible version, failed preflight, or an invalid
 * connection string. Messages must carry operator guidance and NEVER the raw
 * connection string (credentials) — pass pre-redacted text only.
 */
export class ExternalDbError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'ExternalDbError';
	}
}

/**
 * A logical backup records migrations this binary does not know — it was
 * taken by a newer Hezo. Restoring it would produce a schema the binary
 * can't run, so refuse and ask the operator to upgrade first.
 */
export class BackupNewerThanAppError extends Error {
	constructor(readonly unknownMigrations: string[]) {
		super(
			`This backup was taken by a newer version of Hezo. ` +
				`It records migration(s) this binary does not recognize: ` +
				`${unknownMigrations.join(', ')}. ` +
				`Upgrade Hezo to at least the version that created the backup, then restore.`,
		);
		this.name = 'BackupNewerThanAppError';
	}
}

/** A restore precondition failed (non-empty target, format mismatch, …). The message carries the guidance. */
export class RestorePreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RestorePreconditionError';
	}
}

/**
 * A pending migration failed while being applied IN PLACE to the external
 * database. Each migration runs in its own transaction, so the failed one
 * rolled back and everything applied before it remains committed — a re-run
 * after fixing the cause resumes from the failed migration.
 */
export class ExternalMigrationFailedError extends Error {
	constructor(
		readonly pending: string[],
		readonly cause: unknown,
	) {
		const causeMsg = cause instanceof Error ? cause.message : String(cause);
		super(
			`Database migration failed while applying pending migration(s) (${pending.join(', ')}) ` +
				`to the external database. Migrations run one transaction each, so the failed ` +
				`migration rolled back and previously applied ones remain committed. Fix the cause ` +
				`(or restore your database provider's backup) and start Hezo again to resume. ` +
				`(cause: ${causeMsg})`,
		);
		this.name = 'ExternalMigrationFailedError';
	}
}
