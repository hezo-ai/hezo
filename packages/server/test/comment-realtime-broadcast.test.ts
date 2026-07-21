import { CredentialKind, ReactionKind, WsMessageType, wsRoom } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketManager, type WsEvent } from '../src/services/ws';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

interface CapturedBroadcast {
	room: string;
	event: WsEvent;
}

/**
 * Comment-family rows (`task_comments`, `comment_reactions`, …) have no
 * `team_id`/`project_id` column, but the web client's realtime subscriber
 * resolves the project slug it invalidates on from `row.project_id` (the
 * `team_id` fallback can't resolve `is_internal` HQ tasks). So every
 * comment-family broadcast MUST carry `project_id`, and `create_comment` —
 * which previously never broadcast — must broadcast at all. Without these,
 * agent comments/reactions only appear after a page refresh.
 */
describe('comment-family realtime broadcasts carry project_id', () => {
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let teamId: string;
	let projectId: string;
	let projectSlug: string;
	let agentId: string;
	let taskId: string;
	let captured: CapturedBroadcast[];
	let broadcastSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		ctx = await createTestApp();

		const typesRes = await ctx.app.request('/api/team-templates', {
			headers: authHeader(ctx.token),
		});
		const typeId = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'App Team',
		).id;

		const teamRes = await createTestTeam(ctx.db, {
			name: 'Comment Realtime Co',
			template_id: typeId,
		});
		teamId = (await teamRes.json()).data.id;

		const projectRes = await createTestProject(ctx.db, teamId, {
			name: 'Comment Realtime Project',
		});
		const project = (await projectRes.json()).data;
		projectId = project.id;
		projectSlug = project.slug;

		const agentsRes = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(ctx.token),
		});
		agentId = (await agentsRes.json()).data[0].id;

		const taskRes = await ctx.app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Realtime Seed', assignee_id: agentId }),
		});
		taskId = (await taskRes.json()).data.id;

		captured = [];
		broadcastSpy = vi.spyOn(WebSocketManager.prototype, 'broadcast').mockImplementation(function (
			this: WebSocketManager,
			room: string,
			event: WsEvent,
		) {
			captured.push({ room, event });
		});
	});

	afterAll(async () => {
		broadcastSpy.mockRestore();
		await safeClose(ctx.db);
	});

	beforeEach(() => {
		captured.length = 0;
	});

	function findRow(table: string, action: string): Record<string, unknown> | undefined {
		const room = wsRoom.team(teamId);
		const entry = captured.find(
			(e) =>
				e.room === room &&
				e.event.type === WsMessageType.RowChange &&
				e.event.table === table &&
				e.event.action === action,
		);
		return entry?.event.row as Record<string, unknown> | undefined;
	}

	async function callMcp(
		agentToken: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const res = await ctx.app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name, arguments: args },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
	}

	async function seedComment(text: string): Promise<string> {
		const r = await ctx.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text })],
		);
		return r.rows[0].id;
	}

	it('MCP create_comment broadcasts task_comments INSERT with project_id (Bug B + A)', async () => {
		const { token: agentToken } = await mintAgentToken(
			ctx.db,
			ctx.masterKeyManager,
			agentId,
			teamId,
		);
		await callMcp(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'live agent comment',
		});

		const row = findRow('task_comments', 'INSERT');
		expect(row).toBeDefined();
		expect(row?.project_id).toBe(projectId);
	});

	it('REST POST comment broadcasts task_comments INSERT with project_id', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: { text: 'human live comment' } }),
		});
		expect(res.status).toBe(201);

		const row = findRow('task_comments', 'INSERT');
		expect(row).toBeDefined();
		expect(row?.project_id).toBe(projectId);
	});

	it('MCP add_reaction / remove_reaction broadcast comment_reactions with project_id', async () => {
		const commentId = await seedComment('react to me');
		const { token: agentToken } = await mintAgentToken(
			ctx.db,
			ctx.masterKeyManager,
			agentId,
			teamId,
		);

		await callMcp(agentToken, 'add_reaction', {
			project: projectId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		const insert = findRow('comment_reactions', 'INSERT');
		expect(insert).toBeDefined();
		expect(insert?.project_id).toBe(projectId);

		captured.length = 0;
		await callMcp(agentToken, 'remove_reaction', {
			project: projectId,
			task_id: taskId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		const remove = findRow('comment_reactions', 'DELETE');
		expect(remove).toBeDefined();
		expect(remove?.project_id).toBe(projectId);
	});

	it('MCP request_credential broadcasts task_comments INSERT with project_id', async () => {
		const { token: agentToken } = await mintAgentToken(
			ctx.db,
			ctx.masterKeyManager,
			agentId,
			teamId,
		);
		const result = await callMcp(agentToken, 'request_credential', {
			project: projectId,
			task_id: taskId,
			name: 'TEST_SECRET',
			kind: CredentialKind.Other,
			instructions: 'Paste the test secret value.',
		});
		expect(result.comment_id).toBeDefined();

		const row = findRow('task_comments', 'INSERT');
		expect(row).toBeDefined();
		expect(row?.project_id).toBe(projectId);
	});
});
