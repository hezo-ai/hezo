import { randomUUID } from 'node:crypto';
import { COMMENT_ATTACHMENTS_MAX, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { type AgentAttachment, buildTaskPrompt } from '../src/services/agent-runner';
import { checkProjectAssetIds } from '../src/services/asset-ownership';
import { blobBytes, safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let agentId: string;
let taskId: string;
let taskIdentifier: string;
let otherProjectId: string;
let otherTeamId: string;

async function createAgentAndTask(
	pId: string,
	title: string,
): Promise<{ agentId: string; taskId: string; identifier: string }> {
	const agentRes = await app.request(`/api/projects/${pId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: `${title} Bot` }),
	});
	const aId = (await agentRes.json()).data.id;
	const taskRes = await app.request(`/api/projects/${pId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: pId, title, assignee_id: aId }),
	});
	if (taskRes.status !== 201) throw new Error(`task create: ${await taskRes.text()}`);
	const task = (await taskRes.json()).data;
	return { agentId: aId, taskId: task.id, identifier: task.identifier };
}

async function agentToken(): Promise<{ token: string; runId: string }> {
	const minted = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId, {
		projectId,
	});
	return { token: minted.token, runId: minted.runId };
}

async function uploadViaMcp(
	authToken: string,
	filename: string,
	fields: Record<string, string> = {},
): Promise<Response> {
	const fd = new FormData();
	const bytes = new TextEncoder().encode(`contents of ${filename}`);
	fd.set('file', new File([blobBytes(bytes)], filename, { type: 'text/plain' }));
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return app.request('/mcp/assets', {
		method: 'POST',
		headers: { ...authHeader(authToken) },
		body: fd,
	});
}

async function uploadForTask(authToken: string, filename: string): Promise<string> {
	const res = await uploadViaMcp(authToken, filename, { task: taskIdentifier });
	if (res.status !== 201) throw new Error(`upload: ${res.status} ${await res.text()}`);
	return (await res.json()).data.id;
}

async function callTool(
	authToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return await callMcpTool(app, authToken, toolName, args);
}

async function textCommentCount(): Promise<number> {
	const r = await db.query<{ n: string }>(
		`SELECT count(*) AS n FROM task_comments WHERE task_id = $1 AND content_type = 'text'`,
		[taskId],
	);
	return Number(r.rows[0].n);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Agent Attach Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Agent Attach',
		description: 'Agent attachments.',
	});
	projectId = (await projectRes.json()).data.id;
	const created = await createAgentAndTask(projectId, 'Hand over the archive');
	agentId = created.agentId;
	taskId = created.taskId;
	taskIdentifier = created.identifier;

	// A team owns exactly one project, so the foreign project needs its own team.
	const otherTeamRes = await createTestTeam(db, { name: 'Other Agent Attach Co' });
	otherTeamId = (await otherTeamRes.json()).data.id;
	const otherProjectRes = await createTestProject(db, otherTeamId, {
		name: 'Elsewhere',
		description: 'Foreign project.',
	});
	otherProjectId = (await otherProjectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /mcp/assets with a task', () => {
	it("files the upload with the task's attachments and marks the run as productive", async () => {
		const { token: t, runId } = await agentToken();
		const res = await uploadViaMcp(t, 'findings.txt', { task: taskIdentifier });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.original_filename).toBe(`uploads/${taskIdentifier}/findings.txt`);

		const run = await db.query<{ produced_output: boolean }>(
			'SELECT produced_output FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].produced_output).toBe(true);
	});

	it('accepts the task by UUID as well as by identifier', async () => {
		const { token: t } = await agentToken();
		const res = await uploadViaMcp(t, 'by-uuid.txt', { task: taskId });
		expect(res.status).toBe(201);
		expect((await res.json()).data.original_filename).toBe(`uploads/${taskIdentifier}/by-uuid.txt`);
	});

	it('lets an explicit path decide where the file lands', async () => {
		const { token: t } = await agentToken();
		const res = await uploadViaMcp(t, 'chart.txt', {
			task: taskIdentifier,
			path: 'reports/chart.txt',
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.original_filename).toBe('reports/chart.txt');
	});

	it('refuses an unknown task and stores nothing', async () => {
		const { token: t } = await agentToken();
		const before = await db.query<{ n: string }>(
			'SELECT count(*) AS n FROM assets WHERE project_id = $1',
			[projectId],
		);
		const res = await uploadViaMcp(t, 'lost.txt', { task: 'NOPE-999' });
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
		const after = await db.query<{ n: string }>(
			'SELECT count(*) AS n FROM assets WHERE project_id = $1',
			[projectId],
		);
		expect(after.rows[0].n).toBe(before.rows[0].n);
	});
});

