import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { safeClose } from './helpers';

// HID-188: end-to-end coverage for the production migration runner
// (`runMigrations`) applying *sequences* of migrations that refactor table
// layouts and foreign-key relationships against a *populated* database, while
// preserving every existing row. Migrations are synthetic, defined inline as
// `Record<string, string>` (pre-v1 policy keeps a single real schema file), and
// driven through the same `runMigrations` the server runs at startup — so these
// exercise the real BEGIN/COMMIT/ROLLBACK, sorted ordering, and checksum
// tracking, not a hand-rolled `db.exec` loop.

describe('migration data preservation', () => {
	it('A: extracts a normalized authors table + FK, preserving every author mapping', async () => {
		const db = await createMemoryDb();
		try {
			await runMigrations(db, {
				'001_posts.sql': `
					CREATE TABLE posts (
						id           SERIAL PRIMARY KEY,
						title        TEXT NOT NULL,
						author_name  TEXT NOT NULL,
						author_email TEXT NOT NULL,
						body         TEXT NOT NULL
					);
				`,
			});

			// v1 data: 3 distinct authors spread across 5 posts (deliberate repeats).
			const seed: Array<{ title: string; name: string; email: string; body: string }> = [
				{ title: 'First', name: 'Ada Lovelace', email: 'ada@example.com', body: 'b1' },
				{ title: 'Second', name: 'Ada Lovelace', email: 'ada@example.com', body: 'b2' },
				{ title: 'Third', name: 'Alan Turing', email: 'alan@example.com', body: 'b3' },
				{ title: 'Fourth', name: 'Grace Hopper', email: 'grace@example.com', body: 'b4' },
				{ title: 'Fifth', name: 'Alan Turing', email: 'alan@example.com', body: 'b5' },
			];
			for (const row of seed) {
				await db.query(
					'INSERT INTO posts (title, author_name, author_email, body) VALUES ($1, $2, $3, $4)',
					[row.title, row.name, row.email, row.body],
				);
			}

			// Refactor: pull authors into their own table, rewrite posts to an FK.
			await runMigrations(db, {
				'002_extract_authors.sql': `
					CREATE TABLE authors (
						id    SERIAL PRIMARY KEY,
						name  TEXT NOT NULL,
						email TEXT NOT NULL UNIQUE
					);
					INSERT INTO authors (name, email)
						SELECT DISTINCT author_name, author_email FROM posts;
					ALTER TABLE posts ADD COLUMN author_id INTEGER;
					UPDATE posts p SET author_id = a.id
						FROM authors a WHERE a.email = p.author_email;
					ALTER TABLE posts ALTER COLUMN author_id SET NOT NULL;
					ALTER TABLE posts ADD CONSTRAINT posts_author_fk
						FOREIGN KEY (author_id) REFERENCES authors (id);
					ALTER TABLE posts DROP COLUMN author_name;
					ALTER TABLE posts DROP COLUMN author_email;
				`,
			});

			// No data lost: 5 posts, 3 distinct authors, zero unmapped rows.
			const postCount = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM posts');
			expect(postCount.rows[0].c).toBe(5);
			const authorCount = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM authors');
			expect(authorCount.rows[0].c).toBe(3);
			const nullCount = await db.query<{ c: number }>(
				'SELECT COUNT(*)::int AS c FROM posts WHERE author_id IS NULL',
			);
			expect(nullCount.rows[0].c).toBe(0);

			// Each post still resolves to its *original* author via the new FK.
			const joined = await db.query<{ title: string; name: string; email: string }>(
				`SELECT p.title, a.name, a.email
				 FROM posts p JOIN authors a ON a.id = p.author_id
				 ORDER BY p.id`,
			);
			expect(joined.rows).toEqual(
				seed.map((r) => ({ title: r.title, name: r.name, email: r.email })),
			);

			// The new FK is enforced: a dangling author_id is rejected.
			await expect(
				db.query("INSERT INTO posts (title, body, author_id) VALUES ('x', 'y', 9999)"),
			).rejects.toThrow();
		} finally {
			await safeClose(db);
		}
	});

	it('B: migrates a one-to-many FK into a many-to-many join, preserving every assignment', async () => {
		const db = await createMemoryDb();
		try {
			await runMigrations(db, {
				'001_tasks.sql': `
					CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
					CREATE TABLE tasks (
						id          SERIAL PRIMARY KEY,
						title       TEXT NOT NULL,
						assignee_id INTEGER REFERENCES users (id)
					);
				`,
			});

			await db.query("INSERT INTO users (name) VALUES ('Ada'), ('Alan'), ('Grace')");
			// Tasks 1-3 assigned to users 1-3, task 4 deliberately unassigned (NULL).
			await db.query(`
				INSERT INTO tasks (title, assignee_id) VALUES
					('T1', 1), ('T2', 2), ('T3', 3), ('T4', NULL)
			`);

			await runMigrations(db, {
				'002_task_assignees.sql': `
					CREATE TABLE task_assignees (
						task_id INTEGER NOT NULL REFERENCES tasks (id),
						user_id INTEGER NOT NULL REFERENCES users (id),
						PRIMARY KEY (task_id, user_id)
					);
					INSERT INTO task_assignees (task_id, user_id)
						SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL;
					ALTER TABLE tasks DROP COLUMN assignee_id;
				`,
			});

			// The 3 original assignments became 3 join rows; the NULL task has none.
			const pairs = await db.query<{ task_id: number; user_id: number }>(
				'SELECT task_id, user_id FROM task_assignees ORDER BY task_id',
			);
			expect(pairs.rows).toEqual([
				{ task_id: 1, user_id: 1 },
				{ task_id: 2, user_id: 2 },
				{ task_id: 3, user_id: 3 },
			]);
			const t4 = await db.query<{ c: number }>(
				'SELECT COUNT(*)::int AS c FROM task_assignees WHERE task_id = 4',
			);
			expect(t4.rows[0].c).toBe(0);

			// The new shape genuinely supports many-to-many: a second assignee lands.
			await db.query('INSERT INTO task_assignees (task_id, user_id) VALUES (1, 2)');
			const t1 = await db.query<{ c: number }>(
				'SELECT COUNT(*)::int AS c FROM task_assignees WHERE task_id = 1',
			);
			expect(t1.rows[0].c).toBe(2);
		} finally {
			await safeClose(db);
		}
	});

	it('C: splits a column into two with backfill + NOT NULL, preserving every value', async () => {
		const db = await createMemoryDb();
		try {
			await runMigrations(db, {
				'001_authors.sql': 'CREATE TABLE authors (id SERIAL PRIMARY KEY, name TEXT NOT NULL);',
			});

			const names = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'];
			for (const name of names) {
				await db.query('INSERT INTO authors (name) VALUES ($1)', [name]);
			}

			await runMigrations(db, {
				'002_split_name.sql': `
					ALTER TABLE authors ADD COLUMN first_name TEXT;
					ALTER TABLE authors ADD COLUMN last_name  TEXT;
					UPDATE authors SET
						first_name = split_part(name, ' ', 1),
						last_name  = split_part(name, ' ', 2);
					ALTER TABLE authors ALTER COLUMN first_name SET NOT NULL;
					ALTER TABLE authors ALTER COLUMN last_name  SET NOT NULL;
					ALTER TABLE authors DROP COLUMN name;
				`,
			});

			const rebuilt = await db.query<{ full: string }>(
				"SELECT first_name || ' ' || last_name AS full FROM authors ORDER BY id",
			);
			expect(rebuilt.rows.map((r) => r.full)).toEqual(names);
			const count = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM authors');
			expect(count.rows[0].c).toBe(3);
		} finally {
			await safeClose(db);
		}
	});

	it('D: applies a dependent multi-migration sequence in one call and is idempotent on re-run', async () => {
		const db = await createMemoryDb();
		try {
			// A chain where each step depends on the previous one's output.
			const schema = {
				'001_posts.sql': `
					CREATE TABLE posts (
						id           SERIAL PRIMARY KEY,
						title        TEXT NOT NULL,
						author_name  TEXT NOT NULL,
						author_email TEXT NOT NULL,
						body         TEXT NOT NULL
					);
				`,
			};
			const refactors = {
				'002_extract_authors.sql': `
					CREATE TABLE authors (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
					INSERT INTO authors (name, email) SELECT DISTINCT author_name, author_email FROM posts;
					ALTER TABLE posts ADD COLUMN author_id INTEGER;
					UPDATE posts p SET author_id = a.id FROM authors a WHERE a.email = p.author_email;
					ALTER TABLE posts ALTER COLUMN author_id SET NOT NULL;
					ALTER TABLE posts ADD CONSTRAINT posts_author_fk FOREIGN KEY (author_id) REFERENCES authors (id);
					ALTER TABLE posts DROP COLUMN author_name;
					ALTER TABLE posts DROP COLUMN author_email;
				`,
				// 003 depends on the authors table that 002 created.
				'003_split_author_name.sql': `
					ALTER TABLE authors ADD COLUMN first_name TEXT;
					ALTER TABLE authors ADD COLUMN last_name  TEXT;
					UPDATE authors SET first_name = split_part(name, ' ', 1), last_name = split_part(name, ' ', 2);
					ALTER TABLE authors ALTER COLUMN first_name SET NOT NULL;
					ALTER TABLE authors ALTER COLUMN last_name  SET NOT NULL;
					ALTER TABLE authors DROP COLUMN name;
				`,
				// 004 renames a posts column that has lived since 001.
				'004_rename_body.sql': 'ALTER TABLE posts RENAME COLUMN body TO content;',
			};
			const all = { ...schema, ...refactors };

			// Install v1 (schema only), seed, then apply the whole refactor chain at once.
			await runMigrations(db, schema);
			const seed: Array<{ title: string; name: string; email: string; body: string }> = [
				{ title: 'First', name: 'Ada Lovelace', email: 'ada@example.com', body: 'b1' },
				{ title: 'Second', name: 'Alan Turing', email: 'alan@example.com', body: 'b2' },
				{ title: 'Third', name: 'Ada Lovelace', email: 'ada@example.com', body: 'b3' },
			];
			for (const row of seed) {
				await db.query(
					'INSERT INTO posts (title, author_name, author_email, body) VALUES ($1, $2, $3, $4)',
					[row.title, row.name, row.email, row.body],
				);
			}

			await runMigrations(db, all);

			// All four recorded, applied in sorted order.
			const applied = await db.query<{ filename: string }>(
				'SELECT filename FROM _migrations ORDER BY id',
			);
			expect(applied.rows.map((r) => r.filename)).toEqual([
				'001_posts.sql',
				'002_extract_authors.sql',
				'003_split_author_name.sql',
				'004_rename_body.sql',
			]);

			// Snapshot the post-refactor world: renamed column + split names intact.
			const snapshotSql = `
				SELECT p.title, p.content, a.first_name, a.last_name
				FROM posts p JOIN authors a ON a.id = p.author_id
				ORDER BY p.id`;
			const before = await db.query(snapshotSql);
			expect(before.rows).toEqual([
				{ title: 'First', content: 'b1', first_name: 'Ada', last_name: 'Lovelace' },
				{ title: 'Second', content: 'b2', first_name: 'Alan', last_name: 'Turing' },
				{ title: 'Third', content: 'b3', first_name: 'Ada', last_name: 'Lovelace' },
			]);

			// Re-running the identical set is a no-op: nothing re-applied, data untouched.
			await runMigrations(db, all);
			const appliedAgain = await db.query<{ c: number }>(
				'SELECT COUNT(*)::int AS c FROM _migrations',
			);
			expect(appliedAgain.rows[0].c).toBe(4);
			const after = await db.query(snapshotSql);
			expect(after.rows).toEqual(before.rows);
		} finally {
			await safeClose(db);
		}
	});

	it('E: rolls back a failure mid-refactor, leaving existing data exactly as before', async () => {
		const db = await createMemoryDb();
		try {
			await runMigrations(db, {
				'001_accounts.sql': `
					CREATE TABLE accounts (
						id      SERIAL PRIMARY KEY,
						owner   TEXT NOT NULL,
						balance INTEGER NOT NULL
					);
				`,
			});
			await db.query(`
				INSERT INTO accounts (owner, balance) VALUES ('Ada', 100), ('Alan', 250), ('Grace', 400)
			`);
			const original = await db.query<{ id: number; owner: string; balance: number }>(
				'SELECT id, owner, balance FROM accounts ORDER BY id',
			);

			// A migration that performs a real data mutation, then fails. The whole
			// thing must roll back as one unit — no half-applied state.
			await expect(
				runMigrations(db, {
					'002_bad_refactor.sql': `
						UPDATE accounts SET balance = balance + 100;
						ALTER TABLE accounts ADD COLUMN status TEXT;
						THIS IS NOT VALID SQL;
					`,
				}),
			).rejects.toThrow('002_bad_refactor.sql');

			// The +100 update was undone — balances match the originals exactly.
			const afterFail = await db.query<{ id: number; owner: string; balance: number }>(
				'SELECT id, owner, balance FROM accounts ORDER BY id',
			);
			expect(afterFail.rows).toEqual(original.rows);

			// The partial schema change was undone too.
			const statusCol = await db.query<{ c: number }>(
				`SELECT COUNT(*)::int AS c FROM information_schema.columns
				 WHERE table_name = 'accounts' AND column_name = 'status'`,
			);
			expect(statusCol.rows[0].c).toBe(0);

			// The failed migration was not recorded, so it stays pending.
			const recorded = await db.query<{ c: number }>(
				"SELECT COUNT(*)::int AS c FROM _migrations WHERE filename = '002_bad_refactor.sql'",
			);
			expect(recorded.rows[0].c).toBe(0);
		} finally {
			await safeClose(db);
		}
	});
});
