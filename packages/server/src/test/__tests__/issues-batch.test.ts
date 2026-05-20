import type { PGlite } from '@electric-sql/pglite';
import { CEO_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;

let architectId: string;
let productLeadId: string;
let engineerId: string;
let ceoId: string;

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

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Batch Issues Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
	architectId = bySlug('architect')!.id;
	productLeadId = bySlug('product-lead')!.id;
	engineerId = bySlug('engineer')!.id;
	ceoId = bySlug(CEO_AGENT_SLUG)!.id;

	const projectRes = await app.request(`/api/teams/${teamId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Batch Project', description: 'For batch tests.' }),
	});
	projectId = (await projectRes.json()).data.id;
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

describe('POST /teams/:teamId/issues/batch (board caller)', () => {
	it('creates all valid items with sequential identifiers in one project', async () => {
		const r = await app.request(`/api/teams/${teamId}/issues/batch`, {
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
			expect(row.issue.identifier).toMatch(/^BP-\d+$/);
			expect(row.issue.status).toBe('backlog');
		}
		const numbers = body.data.map((r: { issue: { number: number } }) => r.issue.number);
		const sorted = [...numbers].sort((a, b) => a - b);
		expect(sorted).toEqual([sorted[0], sorted[0] + 1, sorted[0] + 2]);
	});

	it('returns per-item errors with index for mixed batches', async () => {
		const r = await app.request(`/api/teams/${teamId}/issues/batch`, {
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

	it('records created_by_member_id consistently for board callers', async () => {
		const r = await app.request(`/api/teams/${teamId}/issues/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [{ project_id: projectId, title: 'Tracks creator', assignee_id: engineerId }],
			}),
		});
		const body = await r.json();
		const issueId = body.data[0].issue.id;
		const dbRow = await db.query<{ created_by_member_id: string | null }>(
			'SELECT created_by_member_id FROM issues WHERE id = $1',
			[issueId],
		);
		expect(dbRow.rows[0].created_by_member_id).not.toBeNull();
	});

	it('rejects empty, non-array, and oversized item lists', async () => {
		const emptyRes = await app.request(`/api/teams/${teamId}/issues/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [] }),
		});
		expect(emptyRes.status).toBe(400);

		const nonArrayRes = await app.request(`/api/teams/${teamId}/issues/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: 'nope' }),
		});
		expect(nonArrayRes.status).toBe(400);

		const oversizedRes = await app.request(`/api/teams/${teamId}/issues/batch`, {
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

describe('MCP tool: create_issues (agent caller)', () => {
	it('enforces subordinate-only assignment per item', async () => {
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
		);

		const result = (await callMcpTool(architectToken, 'create_issues', {
			team_id: teamId,
			items: [
				{
					project_id: projectId,
					title: 'Architect → self (ok)',
					assignee_id: architectId,
				},
				{
					project_id: projectId,
					title: 'Architect → subordinate engineer (ok)',
					assignee_id: engineerId,
				},
				{
					project_id: projectId,
					title: 'Architect → peer product-lead (forbidden)',
					assignee_id: productLeadId,
				},
				{
					project_id: projectId,
					title: 'Architect → manager CEO (forbidden — manager is not a subordinate)',
					assignee_id: ceoId,
				},
			],
		})) as Array<{
			index: number;
			ok: boolean;
			issue?: { id: string; assignee_id: string; created_by_run_id: string | null };
			error?: string;
			code?: string;
		}>;

		expect(result).toHaveLength(4);
		expect(result[0]).toMatchObject({ index: 0, ok: true });
		expect(result[0].issue?.assignee_id).toBe(architectId);
		expect(result[0].issue?.created_by_run_id).not.toBeNull();
		expect(result[1]).toMatchObject({ index: 1, ok: true });
		expect(result[1].issue?.assignee_id).toBe(engineerId);
		expect(result[2]).toMatchObject({ index: 2, ok: false, code: 'FORBIDDEN' });
		expect(result[2].error).toMatch(/subordinate/i);
		expect(result[3]).toMatchObject({ index: 3, ok: false, code: 'FORBIDDEN' });
	});

	it('Zod schema rejects oversized item lists at the MCP boundary', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_issues',
					arguments: {
						team_id: teamId,
						items: Array.from({ length: 51 }, (_, i) => ({
							project_id: projectId,
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
