import pg from 'pg';

export interface ScratchPostgres {
	/** Connection URL pointing at the freshly created scratch database. */
	url: string;
	/** Drop the scratch database (call after closing every connection to it). */
	drop(): Promise<void>;
}

/**
 * Create a throwaway database on the real Postgres that
 * `HEZO_TEST_DATABASE_URL` points at (the test-postgres CI job's postgres:16
 * service), so env-gated suites never interfere with each other or leave
 * state behind. Uses a bare `pg` client — CREATE/DROP DATABASE cannot run
 * inside transactions and shouldn't ride the app driver.
 */
export async function createScratchPostgres(prefix: string): Promise<ScratchPostgres> {
	const adminUrl = process.env.HEZO_TEST_DATABASE_URL;
	if (!adminUrl) throw new Error('createScratchPostgres requires HEZO_TEST_DATABASE_URL');

	const name = `hezo_${prefix}_${Math.random().toString(36).slice(2, 10)}`;
	const admin = new pg.Client({ connectionString: adminUrl });
	await admin.connect();
	await admin.query(`CREATE DATABASE ${name}`);
	await admin.end();

	const url = new URL(adminUrl);
	url.pathname = `/${name}`;

	return {
		url: url.toString(),
		drop: async () => {
			const drop = new pg.Client({ connectionString: adminUrl });
			await drop.connect();
			// Sever any lingering sessions first — DROP DATABASE refuses otherwise.
			await drop.query(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
				[name],
			);
			await drop.query(`DROP DATABASE IF EXISTS ${name}`);
			await drop.end();
		},
	};
}
