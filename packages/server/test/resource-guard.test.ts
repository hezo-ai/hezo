import type { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requireResourceInTeam } from '../src/lib/resource';
import type { Env } from '../src/lib/types';

/**
 * Minimal db stub that records the compiled SQL + params and returns canned
 * rows. The guard's contract is pure (build the scoped query, return row or
 * 404), so a real PGlite would only slow the assertion down.
 */
function fakeDb(rows: unknown[]): { db: PGlite; calls: { sql: string; params: unknown[] }[] } {
	const calls: { sql: string; params: unknown[] }[] = [];
	const db = {
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		query: async (sql: string, params: unknown[]): Promise<any> => {
			calls.push({ sql, params });
			return { rows };
		},
	} as unknown as PGlite;
	return { db, calls };
}

function appWith(db: PGlite): Hono<Env> {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('db', db);
		return next();
	});
	app.get('/teams/:teamId/secrets/:id', async (c) => {
		const row = await requireResourceInTeam<{ id: string }>(
			c,
			'secrets',
			c.req.param('id'),
			'team-1',
			{ resourceName: 'Secret' },
		);
		if (row instanceof Response) return row;
		return c.json({ id: row.id });
	});
	app.get('/teams/:teamId/approvals/:id', async (c) => {
		const row = await requireResourceInTeam<{ id: string; type: string }>(
			c,
			'approvals',
			c.req.param('id'),
			'team-1',
			{ columns: 'id, type' },
		);
		if (row instanceof Response) return row;
		return c.json(row);
	});
	return app;
}

describe('requireResourceInTeam', () => {
	it('returns the row scoped to id + team_id when present', async () => {
		const { db, calls } = fakeDb([{ id: 's1' }]);
		const res = await appWith(db).request('/teams/t/secrets/s1');
		expect(res.status).toBe(200);
		expect((await res.json()) as { id: string }).toEqual({ id: 's1' });
		expect(calls[0].sql).toBe('SELECT id FROM secrets WHERE id = $1 AND team_id = $2');
		expect(calls[0].params).toEqual(['s1', 'team-1']);
	});

	it('selects the requested columns', async () => {
		const { db, calls } = fakeDb([{ id: 'a1', type: 'designated_repo_request' }]);
		const res = await appWith(db).request('/teams/t/approvals/a1');
		expect(res.status).toBe(200);
		expect((await res.json()) as { type: string }).toEqual({
			id: 'a1',
			type: 'designated_repo_request',
		});
		expect(calls[0].sql).toBe('SELECT id, type FROM approvals WHERE id = $1 AND team_id = $2');
	});

	it('returns a 404 Response with the resource name when the row is missing', async () => {
		const { db } = fakeDb([]);
		const res = await appWith(db).request('/teams/t/secrets/missing');
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe('NOT_FOUND');
		expect(body.error.message).toBe('Secret not found');
	});

	it('derives a singular resource name from the table when none is given', async () => {
		const { db } = fakeDb([]);
		const res = await appWith(db).request('/teams/t/approvals/missing');
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toBe('Approval not found');
	});

	it('throws on an unsafe table or column identifier (never user input)', async () => {
		const { db } = fakeDb([]);
		const c = { get: () => db } as unknown as Parameters<typeof requireResourceInTeam>[0];
		await expect(requireResourceInTeam(c, 'secrets; DROP TABLE secrets', 'x', 't')).rejects.toThrow(
			/unsafe table/,
		);
		await expect(
			requireResourceInTeam(c, 'secrets', 'x', 't', { columns: 'id); DROP TABLE' }),
		).rejects.toThrow(/unsafe columns/);
	});
});
