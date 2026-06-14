import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import { type Migration, runMigrations } from '../src/db/migrate';
import { safeClose } from './helpers';

// HID-188: code-step migrations. Some data transforms can't be expressed in SQL
// and need application-side logic (parse/re-encode/re-encrypt). A migration can
// therefore be a `{ run(db) }` code step instead of a SQL string. It runs inside
// the same per-migration transaction the runner uses for SQL, so a throw rolls
// the whole step back. These tests prove the transform preserves data, rolls back
// cleanly on failure, and interleaves with SQL migrations in order.

describe('code-step migrations', () => {
	it('runs an application-side data transform and preserves every row', async () => {
		const db = await createMemoryDb();
		try {
			await runMigrations(db, {
				'001_contacts.sql': 'CREATE TABLE contacts (id INTEGER PRIMARY KEY, phone TEXT NOT NULL);',
			});
			// Messy phone formats SQL alone shouldn't be asked to normalize.
			const seed: Array<{ id: number; phone: string }> = [
				{ id: 1, phone: '(415) 555-0001' },
				{ id: 2, phone: '+1 415.555.0002' },
				{ id: 3, phone: '415-555-0003' },
			];
			for (const r of seed) {
				await db.query('INSERT INTO contacts (id, phone) VALUES ($1, $2)', [r.id, r.phone]);
			}

			const normalizePhones: Migration = {
				checksum: 'normalize-phones-v1',
				run: async (mdb) => {
					await mdb.exec('CREATE TABLE contacts_v2 (id INTEGER PRIMARY KEY, phone TEXT NOT NULL);');
					const rows = await mdb.query<{ id: number; phone: string }>(
						'SELECT id, phone FROM contacts ORDER BY id',
					);
					for (const r of rows.rows) {
						// JS-side reformat: strip to digits, default a US country code
						// when a bare 10-digit number is given, render E.164.
						const digits = r.phone.replace(/\D/g, '');
						const withCc = digits.length === 10 ? `1${digits}` : digits;
						const e164 = `+${withCc}`;
						await mdb.query('INSERT INTO contacts_v2 (id, phone) VALUES ($1, $2)', [r.id, e164]);
					}
					await mdb.exec('DROP TABLE contacts;');
					await mdb.exec('ALTER TABLE contacts_v2 RENAME TO contacts;');
				},
			};
			await runMigrations(db, { '002_normalize_phones': normalizePhones });

			const result = await db.query<{ id: number; phone: string }>(
				'SELECT id, phone FROM contacts ORDER BY id',
			);
			expect(result.rows).toEqual([
				{ id: 1, phone: '+14155550001' },
				{ id: 2, phone: '+14155550002' },
				{ id: 3, phone: '+14155550003' },
			]);
			const recorded = await db.query<{ filename: string }>(
				"SELECT filename FROM _migrations WHERE filename = '002_normalize_phones'",
			);
			expect(recorded.rows).toHaveLength(1);
		} finally {
			await safeClose(db);
		}
	});

	it('rolls back a code step that throws mid-transform, preserving the original data', async () => {
		const db = await createMemoryDb();
		try {
			await runMigrations(db, {
				'001_accounts.sql':
					'CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);',
			});
			await db.query('INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 250)');

			const bad: Migration = {
				checksum: 'bad-code-step',
				run: async (mdb) => {
					await mdb.query('UPDATE accounts SET balance = balance + 1000');
					throw new Error('boom in code step');
				},
			};
			await expect(runMigrations(db, { '002_bad_code': bad })).rejects.toThrow('002_bad_code');

			// The in-transaction UPDATE was rolled back.
			const rows = await db.query<{ id: number; balance: number }>(
				'SELECT id, balance FROM accounts ORDER BY id',
			);
			expect(rows.rows).toEqual([
				{ id: 1, balance: 100 },
				{ id: 2, balance: 250 },
			]);
			const recorded = await db.query<{ c: number }>(
				"SELECT COUNT(*)::int AS c FROM _migrations WHERE filename = '002_bad_code'",
			);
			expect(recorded.rows[0].c).toBe(0);
		} finally {
			await safeClose(db);
		}
	});

	it('interleaves SQL and code migrations in name order and is idempotent', async () => {
		const db = await createMemoryDb();
		try {
			let codeRuns = 0;
			const migrations: Record<string, Migration> = {
				'001_items.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);',
				'002_uppercase_labels': {
					checksum: 'uppercase-v1',
					run: async (mdb) => {
						codeRuns += 1;
						const rows = await mdb.query<{ id: number; label: string | null }>(
							'SELECT id, label FROM items ORDER BY id',
						);
						for (const r of rows.rows) {
							await mdb.query('UPDATE items SET label = $1 WHERE id = $2', [
								r.label?.toUpperCase() ?? null,
								r.id,
							]);
						}
					},
				},
				'003_add_flag.sql': 'ALTER TABLE items ADD COLUMN flagged BOOLEAN NOT NULL DEFAULT false;',
			};

			// Apply 001 + seed, then the full set (002 code depends on 001's rows; 003 after 002).
			await runMigrations(db, { '001_items.sql': migrations['001_items.sql'] });
			await db.query("INSERT INTO items (id, label) VALUES (1, 'alpha'), (2, 'beta')");
			await runMigrations(db, migrations);

			const applied = await db.query<{ filename: string }>(
				'SELECT filename FROM _migrations ORDER BY id',
			);
			expect(applied.rows.map((r) => r.filename)).toEqual([
				'001_items.sql',
				'002_uppercase_labels',
				'003_add_flag.sql',
			]);
			const items = await db.query<{ id: number; label: string; flagged: boolean }>(
				'SELECT id, label, flagged FROM items ORDER BY id',
			);
			expect(items.rows).toEqual([
				{ id: 1, label: 'ALPHA', flagged: false },
				{ id: 2, label: 'BETA', flagged: false },
			]);

			// Re-running is a no-op: the code step does not fire again.
			await runMigrations(db, migrations);
			expect(codeRuns).toBe(1);
		} finally {
			await safeClose(db);
		}
	});
});
