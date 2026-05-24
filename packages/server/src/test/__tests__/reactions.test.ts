import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, ReactionKind } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectId: string;
let captainId: string;
let architectId: string;
let productLeadId: string;
let ceoSlug: string;

interface ReactionMember {
	id: string;
	slug: string | null;
	display_name: string | null;
}
interface ReactionGroup {
	kind: string;
	members: ReactionMember[];
}

async function insertTask(
	assigneeId: string,
	title: string,
	opts?: { teamId?: string; projectId?: string },
): Promise<string> {
	const cid = opts?.teamId ?? teamId;
	const pid = opts?.projectId ?? projectId;
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[pid],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[cid, pid, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0].id;
}

async function insertComment(taskId: string, authorMemberId: string | null): Promise<string> {
	const res = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[taskId, authorMemberId, JSON.stringify({ text: '@architect please review' })],
	);
	return res.rows[0].id;
}

async function callMcp(
	agentToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<{ status: number; result: unknown }> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	const text = body.result?.content?.[0]?.text ?? '{}';
	return { status: res.status, result: JSON.parse(text) };
}

async function reactionsRowCount(commentId: string): Promise<number> {
	const r = await db.query<{ c: number }>(
		'SELECT COUNT(*)::int AS c FROM comment_reactions WHERE comment_id = $1',
		[commentId],
	);
	return r.rows[0].c;
}

async function wakeupCount(): Promise<number> {
	const r = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM agent_wakeup_requests');
	return r.rows[0].c;
}

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
		body: JSON.stringify({ name: 'Reactions Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	const captain = agents.find((a) => a.slug === 'captain')!;
	captainId = captain.id;
	ceoSlug = captain.slug;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Reactions Project',
		description: 'x',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM comment_reactions');
	await db.query('DELETE FROM agent_wakeup_requests');
});

describe('REST reactions endpoints', () => {
	it('PUT adds a reaction; idempotent on repeat', async () => {
		const taskId = await insertTask(captainId, 'Reaction test');
		const commentId = await insertComment(taskId, productLeadId);

		const url = `/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${ReactionKind.Ack}`;
		const first = await app.request(url, { method: 'PUT', headers: authHeader(token) });
		expect(first.status).toBe(200);
		const firstBody = (await first.json()).data as {
			kind: string;
			reactions: ReactionGroup[];
		};
		expect(firstBody.kind).toBe(ReactionKind.Ack);
		expect(firstBody.reactions).toHaveLength(1);
		expect(firstBody.reactions[0].kind).toBe(ReactionKind.Ack);
		expect(firstBody.reactions[0].members).toHaveLength(1);

		const second = await app.request(url, { method: 'PUT', headers: authHeader(token) });
		expect(second.status).toBe(200);
		expect(await reactionsRowCount(commentId)).toBe(1);
	});

	it('DELETE removes only the caller’s reaction', async () => {
		const taskId = await insertTask(captainId, 'Reaction delete test');
		const commentId = await insertComment(taskId, productLeadId);

		// Architect (an agent) reacts via MCP
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);
		const arc = await callMcp(architectToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect(arc.status).toBe(200);
		expect((arc.result as { error?: string }).error).toBeUndefined();

		// Board user reacts via REST
		const putUrl = `/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${ReactionKind.Ack}`;
		await app.request(putUrl, { method: 'PUT', headers: authHeader(token) });
		expect(await reactionsRowCount(commentId)).toBe(2);

		// Board user removes their own — architect's stays
		const del = await app.request(putUrl, { method: 'DELETE', headers: authHeader(token) });
		expect(del.status).toBe(200);
		expect(await reactionsRowCount(commentId)).toBe(1);
		const remaining = await db.query<{ member_id: string }>(
			'SELECT member_id FROM comment_reactions WHERE comment_id = $1',
			[commentId],
		);
		expect(remaining.rows[0].member_id).toBe(architectId);
	});

	it('400 on unknown reaction kind', async () => {
		const taskId = await insertTask(captainId, 'Invalid kind test');
		const commentId = await insertComment(taskId, productLeadId);

		const res = await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/nope`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});

	it('404 when comment does not belong to the task', async () => {
		const taskA = await insertTask(captainId, 'Cross-task A');
		const taskB = await insertTask(captainId, 'Cross-task B');
		const commentInA = await insertComment(taskA, productLeadId);

		const res = await app.request(
			`/api/teams/${teamId}/tasks/${taskB}/comments/${commentInA}/reactions/${ReactionKind.Ack}`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('reacting does not create any wakeups', async () => {
		const taskId = await insertTask(captainId, 'No wakeup test');
		const commentId = await insertComment(taskId, productLeadId);

		const before = await wakeupCount();
		await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${ReactionKind.Ack}`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${ReactionKind.Ack}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(await wakeupCount()).toBe(before);
	});

	it('GET /comments includes reactions inline', async () => {
		const taskId = await insertTask(captainId, 'GET with reactions');
		const commentId = await insertComment(taskId, productLeadId);

		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		await callMcp(ceoToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});

		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{
			id: string;
			reactions: ReactionGroup[];
		}>;
		const c = rows.find((r) => r.id === commentId);
		expect(c).toBeDefined();
		expect(c!.reactions).toHaveLength(1);
		expect(c!.reactions[0].kind).toBe(ReactionKind.Ack);
		expect(c!.reactions[0].members[0].slug).toBe(ceoSlug);
	});

	it('cross-team access is denied', async () => {
		const taskId = await insertTask(captainId, 'Cross-team test');
		const commentId = await insertComment(taskId, productLeadId);

		// Build a second team; mint an api key for it.
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;
		const otherTeam = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Co', template_id: typeId }),
		});
		const otherTeamId = (await otherTeam.json()).data.id;
		const otherAgents = await app.request(`/api/teams/${otherTeamId}/agents`, {
			headers: authHeader(token),
		});
		const otherCeo = (await otherAgents.json()).data.find(
			(a: { slug: string }) => a.slug === 'captain',
		);
		const otherProjectRes = await createTestProject(db, otherTeamId, {
			name: 'Other Project',
			description: 'Cross-team reactions isolation project.',
		});
		expect(otherProjectRes.status).toBe(201);
		const otherProjectId = (await otherProjectRes.json()).data.id as string;
		const otherTaskId = await insertTask(otherCeo.id, 'other', {
			teamId: otherTeamId,
			projectId: otherProjectId,
		});
		const { token: otherToken } = await mintAgentToken(
			db,
			masterKeyManager,
			otherCeo.id,
			otherTeamId,
			otherTaskId,
		);

		const res = await app.request(
			`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${ReactionKind.Ack}`,
			{ method: 'PUT', headers: authHeader(otherToken) },
		);
		expect(res.status).toBe(403);
	});
});

