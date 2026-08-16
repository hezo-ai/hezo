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
let teamId: string;
let agentMemberId: string;
let failedRunCommentId: string;
let goneRunCommentId: string;
let malformedRunCommentId: string;

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
	teamId = teamData.id;
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
	agentMemberId = agentId;

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

	// Three run comments covering what the route has to resolve: a run that
	// failed, a run whose heartbeat_runs row is gone, and a row whose stored
	// run_id is not a UUID at all. None of them writes a `run_failed` notice —
	// that is the situation the failure-ping cap leaves behind.
	const insertRunComment = async (runId: string): Promise<string> => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'run'::comment_content_type, $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ run_id: runId, agent_slug: 'lazy-bot' })],
		);
		return r.rows[0].id;
	};

	const failedRun = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
		 VALUES ($1, $2, $3, 'failed'::heartbeat_run_status) RETURNING id`,
		[teamId, agentId, taskId],
	);
	failedRunCommentId = await insertRunComment(failedRun.rows[0].id);
	goneRunCommentId = await insertRunComment('00000000-0000-4000-8000-000000000000');
	malformedRunCommentId = await insertRunComment('not-a-uuid');

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

	// A folded run row never mounts, so it never fetches its own run. Without the
	// outcome on the skeleton the collapsed-group chip has nothing but the
	// `run_failed` notices to count, and those stop being written after a streak.
	it('carries the real outcome of each run comment as run_status', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?view=skeleton`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;

		expect(rows.find((r) => r.id === failedRunCommentId)!.run_status).toBe('failed');
		// The run is gone; we looked and found nothing, which is not the same as
		// never having looked - the reader falls back to the notices.
		expect(rows.find((r) => r.id === goneRunCommentId)!.run_status).toBeNull();
		// Rows that are not runs are left alone entirely.
		expect(rows.find((r) => r.id === textCommentId)!.run_status).toBeUndefined();
		expect(rows.find((r) => r.id === systemCommentId)!.run_status).toBeUndefined();
	});

	// Regression guard: resolving the status by joining through
	// `content->>'run_id'` casts unconstrained JSONB to uuid, and one bad row
	// would abort the statement and 500 the whole thread with no way to recover.
	it('serves the thread when a run comment holds a malformed run_id', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?view=skeleton`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		expect(rows.find((r) => r.id === malformedRunCommentId)!.run_status).toBeNull();
		// The rest of the thread is intact.
		expect(rows.find((r) => r.id === failedRunCommentId)!.run_status).toBe('failed');
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
