import { generateKeyPairSync } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { blobBytes, safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	finalizeAgentRun,
	mintAgentToken,
} from './helpers/app';

// Line-coverage tests for packages/server/src/routes/comments.ts over real
// HTTP: the comment list with reactions + attachments, reaction round-trips
// (incl. the no-member-identity 403), comment creation (attachments,
// mention-only wakeups, agent author, reply wakeups), the fulfill-credential flow
// across every secret-category kind (host overrides, body substitution,
// requester wakeups) and resolve-asset-deletion approve/deny with all its
// validation branches.

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let agentId: string;
let taskId: string;
let adminUserId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Comments Uncov Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Comments Uncov Project' });
	projectSlug = (await projectRes.json()).data.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Comment Uncov Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Comments Uncov Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;

	const admin = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1',
	);
	adminUserId = admin.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function postComment(body: Record<string, unknown>, authToken = token): Promise<Response> {
	return app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function createTextComment(text: string): Promise<string> {
	const res = await postComment({ content_type: 'text', content: { text } });
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}

function buildPng(seed = 0): Uint8Array {
	const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const extra = new Uint8Array(24);
	for (let i = 0; i < extra.length; i++) extra[i] = (i + seed) & 0xff;
	const out = new Uint8Array(sig.length + extra.length);
	out.set(sig, 0);
	out.set(extra, sig.length);
	return out;
}

async function uploadAsset(filename: string): Promise<{ id: string; path: string }> {
	const fd = new FormData();
	fd.set('file', new File([blobBytes(buildPng(filename.length))], filename, { type: 'image/png' }));
	const res = await app.request(`/api/projects/${projectSlug}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
	expect(res.status).toBe(201);
	const body = await res.json();
	return { id: body.data.id, path: body.data.original_filename };
}

async function fulfill(
	commentId: string,
	body: Record<string, unknown>,
	taskRef: string = taskId,
): Promise<Response> {
	return app.request(
		`/api/projects/${projectSlug}/tasks/${taskRef}/comments/${commentId}/fulfill-credential`,
		{
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		},
	);
}

async function seedCredentialRequest(content: Record<string, unknown>): Promise<string> {
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[taskId, agentId, JSON.stringify(content)],
	);
	return inserted.rows[0].id;
}

describe('GET comments — reactions and attachments hydrate', () => {
	it('returns comments with reactions, attachments (signed url) and author names', async () => {
		const asset = await uploadAsset('listed.png');
		const create = await postComment({
			content_type: 'text',
			content: { text: 'comment with attachment' },
			attachment_ids: [asset.id],
		});
		expect(create.status).toBe(201);
		const createdBody = (await create.json()).data;
		expect(createdBody.attachments).toHaveLength(1);
		const commentId = createdBody.id;

		const react = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(react.status).toBe(200);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data;
		const row = rows.find((r: { id: string }) => r.id === commentId);
		// Admin comments carry no member row: type is null, name falls back.
		expect(row.author_type).toBeNull();
		expect(row.author_name).toBe('Admin');
		expect(row.reactions).toHaveLength(1);
		expect(row.reactions[0].kind).toBe('ack');
		expect(row.attachments).toHaveLength(1);
		expect(row.attachments[0].id).toBe(asset.id);
		expect(row.attachments[0].original_filename).toBe('listed.png');
		expect(row.attachments[0].url).toContain(asset.id);
	});

	it('404s for an unknown identifier', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/QQ-42424242/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('reactions — identity and validation branches', () => {
	it('403s a caller with no member identity in the team (PUT and DELETE)', async () => {
		// A second superuser spans all teams via access control but has no member
		// row in this team — nor in HQ, since it is inserted directly rather than
		// enrolled — so the reactor fallback (current team → HQ) finds nothing and
		// the reaction routes reject with FORBIDDEN.
		const stray = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Stray Admin', true) RETURNING id",
		);
		const strayToken = await signAdminJwt(masterKeyManager, stray.rows[0].id);
		const commentId = await createTextComment('membership target');

		const put = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'PUT', headers: authHeader(strayToken) },
		);
		expect(put.status).toBe(403);
		expect((await put.json()).error.message).toMatch(/No member identity/);

		const del = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'DELETE', headers: authHeader(strayToken) },
		);
		expect(del.status).toBe(403);
	});

	it('rejects invalid kinds and unknown tasks/comments on both verbs', async () => {
		const commentId = await createTextComment('kind target');
		for (const method of ['PUT', 'DELETE'] as const) {
			const badKind = await app.request(
				`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/party`,
				{ method, headers: authHeader(token) },
			);
			expect(badKind.status).toBe(400);

			const badTask = await app.request(
				`/api/projects/${projectSlug}/tasks/QQ-999999/comments/${commentId}/reactions/ack`,
				{ method, headers: authHeader(token) },
			);
			expect(badTask.status).toBe(404);

			const badComment = await app.request(
				`/api/projects/${projectSlug}/tasks/${taskId}/comments/${UNKNOWN_UUID}/reactions/ack`,
				{ method, headers: authHeader(token) },
			);
			expect(badComment.status).toBe(404);
		}
	});

	it('round-trips an agent reaction', async () => {
		const commentId = await createTextComment('agent reaction target');
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const put = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'PUT', headers: authHeader(agentToken) },
		);
		expect(put.status).toBe(200);
		expect((await put.json()).data.reactions).toHaveLength(1);
		const del = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ method: 'DELETE', headers: authHeader(agentToken) },
		);
		expect(del.status).toBe(200);
		expect((await del.json()).data.reactions).toHaveLength(0);
		await finalizeAgentRun(db, runId);
	});
});

describe('POST comment — creation branches', () => {
	it('404s when the task row does not exist for a well-formed UUID', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${UNKNOWN_UUID}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'text', content: { text: 'hi' } }),
		});
		expect(res.status).toBe(404);
	});

	it('accepts a bare-string content body and rejects a non-string/non-object one', async () => {
		const bare = await postComment({ content_type: 'text', content: 'plain string body' });
		expect(bare.status).toBe(201);

		const numeric = await postComment({ content_type: 'text', content: 42 });
		expect(numeric.status).toBe(400);
	});

	it('validates content shapes and attachment/parent ownership', async () => {
		expect((await postComment({ content_type: 'text', content: { text: '' } })).status).toBe(400);
		expect((await postComment({ content_type: 'text', content: {} })).status).toBe(400);
		expect((await postComment({ content_type: 'system', content: null })).status).toBe(400);
		expect(
			(
				await postComment({
					content_type: 'text',
					content: { text: 'x' },
					parent_comment_id: UNKNOWN_UUID,
				})
			).status,
		).toBe(400);
		expect(
			(
				await postComment({
					content_type: 'text',
					content: { text: 'x' },
					attachment_ids: [UNKNOWN_UUID],
				})
			).status,
		).toBe(400);
	});

	it('accepts an attachments-only comment (empty text)', async () => {
		const asset = await uploadAsset('only-attachment.png');
		const res = await postComment({
			content_type: 'text',
			content: { text: '' },
			attachment_ids: [asset.id],
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.attachments).toHaveLength(1);
		const joins = await db.query('SELECT 1 FROM comment_attachments WHERE comment_id = $1', [
			data.id,
		]);
		expect(joins.rows).toHaveLength(1);
	});

	it('a plain admin comment does not wake the assignee (wakeups are mention-only)', async () => {
		const res = await postComment({
			content_type: 'text',
			content: { text: 'please pick this up' },
		});
		expect(res.status).toBe(201);
		const commentId = (await res.json()).data.id;
		const wakeup = await db.query(
			`SELECT 1 FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'comment_id' = $2`,
			[agentId, commentId],
		);
		expect(wakeup.rows).toHaveLength(0);
	});

	it('an agent-authored comment carries the agent identity', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const res = await postComment(
			{ content_type: 'text', content: { text: 'from the agent' } },
			agentToken,
		);
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.author_member_id).toBe(agentId);
		await finalizeAgentRun(db, runId);
	});

	it('a human reply to an agent comment fires a reply wakeup for the agent', async () => {
		const parent = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"agent asks"}'::jsonb)
			 RETURNING id`,
			[taskId, agentId],
		);
		const parentId = parent.rows[0].id;
		const res = await postComment({
			content_type: 'text',
			content: { text: 'answering you' },
			parent_comment_id: parentId,
		});
		expect(res.status).toBe(201);
		const commentId = (await res.json()).data.id;
		const wakeup = await db.query(
			`SELECT 1 FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'triggering_comment_id' = $2
			   AND payload->>'comment_id' = $3`,
			[agentId, parentId, commentId],
		);
		expect(wakeup.rows).toHaveLength(1);
	});
});

