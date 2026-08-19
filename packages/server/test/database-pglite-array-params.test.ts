import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePgliteParams } from '../src/db/drivers/pglite';

/**
 * PGlite serializes a parameter from the type OID it inferred and has no OID for a
 * user-defined enum array, so a JS array bound to `$1::wakeup_source[]` arrived as
 * the braceless `String(array)` and the query died with `malformed array literal`.
 * node-postgres serializes every array correctly, so the same statement passed on
 * an external Postgres and failed on the embedded default - which is exactly how
 * it went unnoticed: the gated `test-postgres` leg is green and the CI browser log
 * carried the failures as `[error] <agent-runner> ... no-wake exit check failed`.
 *
 * Asserted against a real PGlite rather than on the rendered string, because what
 * matters is that the server accepts it.
 */
let db: PGlite;

beforeAll(async () => {
	db = new PGlite();
	await db.query(`CREATE TYPE wakeup_src AS ENUM ('mention','reply','heartbeat')`);
	await db.query(`CREATE TABLE w (id int, source wakeup_src, name text)`);
	await db.query(`INSERT INTO w VALUES (1,'heartbeat','x'), (2,'mention','y')`);
	await db.query(`CREATE TABLE q (id int, tag text)`);
	await db.query(
		`INSERT INTO q VALUES (1,'a,b'), (2,'he said "hi"'), (3,'back\\slash'), (4,'{braced}'), (5,'NULL')`,
	);
});

afterAll(async () => {
	await db.close();
});

async function ids(sql: string, params: unknown[]): Promise<number[]> {
	const r = await db.query<{ id: number }>(sql, encodePgliteParams(params));
	return r.rows.map((row) => row.id).sort((a, b) => a - b);
}

describe('encodePgliteParams', () => {
	it('binds an enum array, which PGlite rejects unencoded', async () => {
		// The unencoded form is the bug, so pin it: if PGlite ever learns to
		// serialize enum arrays this throw stops and the encoder can go.
		await expect(
			db.query(`SELECT id FROM w WHERE source <> ALL($1::wakeup_src[])`, [['mention', 'reply']]),
		).rejects.toThrow(/malformed array literal/);

		expect(
			await ids(`SELECT id FROM w WHERE source <> ALL($1::wakeup_src[])`, [['mention', 'reply']]),
		).toEqual([1]);
	});

	it('binds a single-element enum array (the wakeup-settlement shape)', async () => {
		expect(
			await ids(`SELECT id FROM w WHERE source <> ALL($1::wakeup_src[])`, [['mention']]),
		).toEqual([1]);
	});

	it('binds an enum array through = ANY', async () => {
		expect(
			await ids(`SELECT id FROM w WHERE source = ANY($1::wakeup_src[])`, [
				['mention', 'heartbeat'],
			]),
		).toEqual([1, 2]);
	});

	it('keeps the element types PGlite already handled working', async () => {
		expect(await ids(`SELECT id FROM w WHERE name = ANY($1::text[])`, [['x', 'y']])).toEqual([
			1, 2,
		]);
		expect(await ids(`SELECT id FROM w WHERE id = ANY($1::int[])`, [[1, 2]])).toEqual([1, 2]);
	});

	it('round-trips values that would otherwise read as array syntax', async () => {
		// Each is one element, not two, and not re-parsed: a comma must not split it,
		// braces must not nest it, and quotes/backslashes must survive intact.
		for (const [tag, id] of [
			['a,b', 1],
			['he said "hi"', 2],
			['back\\slash', 3],
			['{braced}', 4],
			// The string "NULL" is a value; only a real null is the SQL keyword.
			['NULL', 5],
		] as const) {
			expect(await ids(`SELECT id FROM q WHERE tag = ANY($1::text[])`, [[tag]])).toEqual([id]);
		}
	});

	it('emits a real null as SQL NULL, which matches nothing', async () => {
		expect(await ids(`SELECT id FROM q WHERE tag = ANY($1::text[])`, [[null, 'a,b']])).toEqual([1]);
	});

	it('leaves non-array parameters alone', async () => {
		expect(encodePgliteParams(['x', 3, null, undefined])).toEqual(['x', 3, null, undefined]);
		expect(encodePgliteParams(undefined)).toBeUndefined();
		// A bytea parameter is not an Array, so it must pass through untouched.
		const bytes = new Uint8Array([1, 2, 3]);
		expect(encodePgliteParams([bytes])?.[0]).toBe(bytes);
	});

	it('renders a nested array as a nested literal', async () => {
		const r = await db.query<{ v: number[][] }>(
			`SELECT $1::int[][] AS v`,
			encodePgliteParams([
				[
					[1, 2],
					[3, 4],
				],
			]),
		);
		expect(r.rows[0].v).toEqual([
			[1, 2],
			[3, 4],
		]);
	});
});
