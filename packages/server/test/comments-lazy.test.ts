import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let taskId: string;
let textCommentId: string;
let systemCommentId: string;
let otherTaskCommentId: string;

const json = (extra: Record<string, string> = {}) => ({
	...authHeader(token),
	'Content-Type': 'application/json',
	...extra,
});

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamData = (await (await createTestTeam(db, { name: 'Lazy Co' })).json()).data;
	const projectData = (
		await (await createTestProject(db, teamData.id, { name: 'Lazy', description: 'x' })).json()
	).data;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: json(),
		body: JSON.stringify({ title: 'Lazy Bot' }),
	});
	const agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: json(),
		body: JSON.stringify({ project_id: projectData.id, title: 'Lazy Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;

	// A text comment (its body is the deferred payload) + a reaction on it.
	const textRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
		method: 'POST',
		headers: json(),
		body: JSON.stringify({ content_type: 'text', content: { text: 'Hello lazy' } }),
	});
	textCommentId = (await textRes.json()).data.id;
	await app.request(
		`/api/projects/${projectSlug}/tasks/${taskId}/comments/${textCommentId}/reactions/ack`,
		{ method: 'PUT', headers: json() },
	);

	// A system (inline-event) comment — its small content stays on the skeleton.
	const sys = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, content_type, content)
		 VALUES ($1, 'system'::comment_content_type, $2::jsonb) RETURNING id`,
		[taskId, JSON.stringify({ text: 'moved to In progress', kind: 'status_change' })],
	);
	systemCommentId = sys.rows[0].id;

	// A comment on a DIFFERENT task, for the cross-task rejection test.
	const otherTaskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: json(),
		body: JSON.stringify({ project_id: projectData.id, title: 'Other Task', assignee_id: agentId }),
	});
	const otherTaskId = (await otherTaskRes.json()).data.id;
	const otherRes = await app.request(`/api/projects/${projectSlug}/tasks/${otherTaskId}/comments`, {
		method: 'POST',
		headers: json(),
		body: JSON.stringify({ content_type: 'text', content: { text: 'elsewhere' } }),
	});
	otherTaskCommentId = (await otherRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('comments skeleton mode (?view=skeleton)', () => {
	it('omits text bodies but keeps metadata, hints and reactions', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?view=skeleton`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;

		const text = rows.find((r) => r.id === textCommentId)!;
		expect(text.content_type).toBe('text');
		expect(text.content).toBeNull(); // body deferred
		expect(text.text_length).toBe('Hello lazy'.length);
		expect(text.attachment_count).toBe(0);
		expect(text.author_name).toBe('Admin');
		// Reactions ride along on the skeleton (single source of truth).
		expect((text.reactions as unknown[]).length).toBe(1);

		const system = rows.find((r) => r.id === systemCommentId)!;
		// Non-text comments keep their small structural content on the skeleton.
		expect((system.content as { kind?: string }).kind).toBe('status_change');
		expect(system.text_length).toBeNull();
	});
});

describe('comments body mode (?ids=)', () => {
	it('returns content + attachments for the requested ids, without reactions', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?ids=${textCommentId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		expect(rows.length).toBe(1);
		expect(rows[0].id).toBe(textCommentId);
		expect((rows[0].content as { text?: string }).text).toBe('Hello lazy');
		expect(Array.isArray(rows[0].attachments)).toBe(true);
		expect(rows[0].reactions).toBeUndefined();
	});

	it('rejects an id belonging to another task (no cross-task leak)', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?ids=${otherTaskCommentId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('tolerates a non-existent id (deleted mid-scroll) by omitting it', async () => {
		const gone = '00000000-0000-4000-8000-000000000000';
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?ids=${textCommentId},${gone}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ id: string }>;
		expect(rows.map((r) => r.id)).toEqual([textCommentId]);
	});

	it('rejects a non-UUID id', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?ids=not-a-uuid`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});

	it('rejects a batch over the id cap', async () => {
		const many = Array.from({ length: 101 }, () => '00000000-0000-4000-8000-000000000000').join(
			',',
		);
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?ids=${many}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});
});

describe('comments full mode (default) is unchanged', () => {
	it('still returns bodies, reactions and attachments inline', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		const text = rows.find((r) => r.id === textCommentId)!;
		expect((text.content as { text?: string }).text).toBe('Hello lazy');
		expect((text.reactions as unknown[]).length).toBe(1);
		expect(Array.isArray(text.attachments)).toBe(true);
	});
});