describe('fulfill-credential — validation and category matrix', () => {
	it('rejects the standard error shapes', async () => {
		// Unknown task (identifier form) and unknown comment.
		expect((await fulfill(UNKNOWN_UUID, { value: 'x' }, 'QQ-99999')).status).toBe(404);
		expect((await fulfill(UNKNOWN_UUID, { value: 'x' })).status).toBe(404);

		// Not a credential request.
		const textId = await createTextComment('not a credential request');
		const wrongType = await fulfill(textId, { value: 'x' });
		expect(wrongType.status).toBe(400);
		expect((await wrongType.json()).error.message).toMatch(/not a credential request/);

		// Missing value / failing kind validation / unconfirmed confirmation.
		const needsValue = await seedCredentialRequest({ name: 'NEEDS_VALUE', kind: 'api_key' });
		expect((await fulfill(needsValue, {})).status).toBe(400);

		const badPat = await seedCredentialRequest({ name: 'BAD_PAT', kind: 'github_pat' });
		const patRes = await fulfill(badPat, { value: 'nope' });
		expect(patRes.status).toBe(400);
		expect((await patRes.json()).error.message).toMatch(/GitHub PAT/);

		const confirm = await seedCredentialRequest({
			name: 'CONFIRM_IT',
			kind: 'other',
			confirmation_text: 'confirm?',
		});
		expect((await fulfill(confirm, { confirmed: false })).status).toBe(400);
	});

	it('stores each kind under its secret category and wakes the requester', async () => {
		const { privateKey } = generateKeyPairSync('ed25519');
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

		const cases: Array<{ name: string; kind: string; value: string; category: string }> = [
			{ name: 'SSH_KEY_SECRET', kind: 'ssh_private_key', value: pem, category: 'ssh_key' },
			{
				name: 'PAT_SECRET',
				kind: 'github_pat',
				value: `ghp_${'a'.repeat(24)}`,
				category: 'api_token',
			},
			{
				name: 'OAUTH_SECRET',
				kind: 'oauth_token',
				value: 'tok-123',
				category: 'api_token',
			},
			{
				name: 'HOOK_SECRET',
				kind: 'webhook_secret',
				value: 'whsec_x',
				category: 'credential',
			},
			{ name: 'MISC_SECRET', kind: 'other', value: 'anything', category: 'other' },
		];

		for (const c of cases) {
			const commentId = await seedCredentialRequest({
				name: c.name,
				kind: c.kind,
				allowed_hosts: ['api.example.com'],
			});
			const res = await fulfill(commentId, { value: c.value });
			expect(res.status).toBe(200);
			const body = (await res.json()).data;
			const secret = await db.query<{ name: string; category: string }>(
				'SELECT name, category::text AS category FROM secrets WHERE id = $1',
				[body.secret_id],
			);
			expect(secret.rows[0].name).toBe(c.name);
			expect(secret.rows[0].category).toBe(c.category);

			// The requesting agent is woken with the outcome (coalescing-safe match).
			const wakeup = await db.query<{ payload: { secret_id: string } }>(
				`SELECT payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND payload->>'comment_id' = $2
				 ORDER BY created_at DESC LIMIT 1`,
				[agentId, commentId],
			);
			expect(wakeup.rows).toHaveLength(1);
			expect(wakeup.rows[0].payload.secret_id).toBe(body.secret_id);

			// A "credential provided" system comment landed on the task.
			const system = await db.query(
				`SELECT 1 FROM task_comments
				 WHERE task_id = $1 AND content_type = 'system'
				   AND content->>'text' LIKE '%' || $2 || '%'`,
				[taskId, c.name],
			);
			expect(system.rows.length).toBeGreaterThanOrEqual(1);
		}
	});

	it('honours host overrides and an explicit body-substitution decision', async () => {
		const commentId = await seedCredentialRequest({
			name: 'HOSTS_SECRET',
			kind: 'api_key',
			allowed_hosts: ['agent-requested.example.com'],
			allow_body_substitution: true,
		});
		const res = await fulfill(commentId, {
			value: 'sk_override',
			allowed_hosts: ['  Corrected.Example.COM ', ''],
			allow_body_substitution: false,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		const secret = await db.query<{ allowed_hosts: string[]; allow_body_substitution: boolean }>(
			'SELECT allowed_hosts, allow_body_substitution FROM secrets WHERE id = $1',
			[body.secret_id],
		);
		expect(secret.rows[0].allowed_hosts).toEqual(['corrected.example.com']);
		expect(secret.rows[0].allow_body_substitution).toBe(false);
	});

	it("keeps the agent's requested hosts and substitution flag when unset", async () => {
		const commentId = await seedCredentialRequest({
			name: 'AGENT_HOSTS_SECRET',
			kind: 'api_key',
			allowed_hosts: ['api.agent.example.com'],
			allow_body_substitution: true,
		});
		const res = await fulfill(commentId, { value: 'sk_asks' });
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		const secret = await db.query<{ allowed_hosts: string[]; allow_body_substitution: boolean }>(
			'SELECT allowed_hosts, allow_body_substitution FROM secrets WHERE id = $1',
			[body.secret_id],
		);
		expect(secret.rows[0].allowed_hosts).toEqual(['api.agent.example.com']);
		expect(secret.rows[0].allow_body_substitution).toBe(true);
	});

	it('503s when the master key is unavailable', async () => {
		const commentId = await seedCredentialRequest({ name: 'LOCKED_OUT', kind: 'api_key' });
		// The JWT key is memoized separately from the encryption key, so nulling
		// the in-memory encryption key simulates a locked vault while requests
		// still authenticate.
		const holder = masterKeyManager as unknown as { key: Buffer | null };
		const saved = holder.key;
		holder.key = null;
		try {
			const res = await fulfill(commentId, { value: 'sk_locked' });
			expect(res.status).toBe(503);
			expect((await res.json()).error.code).toBe('LOCKED');
		} finally {
			holder.key = saved;
		}
		// Nothing was stored while locked.
		const secret = await db.query("SELECT 1 FROM secrets WHERE name = 'LOCKED_OUT'");
		expect(secret.rows).toHaveLength(0);
	});

	it('fulfills a confirmation request and rejects a second fulfillment', async () => {
		const commentId = await seedCredentialRequest({
			name: 'CONFIRM_DONE',
			kind: 'other',
			confirmation_text: 'ok to proceed?',
		});
		const first = await fulfill(commentId, { confirmed: true });
		expect(first.status).toBe(200);
		const chosen = await db.query<{ chosen_option: { secret_id: string } }>(
			'SELECT chosen_option FROM task_comments WHERE id = $1',
			[commentId],
		);
		expect(chosen.rows[0].chosen_option.secret_id).toBeTruthy();

		const second = await fulfill(commentId, { confirmed: true });
		expect(second.status).toBe(400);
		expect((await second.json()).error.message).toMatch(/already fulfilled/);
	});
});

describe('resolve-asset-deletion', () => {
	async function seedDeletionRequest(assets: Array<{ id: string; path: string }>): Promise<string> {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'asset_deletion_request'::comment_content_type, $3::jsonb)
			 RETURNING id`,
			[taskId, agentId, JSON.stringify({ assets, reason: 'cleanup', text: 'delete these' })],
		);
		const commentId = inserted.rows[0].id;
		await db.query(
			'INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id) VALUES ($1, $2, $3, $4)',
			[teamId, taskId, commentId, adminUserId],
		);
		return commentId;
	}

	async function resolve(
		commentId: string,
		body: Record<string, unknown>,
		authToken = token,
		taskRef = taskId,
	): Promise<Response> {
		return app.request(
			`/api/projects/${projectSlug}/tasks/${taskRef}/comments/${commentId}/resolve-asset-deletion`,
			{
				method: 'POST',
				headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		);
	}

	it('validates caller, task, approve flag, comment type and repeat resolution', async () => {
		const asset = await uploadAsset('validate-me.png');
		const commentId = await seedDeletionRequest([asset]);

		// Agents cannot resolve — even the requester.
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		expect((await resolve(commentId, { approve: true }, agentToken)).status).toBe(403);
		await finalizeAgentRun(db, runId);

		expect((await resolve(commentId, { approve: true }, token, 'QQ-55555')).status).toBe(404);
		expect((await resolve(commentId, { approve: 'yes' })).status).toBe(400);
		expect((await resolve(UNKNOWN_UUID, { approve: true })).status).toBe(404);

		const textId = await createTextComment('not a deletion request');
		const wrongType = await resolve(textId, { approve: true });
		expect(wrongType.status).toBe(400);
		expect((await wrongType.json()).error.message).toMatch(/not an asset deletion request/);

		// Deny once, then any second resolution is rejected.
		expect((await resolve(commentId, { approve: false })).status).toBe(200);
		const again = await resolve(commentId, { approve: true });
		expect(again.status).toBe(400);
		expect((await again.json()).error.message).toMatch(/already resolved/);
	});

	it('deny keeps assets, records the outcome and wakes the requester', async () => {
		const asset = await uploadAsset('spared-uncov.png');
		const commentId = await seedDeletionRequest([asset]);
		const res = await resolve(commentId, { approve: false });
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.status).toBe('denied');
		expect(body.deleted_asset_ids).toEqual([]);

		const kept = await db.query('SELECT 1 FROM assets WHERE id = $1', [asset.id]);
		expect(kept.rows).toHaveLength(1);
		const chosen = await db.query<{ chosen_option: { status: string } }>(
			'SELECT chosen_option FROM task_comments WHERE id = $1',
			[commentId],
		);
		expect(chosen.rows[0].chosen_option.status).toBe('denied');
		const wakeup = await db.query<{ payload: { status: string } }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'comment_id' = $2
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, commentId],
		);
		expect(wakeup.rows[0].payload.status).toBe('denied');
	});

	it('approve deletes surviving assets, reports missing ones and clears mentions', async () => {
		const kept = await uploadAsset('deleted-uncov.png');
		const gone = await uploadAsset('pre-deleted-uncov.png');
		const commentId = await seedDeletionRequest([kept, gone]);

		// One asset disappears before the admin approves.
		await app.request(`/api/projects/${projectSlug}/assets/${gone.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});

		const res = await resolve(commentId, { approve: true });
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.status).toBe('approved');
		expect(body.deleted_asset_ids).toEqual([kept.id]);

		const rows = await db.query('SELECT 1 FROM assets WHERE id = $1', [kept.id]);
		expect(rows.rows).toHaveLength(0);

		const system = await db.query<{ content: { text: string } }>(
			`SELECT content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system' ORDER BY created_at DESC LIMIT 1`,
			[taskId],
		);
		expect(system.rows[0].content.text).toContain('1 deleted');
		expect(system.rows[0].content.text).toContain('1 no longer existed');

		const unread = await db.query(
			'SELECT 1 FROM admin_mentions WHERE comment_id = $1 AND read_at IS NULL',
			[commentId],
		);
		expect(unread.rows).toHaveLength(0);

		const wakeup = await db.query<{ payload: { status: string; deleted: string[] } }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'comment_id' = $2
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, commentId],
		);
		expect(wakeup.rows[0].payload.status).toBe('approved');
		expect(wakeup.rows[0].payload.deleted).toEqual([kept.path]);
	});
});