describe('checkProjectAssetIds', () => {
	it('keeps a repeated id once', async () => {
		const { token: t } = await agentToken();
		const id = await uploadForTask(t, 'dupe.txt');
		const res = await checkProjectAssetIds(db, projectId, [id, id]);
		expect(res).toEqual({ ok: true, ids: [id] });
	});

	it('treats a missing list as no attachments', async () => {
		expect(await checkProjectAssetIds(db, projectId, undefined)).toEqual({ ok: true, ids: [] });
	});

	it('rejects a value that is not a list of strings', async () => {
		const res = await checkProjectAssetIds(db, projectId, 'not-a-list');
		expect(res.ok).toBe(false);
	});

	it('rejects a malformed id instead of failing the query', async () => {
		const res = await checkProjectAssetIds(db, projectId, ['not-a-uuid']);
		expect(res).toEqual({
			ok: false,
			message: 'One or more attachment ids are not valid asset ids',
		});
	});

	it('rejects an id that names no asset', async () => {
		const res = await checkProjectAssetIds(db, projectId, [randomUUID()]);
		expect(res.ok).toBe(false);
	});

	it('rejects an archived asset', async () => {
		const { token: t } = await agentToken();
		const id = await uploadForTask(t, 'archived.txt');
		await db.query('UPDATE assets SET archived_at = now() WHERE id = $1', [id]);
		const res = await checkProjectAssetIds(db, projectId, [id]);
		expect(res.ok).toBe(false);
	});

	it('rejects an asset from another project', async () => {
		const other = await createAgentAndTask(otherProjectId, 'Foreign task');
		const { token: foreignToken } = await mintAgentToken(
			db,
			masterKeyManager,
			other.agentId,
			otherTeamId,
			other.taskId,
			{ projectId: otherProjectId },
		);
		const res = await uploadViaMcp(foreignToken, 'foreign.txt');
		const foreignId = (await res.json()).data.id;
		const check = await checkProjectAssetIds(db, projectId, [foreignId]);
		expect(check).toEqual({
			ok: false,
			message: 'One or more attachments do not belong to this project',
		});
	});

	it('rejects more distinct ids than the limit', async () => {
		const ids = Array.from({ length: 3 }, () => randomUUID());
		const res = await checkProjectAssetIds(db, projectId, ids, 2);
		expect(res).toEqual({ ok: false, message: 'At most 2 attachments per comment' });
	});
});

describe('create_comment with attachment_ids', () => {
	it('attaches uploaded files, and another reader gets signed links to them', async () => {
		const { token: t } = await agentToken();
		const first = await uploadForTask(t, 'part-1.txt');
		const second = await uploadForTask(t, 'part-2.txt');

		const ack = await callTool(t, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Both halves attached.',
			attachment_ids: [first, second, first],
		});
		expect(ack.error).toBeUndefined();
		expect(ack.attachment_ids).toEqual([first, second]);
		expect(ack).not.toHaveProperty('content');

		const linked = await db.query<{ asset_id: string }>(
			'SELECT asset_id FROM comment_attachments WHERE comment_id = $1 ORDER BY asset_id',
			[ack.id],
		);
		expect(linked.rows.map((r) => r.asset_id).sort()).toEqual([first, second].sort());

		const read = (await callTool(token, 'get_comment', {
			project: projectId,
			comment_id: ack.id,
		})) as { attachments?: Array<{ id: string; url: string }> };
		expect(read.attachments?.map((a) => a.id).sort()).toEqual([first, second].sort());
		for (const a of read.attachments ?? []) {
			expect(a.url).toMatch(/\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
		}
	});

	it('posts a comment that carries only a file', async () => {
		const { token: t } = await agentToken();
		const id = await uploadForTask(t, 'only-file.txt');
		const ack = await callTool(t, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '',
			attachment_ids: [id],
		});
		expect(ack.error).toBeUndefined();
		expect(ack.attachment_ids).toEqual([id]);
	});

	it('refuses a comment with neither text nor files', async () => {
		const { token: t } = await agentToken();
		const before = await textCommentCount();
		const res = await callTool(t, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '   ',
		});
		expect(res.error).toBe('Provide comment text, attachment_ids, or both');
		expect(await textCommentCount()).toBe(before);
	});

	it('refuses a bad attachment and posts nothing', async () => {
		const { token: t } = await agentToken();
		const archived = await uploadForTask(t, 'gone.txt');
		await db.query('UPDATE assets SET archived_at = now() WHERE id = $1', [archived]);
		const tooMany = Array.from({ length: COMMENT_ATTACHMENTS_MAX + 1 }, () => randomUUID());
		const before = await textCommentCount();
		for (const attachment_ids of [['nope'], [archived], [randomUUID()], tooMany]) {
			const res = await callTool(t, 'create_comment', {
				project: projectId,
				task_id: taskId,
				content: 'with a bad file',
				attachment_ids,
			});
			expect(typeof res.error, JSON.stringify(attachment_ids)).toBe('string');
		}
		expect(await textCommentCount()).toBe(before);
	});
});

