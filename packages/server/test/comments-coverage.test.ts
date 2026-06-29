import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

// Branch-coverage tests for packages/server/src/routes/comments.ts.
// Targets error/validation branches not exercised by comments.test.ts:
// task-not-found 404s, reaction validation (404/403/invalid-kind), comment
// content validation (empty text, missing non-text content, bad parent /
// attachment refs) and fulfill-credential error paths (404 / not-a-request /
// already-fulfilled / confirmation / value-required / validation).

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let taskId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Comments Cov Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Comments Cov Project' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Cov Comment Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Comments Cov Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function postComment(body: Record<string, unknown>): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function createTextComment(text: string): Promise<string> {
	const res = await postComment({ content_type: 'text', content: { text } });
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}

describe('GET comments — task not found', () => {
	it('returns 404 for an unknown identifier (resolves to null)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/MP-99999999/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('returns 200/empty for an unknown UUID (resolveTaskId passes UUIDs through)', async () => {
		// resolveTaskId returns a well-formed UUID as-is without an existence
		// check, so the comments query simply finds no rows → 200 [].
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${UNKNOWN_ID}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});
});

describe('POST comment — validation branches', () => {
	it('returns 404 for an unknown task', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${UNKNOWN_ID}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'text', content: { text: 'hi' } }),
		});
		expect(res.status).toBe(404);
	});

	it('rejects an empty text comment with no attachments', async () => {
		const res = await postComment({ content_type: 'text', content: { text: '' } });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/content or attachment_ids is required/);
	});

	it('rejects a text comment whose content has no text field and no attachments', async () => {
		const res = await postComment({ content_type: 'text', content: {} });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/content or attachment_ids is required/);
	});

	it('rejects a non-text comment missing content', async () => {
		const res = await postComment({ content_type: 'system', content: null });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/content is required/);
	});

	it('rejects a parent_comment_id that does not belong to this task', async () => {
		const res = await postComment({
			content_type: 'text',
			content: { text: 'reply' },
			parent_comment_id: UNKNOWN_ID,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/parent_comment_id does not belong/);
	});

	it('accepts a reply whose parent belongs to the task', async () => {
		const parentId = await createTextComment('parent comment');
		const res = await postComment({
			content_type: 'text',
			content: { text: 'a reply' },
			parent_comment_id: parentId,
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.parent_comment_id).toBe(parentId);
	});

	it('rejects attachment_ids that do not belong to the project', async () => {
		const res = await postComment({
			content_type: 'text',
			content: { text: 'with bogus attachment' },
			attachment_ids: [UNKNOWN_ID],
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/attachments do not belong/);
	});

	it('accepts a string-form content body (content as a bare string)', async () => {
		// The isText branch reads body.content directly when it is a string.
		const res = await postComment({ content_type: 'text', content: 'a bare string body' });
		expect(res.status).toBe(201);
	});
});

describe('reaction PUT/DELETE — error branches', () => {
	it('PUT returns 404 for an unknown task', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${UNKNOWN_ID}/comments/${UNKNOWN_ID}/reactions/ack`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('PUT returns 400 for an invalid reaction kind', async () => {
		const commentId = await createTextComment('reactable comment');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/not-a-kind`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/Unknown reaction kind/);
	});

	it('PUT returns 404 for a comment that does not exist', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${UNKNOWN_ID}/reactions/ack`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('PUT then DELETE a valid ack reaction round-trips', async () => {
		const commentId = await createTextComment('ack target');
		const put = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(put.status).toBe(200);
		const putBody = await put.json();
		expect(putBody.data.kind).toBe('ack');

		const del = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(del.status).toBe(200);
	});

	it('DELETE returns 404 for an unknown task', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${UNKNOWN_ID}/comments/${UNKNOWN_ID}/reactions/ack`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('DELETE returns 400 for an invalid reaction kind', async () => {
		const commentId = await createTextComment('delete-bad-kind target');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/bogus`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});

	it('an agent caller (with a member identity) can react successfully', async () => {
		// Exercises the non-Admin resolveActorMemberId path: an agent token scoped
		// to this team/project resolves to the agent's member id (non-null), so the
		// reaction succeeds rather than 403.
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{ projectId },
		);
		const commentId = await createTextComment('agent reaction target');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'PUT', headers: authHeader(agentToken) },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data.kind).toBe('ack');
	});
});

describe('fulfill-credential — error branches', () => {
	async function createCredentialRequestComment(content: Record<string, unknown>): Promise<string> {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)
			 RETURNING id`,
			[taskId, agentId, JSON.stringify(content)],
		);
		return inserted.rows[0].id;
	}

	it('returns 404 for an unknown task', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${UNKNOWN_ID}/comments/${UNKNOWN_ID}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'x' }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('returns 404 when the comment does not exist', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${UNKNOWN_ID}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'x' }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('rejects a comment that is not a credential request', async () => {
		const commentId = await createTextComment('plain text, not a credential request');
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'x' }),
			},
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/not a credential request/);
	});

	it('rejects when value is missing for a non-confirmation request', async () => {
		const commentId = await createCredentialRequestComment({
			name: 'MY_API_KEY',
			kind: 'api_key',
			allowed_hosts: ['api.example.com'],
		});
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/value is required/);
	});

	it('rejects a value that fails kind validation', async () => {
		const commentId = await createCredentialRequestComment({
			name: 'MY_PAT',
			kind: 'github_pat',
			allowed_hosts: ['github.com'],
		});
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'not-a-real-pat' }),
			},
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/GitHub PAT/);
	});

	it('rejects a confirmation request without confirmed=true', async () => {
		const commentId = await createCredentialRequestComment({
			name: 'CONFIRM_ACTION',
			kind: 'other',
			confirmation_text: 'Please confirm',
		});
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirmed: false }),
			},
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/confirmed must be true/);
	});

	it('fulfills a valid api_key credential request and stores a secret', async () => {
		const commentId = await createCredentialRequestComment({
			name: 'STRIPE_KEY',
			kind: 'api_key',
			allowed_hosts: ['api.stripe.com'],
		});
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'sk_test_abc123', allowed_hosts: ['api.stripe.com'] }),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.comment_id).toBe(commentId);
		expect(body.data.secret_id).toBeTruthy();

		const secret = await db.query<{ name: string; allow_body_substitution: boolean }>(
			'SELECT name, allow_body_substitution FROM secrets WHERE id = $1',
			[body.data.secret_id],
		);
		expect(secret.rows[0].name).toBe('STRIPE_KEY');
	});

	it('rejects fulfilling an already-fulfilled credential request', async () => {
		const commentId = await createCredentialRequestComment({
			name: 'ONCE_KEY',
			kind: 'api_key',
			allowed_hosts: ['api.example.com'],
		});
		const first = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'sk_live_once' }),
			},
		);
		expect(first.status).toBe(200);

		const second = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'sk_live_twice' }),
			},
		);
		expect(second.status).toBe(400);
		expect((await second.json()).error.message).toMatch(/already fulfilled/);
	});

	it('fulfills a confirmation request with confirmed=true', async () => {
		const commentId = await createCredentialRequestComment({
			name: 'CONFIRM_OK',
			kind: 'other',
			confirmation_text: 'Confirm please',
		});
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirmed: true }),
			},
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data.comment_id).toBe(commentId);
	});
});