describe('MCP add_reaction / remove_reaction tools', () => {
	it('add_reaction is idempotent', async () => {
		const taskId = await insertTask(captainId, 'MCP idempotent');
		const commentId = await insertComment(taskId, productLeadId);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);

		const first = await callMcp(agentToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect((first.result as { error?: string }).error).toBeUndefined();
		const second = await callMcp(agentToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect((second.result as { error?: string }).error).toBeUndefined();
		expect(await reactionsRowCount(commentId)).toBe(1);
	});

	it('remove_reaction removes only the caller’s reaction', async () => {
		const taskId = await insertTask(captainId, 'MCP remove');
		const commentId = await insertComment(taskId, productLeadId);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		const { token: archToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);
		await callMcp(ceoToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		await callMcp(archToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		await callMcp(ceoToken, 'remove_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		const rows = await db.query<{ member_id: string }>(
			'SELECT member_id FROM comment_reactions WHERE comment_id = $1',
			[commentId],
		);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0].member_id).toBe(architectId);
	});

	it('list_comments includes reactions inline', async () => {
		const taskId = await insertTask(captainId, 'MCP list_comments');
		const commentId = await insertComment(taskId, productLeadId);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		await callMcp(agentToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		const list = await callMcp(agentToken, 'list_comments', {
			team_id: teamId,
			task_id: taskId,
		});
		const rows = list.result as Array<{ id: string; reactions: ReactionGroup[] }>;
		const c = rows.find((r) => r.id === commentId)!;
		expect(c.reactions).toHaveLength(1);
		expect(c.reactions[0].kind).toBe(ReactionKind.Ack);
	});

	it('add_reaction does not fire any wakeups', async () => {
		const taskId = await insertTask(architectId, 'MCP no wakeups');
		const commentId = await insertComment(taskId, captainId);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);

		const before = await wakeupCount();
		await callMcp(agentToken, 'add_reaction', {
			team_id: teamId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect(await wakeupCount()).toBe(before);
	});
});