describe('the comments route', () => {
	it('answers a malformed attachment id with a 400', async () => {
		const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'bad id' },
				attachment_ids: ['not-a-uuid'],
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('refuses more attachments than a comment takes', async () => {
		const ids = Array.from({ length: COMMENT_ATTACHMENTS_MAX + 1 }, () => randomUUID());
		const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'too many' },
				attachment_ids: ids,
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe("the run prompt keeps the waking comment's files", () => {
	const task: Parameters<typeof buildTaskPrompt>[1] = {
		id: 'task-1',
		identifier: 'AA-1',
		title: 'Review the archive',
		description: 'Check it.',
		status: 'in_progress',
		priority: 'medium',
		project_id: 'project-1',
		rules: null,
		progress_summary: null,
	};
	const attachment: AgentAttachment = {
		id: 'asset-1',
		original_filename: 'uploads/AA-1/archive.zip',
		content_type: 'application/zip',
		byte_size: 3_900_000,
		url: 'http://127.0.0.1:1/api/assets/asset-1?exp=1&sig=abc',
	};

	it('lists the files attached to the mention that woke the agent', () => {
		const prompt = buildTaskPrompt(
			'system',
			task,
			{ source: WakeupSource.Mention },
			{
				mentionContext: {
					authorName: 'Researcher',
					excerpt: '@reviewer the archive is attached',
					openTickets: [],
					triggeringCommentId: 'comment-1',
				},
				handoffAttachments: new Map([['comment-1', [attachment]]]),
			},
		);
		expect(prompt).toContain('Files attached to it:');
		expect(prompt).toContain(
			'attachment: uploads/AA-1/archive.zip (application/zip, 3900000 bytes) → download: http://127.0.0.1:1/api/assets/asset-1?exp=1&sig=abc',
		);
	});

	it('adds no file section when the quoted comment has none', () => {
		const prompt = buildTaskPrompt(
			'system',
			task,
			{ source: WakeupSource.Mention },
			{
				mentionContext: {
					authorName: 'Researcher',
					excerpt: '@reviewer please look',
					openTickets: [],
					triggeringCommentId: 'comment-2',
				},
				handoffAttachments: new Map([['comment-1', [attachment]]]),
			},
		);
		expect(prompt).not.toContain('Files attached to it:');
	});

	it('lists the files under the reply that carries them, not under the original', () => {
		const prompt = buildTaskPrompt(
			'system',
			task,
			{ source: WakeupSource.Reply },
			{
				replyContext: {
					responderName: 'Reviewer',
					responderSlug: 'reviewer',
					replyExcerpt: 'Fixed version attached',
					originalExcerpt: 'Please send the fixed archive',
					replyCommentId: 'reply-1',
					originalCommentId: 'original-1',
					referencedTasks: [],
				},
				handoffAttachments: new Map([['reply-1', [attachment]]]),
			},
		);
		const reply = prompt.indexOf('### Their reply');
		expect(reply).toBeGreaterThan(-1);
		expect(prompt.indexOf('Files attached to it:')).toBeGreaterThan(reply);
		expect(prompt.match(/Files attached to it:/g)).toHaveLength(1);
	});
});
