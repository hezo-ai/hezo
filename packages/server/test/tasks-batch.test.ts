import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;

let architectId: string;
let productLeadId: string;
let engineerId: string;
let captainId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Batch Tasks Co', template_id: typeId });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Batch Project',
		description: 'For batch tests.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
	architectId = bySlug('architect')!.id;
	productLeadId = bySlug('product-lead')!.id;
	engineerId = bySlug('engineer')!.id;
	captainId = bySlug(CAPTAIN_AGENT_SLUG)!.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function callMcpTool(
	bearer: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(bearer), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text);
}

describe('POST /teams/:teamId/tasks/batch (admin caller)', () => {
	it('creates all valid items with sequential identifiers in one project', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [
					{ project_id: projectId, title: 'Batch A', assignee_id: engineerId },
					{ project_id: projectId, title: 'Batch B', assignee_id: engineerId },
					{ project_id: projectId, title: 'Batch C', assignee_id: engineerId },
				],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(3);
		for (const row of body.data) {
			expect(row.ok).toBe(true);
			expect(row.task.identifier).toMatch(/^BP-\d+$/);
			expect(row.task.status).toBe('backlog');
		}
		const numbers = body.data.map((r: { task: { number: number } }) => r.task.number);
		const sorted = [...numbers].sort((a, b) => a - b);
		expect(sorted).toEqual([sorted[0], sorted[0] + 1, sorted[0] + 2]);
	});

	it('returns per-item errors with index for mixed batches', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [
					{ project_id: projectId, title: 'OK 1', assignee_id: engineerId },
					{ project_id: projectId, title: '' /* invalid */, assignee_id: engineerId },
					{ project_id: projectId, title: 'No assignee' },
					{ project_id: projectId, title: 'Bad slug', assignee_slug: 'does-not-exist' },
				],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(4);
		expect(body.data[0]).toMatchObject({ index: 0, ok: true });
		expect(body.data[1]).toMatchObject({ index: 1, ok: false, code: 'INVALID_REQUEST' });
		expect(body.data[2]).toMatchObject({ index: 2, ok: false, code: 'INVALID_REQUEST' });
		expect(body.data[3]).toMatchObject({ index: 3, ok: false, code: 'NOT_FOUND' });
	});

	it('records created_by_member_id consistently for admin callers', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [{ project_id: projectId, title: 'Tracks creator', assignee_id: engineerId }],
			}),
		});
		const body = await r.json();
		const taskId = body.data[0].task.id;
		const dbRow = await db.query<{ created_by_member_id: string | null }>(
			'SELECT created_by_member_id FROM tasks WHERE id = $1',
			[taskId],
		);
		expect(dbRow.rows[0].created_by_member_id).not.toBeNull();
	});

	it('chains items with index tokens via the REST batch endpoint', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [
					{ project_id: projectId, title: 'REST chain 1', assignee_id: engineerId },
					{
						project_id: projectId,
						title: 'REST chain 2',
						assignee_id: engineerId,
						blocked_by_task_ids: ['#0'],
					},
				],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data[0].ok).toBe(true);
		expect(body.data[1].ok).toBe(true);
		expect(body.data[0].task.status).toBe('backlog');
		expect(body.data[1].task.status).toBe('blocked');

		const deps = await db.query<{ blocked_by_task_id: string }>(
			'SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $1',
			[body.data[1].task.id],
		);
		expect(deps.rows).toEqual([{ blocked_by_task_id: body.data[0].task.id }]);
	});

	it('rejects empty, non-array, and oversized item lists', async () => {
		const emptyRes = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [] }),
		});
		expect(emptyRes.status).toBe(400);

		const nonArrayRes = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: 'nope' }),
		});
		expect(nonArrayRes.status).toBe(400);

		const oversizedRes = await app.request(`/api/projects/${projectSlug}/tasks/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: Array.from({ length: 51 }, (_, i) => ({
					project_id: projectId,
					title: `Too many ${i}`,
					assignee_id: engineerId,
				})),
			}),
		});
		expect(oversizedRes.status).toBe(400);
	});
});

describe('MCP tool: create_tasks (agent caller)', () => {
	it('enforces subordinate-only assignment per item', async () => {
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			null,
			{ projectId },
		);

		const result = (await callMcpTool(architectToken, 'create_tasks', {
			project: projectId,
			items: [
				{
					title: 'Architect → self (ok)',
					assignee_id: architectId,
				},
				{
					title: 'Architect → subordinate engineer (ok)',
					assignee_id: engineerId,
				},
				{
					title: 'Architect → peer product-lead (forbidden)',
					assignee_id: productLeadId,
				},
				{
					title: 'Architect → manager Captain (forbidden — manager is not a subordinate)',
					assignee_id: captainId,
				},
			],
		})) as Array<{
			index: number;
			ok: boolean;
			task?: { id: string; assignee_id: string; created_by_run_id: string | null };
			error?: string;
			code?: string;
		}>;

		expect(result).toHaveLength(4);
		expect(result[0]).toMatchObject({ index: 0, ok: true });
		expect(result[0].task?.assignee_id).toBe(architectId);
		expect(result[0].task?.created_by_run_id).not.toBeNull();
		expect(result[1]).toMatchObject({ index: 1, ok: true });
		expect(result[1].task?.assignee_id).toBe(engineerId);
		expect(result[2]).toMatchObject({ index: 2, ok: false, code: 'FORBIDDEN' });
		expect(result[2].error).toMatch(/subordinate/i);
		expect(result[3]).toMatchObject({ index: 3, ok: false, code: 'FORBIDDEN' });
	});

	it('chains items with zero-based index tokens in blocked_by_task_ids', async () => {
		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{ title: 'Phase 1 chain', assignee_id: engineerId },
				{ title: 'Phase 2 chain', assignee_id: engineerId, blocked_by_task_ids: ['#0'] },
				{ title: 'Phase 3 chain', assignee_id: engineerId, blocked_by_task_ids: ['#1'] },
			],
		})) as Array<{ ok: boolean; task: { id: string; status: string } }>;

		expect(result).toHaveLength(3);
		for (const row of result) expect(row.ok).toBe(true);
		expect(result[0].task.status).toBe('backlog');
		expect(result[1].task.status).toBe('blocked');
		expect(result[2].task.status).toBe('blocked');

		const deps = await db.query<{ task_id: string; blocked_by_task_id: string }>(
			'SELECT task_id, blocked_by_task_id FROM task_dependencies WHERE task_id = ANY($1)',
			[[result[1].task.id, result[2].task.id]],
		);
		expect(deps.rows).toHaveLength(2);
		expect(deps.rows).toContainEqual({
			task_id: result[1].task.id,
			blocked_by_task_id: result[0].task.id,
		});
		expect(deps.rows).toContainEqual({
			task_id: result[2].task.id,
			blocked_by_task_id: result[1].task.id,
		});
	});

	it('mixes identifier references and index tokens in one item', async () => {
		const existing = (await callMcpTool(token, 'create_task', {
			project: projectId,
			title: 'Pre-existing blocker',
			assignee_id: engineerId,
		})) as { id: string; identifier: string };

		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{ title: 'Mixed refs first', assignee_id: engineerId },
				{
					title: 'Mixed refs second',
					assignee_id: engineerId,
					blocked_by_task_ids: [existing.identifier, '#0'],
				},
			],
		})) as Array<{ ok: boolean; task: { id: string; status: string } }>;

		expect(result[0].ok).toBe(true);
		expect(result[1].ok).toBe(true);
		expect(result[1].task.status).toBe('blocked');

		const deps = await db.query<{ blocked_by_task_id: string }>(
			'SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $1',
			[result[1].task.id],
		);
		const blockerIds = deps.rows.map((r) => r.blocked_by_task_id).sort();
		expect(blockerIds).toEqual([existing.id, result[0].task.id].sort());
	});

	it('rejects self- and forward-referencing index tokens without inserting rows', async () => {
		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{ title: 'Forward ref', assignee_id: engineerId, blocked_by_task_ids: ['#1'] },
				{ title: 'Self ref', assignee_id: engineerId, blocked_by_task_ids: ['#1'] },
			],
		})) as Array<{ index: number; ok: boolean; code?: string; error?: string }>;

		expect(result[0]).toMatchObject({ index: 0, ok: false, code: 'INVALID_REQUEST' });
		expect(result[1]).toMatchObject({ index: 1, ok: false, code: 'INVALID_REQUEST' });
		expect(result[0].error).toMatch(/earlier item/i);

		const rows = await db.query(
			"SELECT id FROM tasks WHERE team_id = $1 AND title IN ('Forward ref', 'Self ref')",
			[teamId],
		);
		expect(rows.rows).toHaveLength(0);
	});

	it('errors an item whose token references a failed item, without aborting the rest', async () => {
		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{ title: '', assignee_id: engineerId },
				{ title: 'Depends on failed', assignee_id: engineerId, blocked_by_task_ids: ['#0'] },
				{ title: 'Independent survivor', assignee_id: engineerId },
			],
		})) as Array<{ index: number; ok: boolean; code?: string; error?: string }>;

		expect(result[0]).toMatchObject({ index: 0, ok: false });
		expect(result[1]).toMatchObject({ index: 1, ok: false, code: 'INVALID_REQUEST' });
		expect(result[1].error).toMatch(/failed to create/i);
		expect(result[2]).toMatchObject({ index: 2, ok: true });
	});

	it('nests a batch item under an existing parent referenced by identifier', async () => {
		const parent = (await callMcpTool(token, 'create_task', {
			project: projectId,
			title: 'Existing parent for batch',
			assignee_id: engineerId,
		})) as { id: string; identifier: string };

		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{
					title: 'Child of existing parent',
					assignee_id: engineerId,
					parent_task_id: parent.identifier,
				},
			],
		})) as Array<{ ok: boolean; code?: string; task?: { parent_task_id: string | null } }>;

		expect(result[0].ok).toBe(true);
		expect(result[0].task?.parent_task_id).toBe(parent.id);
	});

	it('nests a later batch item under an earlier one via a #index parent token', async () => {
		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{ title: 'Batch parent', assignee_id: engineerId },
				{ title: 'Batch child', assignee_id: engineerId, parent_task_id: '#0' },
			],
		})) as Array<{ ok: boolean; task?: { id: string; parent_task_id: string | null } }>;

		expect(result[0].ok).toBe(true);
		expect(result[1].ok).toBe(true);
		expect(result[1].task?.parent_task_id).toBe(result[0].task?.id);
	});

	it('rejects a forward-referencing #index parent token without aborting the rest', async () => {
		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{ title: 'Parent forward ref', assignee_id: engineerId, parent_task_id: '#1' },
				{ title: 'Independent after bad parent', assignee_id: engineerId },
			],
		})) as Array<{ index: number; ok: boolean; code?: string; error?: string }>;

		expect(result[0]).toMatchObject({ index: 0, ok: false, code: 'INVALID_REQUEST' });
		expect(result[0].error).toMatch(/earlier item/i);
		expect(result[1]).toMatchObject({ index: 1, ok: true });
	});

	it('rejects malformed and out-of-range index tokens', async () => {
		const result = (await callMcpTool(token, 'create_tasks', {
			project: projectId,
			items: [
				{ title: 'Anchor item', assignee_id: engineerId },
				{ title: 'Malformed token', assignee_id: engineerId, blocked_by_task_ids: ['#abc'] },
				{ title: 'Out of range', assignee_id: engineerId, blocked_by_task_ids: ['#99'] },
			],
		})) as Array<{ index: number; ok: boolean; code?: string; error?: string }>;

		expect(result[0]).toMatchObject({ index: 0, ok: true });
		expect(result[1]).toMatchObject({ index: 1, ok: false, code: 'INVALID_REQUEST' });
		expect(result[1].error).toMatch(/zero-based index/i);
		expect(result[2]).toMatchObject({ index: 2, ok: false, code: 'INVALID_REQUEST' });
	});

	it('Zod schema rejects oversized item lists at the MCP boundary', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_tasks',
					arguments: {
						project: projectId,
						items: Array.from({ length: 51 }, (_, i) => ({
							title: `Too many ${i}`,
							assignee_id: engineerId,
						})),
					},
				},
				id: 1,
			}),
		});
		const body = (await res.json()) as {
			result?: { isError?: boolean; content?: Array<{ text: string }> };
			error?: { message: string };
		};
		// MCP returns either a JSON-RPC error or an isError tool result —
		// either way, the payload is not a successful array of per-item results.
		const failed =
			body.error !== undefined ||
			body.result?.isError === true ||
			(body.result?.content !== undefined &&
				/too_big|invalid_arguments|max/i.test(body.result.content[0]?.text ?? ''));
		expect(failed).toBe(true);
	});
});
