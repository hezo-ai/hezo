import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresDb } from '../src/db/drivers/postgres';
import { ExternalDbError } from '../src/db/migrate-errors';
import { openDatabase } from '../src/db/open';
import { setLogLevel } from '../src/logger';

// openDatabase's external-Postgres path (scheme validation, connect retries,
// pool sizing, preflight) can't run against a real server in this suite, so the
// driver is mocked at the module boundary — everything in src/db/open.ts and
// src/db/postgres-preflight.ts still executes for real.
vi.mock('../src/db/drivers/postgres', () => ({
	PostgresDb: { connect: vi.fn() },
}));

const connectMock = vi.mocked(PostgresDb.connect);

const URL_WITH_SECRET = 'postgres://hezo:sekretpw@db.internal:5432/hezo';

interface FakeQueryResult {
	rows: Record<string, unknown>[];
}

function fakePostgresDb(opts?: {
	serverVersionNum?: number;
	serverVersion?: string;
	uuidError?: Error;
}): PostgresDb & { query: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
	const num = opts?.serverVersionNum ?? 160_004;
	const version = opts?.serverVersion ?? '16.4';
	const query = vi.fn(async (sql: string): Promise<FakeQueryResult> => {
		if (sql.includes('server_version_num')) return { rows: [{ num, version }] };
		if (sql.includes('gen_random_uuid') && opts?.uuidError) throw opts.uuidError;
		return { rows: [] };
	});
	const close = vi.fn(async () => {});
	return { kind: 'postgres', query, close } as unknown as PostgresDb & {
		query: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
}

describe('openDatabase (external Postgres path)', () => {
	let prevPoolSize: string | undefined;

	beforeEach(() => {
		prevPoolSize = process.env.HEZO_DATABASE_POOL_SIZE;
		delete process.env.HEZO_DATABASE_POOL_SIZE;
		connectMock.mockReset();
	});

	afterEach(() => {
		if (prevPoolSize === undefined) delete process.env.HEZO_DATABASE_POOL_SIZE;
		else process.env.HEZO_DATABASE_POOL_SIZE = prevPoolSize;
		vi.useRealTimers();
		setLogLevel('warn');
	});

	it('rejects --reset combined with an external URL before touching the network', async () => {
		await expect(
			openDatabase({ dataDir: '/unused', databaseUrl: URL_WITH_SECRET, reset: true }),
		).rejects.toThrow(/--reset applies to the embedded database only/);
		expect(connectMock).not.toHaveBeenCalled();
	});

	it('rejects a non-postgres scheme with operator guidance', async () => {
		await expect(
			openDatabase({ dataDir: '/unused', databaseUrl: 'mysql://u:p@h:3306/db' }),
		).rejects.toThrow(/must be a postgres:\/\/ or postgresql:\/\//);
		expect(connectMock).not.toHaveBeenCalled();
	});

	it('rejects an unparseable URL the same way (scheme falls back to empty)', async () => {
		await expect(openDatabase({ dataDir: '/unused', databaseUrl: 'not a url' })).rejects.toThrow(
			/must be a postgres:\/\/ or postgresql:\/\//,
		);
		expect(connectMock).not.toHaveBeenCalled();
	});

	it('connects, runs the preflight, and returns redacted external storage info', async () => {
		const db = fakePostgresDb({ serverVersionNum: 160_004, serverVersion: '16.4' });
		connectMock.mockResolvedValue(db);

		const opened = await openDatabase({ dataDir: '/unused', databaseUrl: URL_WITH_SECRET });

		expect(opened.db).toBe(db);
		expect(opened.storage.backend).toBe('external');
		expect(opened.storage.server_version).toBe('16.4');
		// The display form must never carry the raw credentials.
		expect(opened.storage.display).not.toContain('sekretpw');
		expect(opened.storage.display).not.toContain('hezo:sekretpw');
		expect(opened.storage.display).toContain('db.internal:5432');
		// No pool-size env → max undefined (driver default applies).
		expect(connectMock).toHaveBeenCalledWith({ url: URL_WITH_SECRET, max: undefined });
		// The preflight actually ran: version gate + gen_random_uuid smoke test.
		expect(db.query).toHaveBeenCalledTimes(2);
	});

	it('parses and clamps HEZO_DATABASE_POOL_SIZE (2..100, non-numeric ignored)', async () => {
		const cases: Array<[string, number | undefined]> = [
			['5', 5],
			['1', 2],
			['500', 100],
			['abc', undefined],
		];
		for (const [raw, expected] of cases) {
			connectMock.mockReset();
			connectMock.mockResolvedValue(fakePostgresDb());
			process.env.HEZO_DATABASE_POOL_SIZE = raw;
			await openDatabase({ dataDir: '/unused', databaseUrl: URL_WITH_SECRET });
			expect(connectMock, `pool size ${raw}`).toHaveBeenCalledWith({
				url: URL_WITH_SECRET,
				max: expected,
			});
		}
	});

	it('retries the connection 3 times with backoff, then throws ExternalDbError with the redacted URL', async () => {
		// The retry loop logs a warn per failed attempt — this test is explicitly
		// about that failure path, so quiet the log down to error-only.
		setLogLevel('error');
		vi.useFakeTimers();
		connectMock.mockRejectedValue(new Error('connection refused by host'));

		const p = openDatabase({ dataDir: '/unused', databaseUrl: URL_WITH_SECRET });
		// Attach the rejection expectation before advancing so the rejection is
		// never unhandled.
		const assertion = expect(p).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(ExternalDbError);
			const msg = (err as Error).message;
			expect(msg).toContain('Could not connect to the external database');
			expect(msg).toContain('connection refused by host');
			// Redacted host is shown, the secret never is.
			expect(msg).toContain('db.internal:5432');
			expect(msg).not.toContain('sekretpw');
			return true;
		});
		// Backoff is 2s then 4s between the three attempts.
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(4_000);
		await assertion;
		expect(connectMock).toHaveBeenCalledTimes(3);
	});

	it('closes the connection and rethrows when the version preflight fails', async () => {
		const db = fakePostgresDb({ serverVersionNum: 130_000, serverVersion: '13.2' });
		connectMock.mockResolvedValue(db);

		await expect(
			openDatabase({ dataDir: '/unused', databaseUrl: URL_WITH_SECRET }),
		).rejects.toThrow(/requires PostgreSQL 14 or newer/);
		expect(db.close).toHaveBeenCalledTimes(1);
	});

	it('closes the connection and rethrows when gen_random_uuid is unavailable', async () => {
		const db = fakePostgresDb({
			uuidError: new Error('function gen_random_uuid() does not exist'),
		});
		connectMock.mockResolvedValue(db);

		await expect(
			openDatabase({ dataDir: '/unused', databaseUrl: URL_WITH_SECRET }),
		).rejects.toThrow(/cannot run gen_random_uuid/);
		expect(db.close).toHaveBeenCalledTimes(1);
	});
});
