import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

interface IndexProject {
	id: string;
	slug: string;
	name: string;
	display_order: number;
	is_internal?: boolean;
}

describe('project display order', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let boardUserToken: string;
	let alphaId: string;
	let betaId: string;
	let gammaId: string;
	let hqId: string;

	/** The rail's own list: visible (non-internal) projects, in index order. */
	const railOrder = async (authToken = token): Promise<string[]> => {
		const res = await app.request('/api/projects', { headers: authHeader(authToken) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: IndexProject[] };
		return body.data.filter((p) => !p.is_internal).map((p) => p.id);
	};

	const reorder = async (ids: string[], authToken = token) =>
		app.request('/api/project-display-order', {
			method: 'PUT',
			headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_ids: ids }),
		});

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;

		// Three projects, created oldest → newest. A project owns exactly one team,
		// so each needs its own team.
		const create = async (name: string, prefix: string): Promise<string> => {
			const teamRes = await createTestTeam(db, { name: `${name} Co` });
			const teamId = (await teamRes.json()).data.id;
			const projRes = await createTestProject(db, teamId, {
				name,
				description: `The ${name} project.`,
				task_prefix: prefix,
			});
			return (await projRes.json()).data.id;
		};
		alphaId = await create('Alpha', 'AL');
		betaId = await create('Beta', 'BE');
		gammaId = await create('Gamma', 'GA');

		const hq = await db.query<{ id: string }>(
			'SELECT id FROM projects WHERE is_internal = true LIMIT 1',
		);
		hqId = hq.rows[0].id;

		const boardUser = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id",
		);
		boardUserToken = await signAdminJwt(ctx.masterKeyManager, boardUser.rows[0].id);
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('lists newly created projects on top, preserving the old newest-first rail', async () => {
		expect(await railOrder()).toEqual([gammaId, betaId, alphaId]);
	});

	it('persists a reorder and serves the index in the new order', async () => {
		const res = await reorder([alphaId, gammaId, betaId]);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<{ id: string; display_order: number }> };
		expect(new Map(body.data.map((r) => [r.id, r.display_order]))).toEqual(
			new Map([
				[alphaId, 1],
				[gammaId, 2],
				[betaId, 3],
			]),
		);

		expect(await railOrder()).toEqual([alphaId, gammaId, betaId]);
	});

	it('puts a project created after a reorder back on top', async () => {
		const teamRes = await createTestTeam(db, { name: 'Delta Co' });
		const teamId = (await teamRes.json()).data.id;
		const projRes = await createTestProject(db, teamId, {
			name: 'Delta',
			description: 'The Delta project.',
			task_prefix: 'DE',
		});
		const deltaId = (await projRes.json()).data.id;

		expect(await railOrder()).toEqual([deltaId, alphaId, gammaId, betaId]);

		// Renumbering the visible list folds it back into a dense 1..N.
		const res = await reorder([alphaId, betaId, gammaId, deltaId]);
		expect(res.status).toBe(200);
		expect(await railOrder()).toEqual([alphaId, betaId, gammaId, deltaId]);
	});

	describe('authorization', () => {
		it('rejects a non-superuser board user', async () => {
			const res = await reorder([betaId, alphaId, gammaId], boardUserToken);
			expect(res.status).toBe(403);
			// And the order is untouched.
			expect((await railOrder()).slice(0, 2)).toEqual([alphaId, betaId]);
		});

		it('rejects an unauthenticated caller', async () => {
			const res = await app.request('/api/project-display-order', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ project_ids: [alphaId] }),
			});
			expect(res.status).toBe(401);
		});
	});

	describe('validation', () => {
		const cases: Array<[string, () => unknown]> = [
			['an empty array', () => []],
			['a non-array', () => 'alpha'],
			['a non-UUID entry', () => ['not-a-uuid']],
			['duplicate ids', () => [alphaId, alphaId]],
			['an unknown project id', () => ['00000000-0000-4000-8000-000000000000']],
			['the internal HQ project', () => [hqId]],
		];

		for (const [label, ids] of cases) {
			it(`rejects ${label} with a 400`, async () => {
				const before = await railOrder();
				const res = await app.request('/api/project-display-order', {
					method: 'PUT',
					headers: { ...authHeader(token), 'Content-Type': 'application/json' },
					body: JSON.stringify({ project_ids: ids() }),
				});
				expect(res.status).toBe(400);
				// All-or-nothing: a rejected payload changes no ordering at all.
				expect(await railOrder()).toEqual(before);
			});
		}

		it('rejects an archived project id, leaving every position unchanged', async () => {
			await db.query('UPDATE projects SET archived_at = now() WHERE id = $1', [gammaId]);
			try {
				const before = await railOrder();
				const res = await reorder([betaId, gammaId, alphaId]);
				expect(res.status).toBe(400);
				expect(await railOrder()).toEqual(before);
			} finally {
				await db.query('UPDATE projects SET archived_at = NULL WHERE id = $1', [gammaId]);
			}
		});
	});

	it('leaves the HQ project out of the reorderable list but still in the index', async () => {
		const res = await app.request('/api/projects', { headers: authHeader(token) });
		const body = (await res.json()) as { data: IndexProject[] };
		expect(body.data.some((p) => p.id === hqId && p.is_internal)).toBe(true);
	});
});
