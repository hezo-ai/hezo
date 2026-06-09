import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRecoverablePgInitError, openPersistentDb, PgDataCorruptError } from '../src/db/client';

describe('isRecoverablePgInitError', () => {
	it('matches PGlite WASM init failures', () => {
		expect(
			isRecoverablePgInitError(
				new Error('Unreachable code should not be executed (evaluating this.mod._pg_initdb())'),
			),
		).toBe(true);
	});

	it('matches WASM Aborted() runtime errors', () => {
		expect(
			isRecoverablePgInitError(
				new Error('RuntimeError: Aborted(). Build with -sASSERTIONS for more info.'),
			),
		).toBe(true);
	});

	it('matches bare Aborted() strings', () => {
		expect(isRecoverablePgInitError(new Error('Aborted()'))).toBe(true);
	});

	it('matches any WebAssembly.RuntimeError regardless of message', () => {
		expect(isRecoverablePgInitError(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
	});

	it('ignores unrelated errors', () => {
		expect(isRecoverablePgInitError(new Error('connection refused'))).toBe(false);
	});
});

describe('openPersistentDb', () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-pgdata-test-'));
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	it('throws PgDataCorruptError when pgdata is corrupt — never auto-resets', async () => {
		const pgDataPath = join(dataDir, 'pgdata');
		mkdirSync(pgDataPath, { recursive: true });
		writeFileSync(join(pgDataPath, 'PG_VERSION'), 'garbage-not-a-real-pg-version');
		writeFileSync(join(pgDataPath, 'postmaster.pid'), '99999\n/tmp/pglite\n');

		await expect(openPersistentDb(dataDir)).rejects.toBeInstanceOf(PgDataCorruptError);

		const entries = readdirSync(dataDir);
		expect(entries).toContain('pgdata');
		expect(entries.filter((name) => name.startsWith('pgdata.corrupt.')).length).toBe(0);

		try {
			await openPersistentDb(dataDir);
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(PgDataCorruptError);
			const corruptErr = err as PgDataCorruptError;
			expect(corruptErr.message).toContain(pgDataPath);
			expect(corruptErr.message).toContain('--reset');
			expect(corruptErr.message).toContain('pgdata.corrupt.<timestamp>');
			expect(corruptErr.pgDataPath).toBe(pgDataPath);
		}
	});

	it('renames pgdata aside (never deletes) and starts fresh when reset is true', async () => {
		const pgDataPath = join(dataDir, 'pgdata');
		mkdirSync(pgDataPath, { recursive: true });
		writeFileSync(join(pgDataPath, 'PG_VERSION'), 'garbage-not-a-real-pg-version');

		const db = await openPersistentDb(dataDir, { reset: true });
		try {
			const result = await db.query<{ one: number }>('SELECT 1 AS one');
			expect(result.rows[0]?.one).toBe(1);
		} finally {
			await db.close();
		}

		const corruptDirs = readdirSync(dataDir).filter((name) => name.startsWith('pgdata.corrupt.'));
		expect(corruptDirs.length).toBe(1);
		expect(readdirSync(join(dataDir, corruptDirs[0]!))).toContain('PG_VERSION');
	});

	it('is a no-op on reset when pgdata does not yet exist', async () => {
		const db = await openPersistentDb(dataDir, { reset: true });
		try {
			const result = await db.query<{ one: number }>('SELECT 1 AS one');
			expect(result.rows[0]?.one).toBe(1);
		} finally {
			await db.close();
		}

		const corruptDirs = readdirSync(dataDir).filter((name) => name.startsWith('pgdata.corrupt.'));
		expect(corruptDirs.length).toBe(0);
	});
});
