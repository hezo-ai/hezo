import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { createConnection } from '../src/services/oauth/connection-store';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let agentToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Cred Co' });
	const team = (await teamRes.json()).data;
	teamId = team.id;
	teamSlug = team.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Main project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentRes = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Cred Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Need creds', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;

	const minted = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
	agentToken = minted.token;
});

afterAll(async () => {
	await safeClose(db);
});

async function callRequestCredential(args: Record<string, unknown>): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: 'request_credential', arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
}

describe('request_credential MCP tool', () => {
	it('rejects invalid name', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'lowercase_name',
			kind: 'api_key',
			instructions: 'test',
		})) as { error?: string };
		expect(result.error).toContain('[A-Z][A-Z0-9_]');
	});

	it('rejects name with hyphens or special chars', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'GITHUB-PAT',
			kind: 'api_key',
			instructions: 'test',
		})) as { error?: string };
		expect(result.error).toContain('[A-Z][A-Z0-9_]');
	});

	it('creates a credential_request comment and returns placeholder', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'STRIPE_API_KEY',
			kind: 'api_key',
			instructions: 'I need a Stripe API key with read scope.',
			allowed_hosts: ['api.stripe.com'],
		})) as { placeholder?: string; comment_id?: string; status?: string; reused?: boolean };

		expect(result.placeholder).toBe('__HEZO_SECRET_STRIPE_API_KEY__');
		expect(result.status).toBe('pending');
		expect(result.reused).toBe(false);
		expect(result.comment_id).toBeTruthy();

		const row = await db.query<{
			content_type: string;
			content: Record<string, unknown>;
		}>('SELECT content_type, content FROM task_comments WHERE id = $1', [result.comment_id]);
		expect(row.rows[0].content_type).toBe('credential_request');
		expect(row.rows[0].content.name).toBe('STRIPE_API_KEY');
		expect(row.rows[0].content.kind).toBe('api_key');
		expect(row.rows[0].content.allowed_hosts).toEqual(['api.stripe.com']);
		expect(row.rows[0].content.placeholder).toBe('__HEZO_SECRET_STRIPE_API_KEY__');
		// Not requested → defaults to false in the stored content.
		expect(row.rows[0].content.allow_body_substitution).toBe(false);
	});

	it('records a requested allow_body_substitution in the comment content', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'UMAMI_LOGIN_PW',
			kind: 'other',
			instructions: 'Umami login password (sent in the login POST body).',
			allowed_hosts: ['umami.example'],
			allow_body_substitution: true,
		})) as { comment_id?: string };
		const row = await db.query<{ content: Record<string, unknown> }>(
			'SELECT content FROM task_comments WHERE id = $1',
			[result.comment_id],
		);
		expect(row.rows[0].content.allow_body_substitution).toBe(true);
	});

	it('returns the existing comment on duplicate request (idempotent)', async () => {
		const first = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'DUPLICATE_KEY',
			kind: 'api_key',
			instructions: 'test',
			allowed_hosts: ['api.example.com'],
		})) as { comment_id: string; reused: boolean };
		expect(first.reused).toBe(false);

		const second = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'DUPLICATE_KEY',
			kind: 'api_key',
			instructions: 'second call',
			allowed_hosts: ['api.example.com'],
		})) as { comment_id: string; reused: boolean };
		expect(second.reused).toBe(true);
		expect(second.comment_id).toBe(first.comment_id);
	});

	it('rejects access from a different team', async () => {
		const otherTeamRes = await createTestTeam(db, { name: 'Other Co' });
		const otherTeamId = (await otherTeamRes.json()).data.id;
		const otherProject = (
			await (await createTestProject(db, otherTeamId, { name: 'Other Main' })).json()
		).data;

		const result = (await callRequestCredential({
			project: otherProject.id,
			task_id: taskId,
			name: 'CROSS_TEAM',
			kind: 'api_key',
			instructions: 'test',
		})) as { error?: string };
		expect(result.error).toContain('Access denied');
	});

	it('rejects an api_key request with no allowed_hosts', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'UNSCOPED_API_KEY',
			kind: 'api_key',
			instructions: 'I need a key',
		})) as { error?: string; comment_id?: string };
		expect(result.error).toContain('allowed_hosts');
		expect(result.comment_id).toBeUndefined();

		// The rejected request must not have created a comment.
		const rows = await db.query(
			"SELECT id FROM task_comments WHERE task_id = $1 AND content->>'name' = $2",
			[taskId, 'UNSCOPED_API_KEY'],
		);
		expect(rows.rows.length).toBe(0);
	});

	it('rejects an api_key request with an empty allowed_hosts array', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'EMPTY_HOSTS_KEY',
			kind: 'api_key',
			instructions: 'I need a key',
			allowed_hosts: [],
		})) as { error?: string };
		expect(result.error).toContain('allowed_hosts');
	});

	it('rejects oauth_token and github_pat requests with no allowed_hosts', async () => {
		const oauth = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'UNSCOPED_OAUTH',
			kind: 'oauth_token',
			instructions: 'token',
		})) as { error?: string };
		expect(oauth.error).toContain('allowed_hosts');

		const pat = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'UNSCOPED_PAT',
			kind: 'github_pat',
			instructions: 'pat',
		})) as { error?: string };
		expect(pat.error).toContain('allowed_hosts');
	});

	it('allows an ssh_private_key request with no allowed_hosts (exempt)', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'DEPLOY_SSH_KEY',
			kind: 'ssh_private_key',
			instructions: 'paste your deploy key',
		})) as { error?: string; comment_id?: string; status?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('pending');
		expect(result.comment_id).toBeTruthy();
	});

	it('allows a confirmation-style api_key request with no allowed_hosts', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'CONFIRM_NO_HOSTS',
			kind: 'api_key',
			instructions: 'Did you rotate the key?',
			confirmation_text: 'Yes, rotated',
		})) as { error?: string; comment_id?: string };
		expect(result.error).toBeUndefined();
		expect(result.comment_id).toBeTruthy();
	});
});

describe('fulfill-credential endpoint', () => {
	let credentialCommentId: string;

	it('creates a credential request to fulfill', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'FULFILL_TEST_KEY',
			kind: 'api_key',
			instructions: 'fulfill me',
			allowed_hosts: ['api.example.com'],
		})) as { comment_id: string };
		credentialCommentId = result.comment_id;
	});

	it('stores the value encrypted as a global secret', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${credentialCommentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'sk-secret-value-123' }),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.secret_id).toBeTruthy();

		const secretRow = await db.query<{
			encrypted_value: string;
			category: string;
			allowed_hosts: string[];
		}>('SELECT encrypted_value, category, allowed_hosts FROM secrets WHERE id = $1', [
			body.data.secret_id,
		]);
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('no master key');
		expect(decrypt(secretRow.rows[0].encrypted_value, key)).toBe('sk-secret-value-123');
		expect(secretRow.rows[0].category).toBe('credential');
		expect(secretRow.rows[0].allowed_hosts).toEqual(['api.example.com']);

		const updatedComment = await db.query<{ chosen_option: Record<string, unknown> }>(
			'SELECT chosen_option FROM task_comments WHERE id = $1',
			[credentialCommentId],
		);
		expect(updatedComment.rows[0].chosen_option.secret_id).toBe(body.data.secret_id);
	});

	it('fires a credential_provided wakeup for the requesting agent', async () => {
		const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
			"SELECT source::text AS source, payload FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'credential_provided'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
		const last = wakeups.rows[wakeups.rows.length - 1];
		expect(last.payload.name).toBe('FULFILL_TEST_KEY');
		expect(last.payload.task_id).toBe(taskId);
	});

	it('rejects fulfilling the same comment twice', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${credentialCommentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'different-value' }),
			},
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('already fulfilled');
	});

	it('lets the human set allowed_hosts at fulfillment for an unscoped request', async () => {
		// Exempt kind (other) can be requested with no hosts, leaving it
		// undeliverable. The human scopes it when pasting the value.
		const created = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'FULFILL_HOST_OVERRIDE',
			kind: 'other',
			instructions: 'paste and scope me',
		})) as { comment_id: string };

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${created.comment_id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					value: 'tok-123',
					allowed_hosts: ['API.NETLIFY.COM', ' app.netlify.com '],
				}),
			},
		);
		expect(res.status).toBe(200);
		const secretId = (await res.json()).data.secret_id;

		const secretRow = await db.query<{ allowed_hosts: string[] }>(
			'SELECT allowed_hosts FROM secrets WHERE id = $1',
			[secretId],
		);
		// Normalized (trimmed + lowercased) and applied over the empty request.
		expect(secretRow.rows[0].allowed_hosts).toEqual(['api.netlify.com', 'app.netlify.com']);
	});

	it('defaults allow_body_substitution from the agent request when fulfilling', async () => {
		const created = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'FULFILL_BODY_DEFAULT',
			kind: 'other',
			instructions: 'login password',
			allowed_hosts: ['umami.example'],
			allow_body_substitution: true,
		})) as { comment_id: string };

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${created.comment_id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				// No explicit flag in the body → the agent's request stands.
				body: JSON.stringify({ value: 'pw-123' }),
			},
		);
		expect(res.status).toBe(200);
		const secretId = (await res.json()).data.secret_id;
		const row = await db.query<{ allow_body_substitution: boolean }>(
			'SELECT allow_body_substitution FROM secrets WHERE id = $1',
			[secretId],
		);
		expect(row.rows[0].allow_body_substitution).toBe(true);
	});

	it('lets the human decline body substitution the agent requested', async () => {
		const created = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'FULFILL_BODY_DECLINED',
			kind: 'other',
			instructions: 'login password',
			allowed_hosts: ['umami.example'],
			allow_body_substitution: true,
		})) as { comment_id: string };

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${created.comment_id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				// Human unchecked the box → explicit false overrides the request.
				body: JSON.stringify({ value: 'pw-123', allow_body_substitution: false }),
			},
		);
		expect(res.status).toBe(200);
		const secretId = (await res.json()).data.secret_id;
		const row = await db.query<{ allow_body_substitution: boolean }>(
			'SELECT allow_body_substitution FROM secrets WHERE id = $1',
			[secretId],
		);
		expect(row.rows[0].allow_body_substitution).toBe(false);
	});

	it('rejects fulfill on a non-credential-request comment', async () => {
		const textRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'text', content: { text: 'not a creq' } }),
		});
		const textComment = (await textRes.json()).data;

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${textComment.id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'x' }),
			},
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('not a credential request');
	});

	it('rejects bad GitHub PAT format', async () => {
		const reqResult = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'BAD_PAT_TEST',
			kind: 'github_pat',
			instructions: 'test',
			allowed_hosts: ['api.github.com'],
		})) as { comment_id: string };

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${reqResult.comment_id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'not-a-real-pat-format' }),
			},
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.message).toContain('GitHub PAT');
	});

	it('accepts a well-formed classic GitHub PAT', async () => {
		const reqResult = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'GOOD_PAT_TEST',
			kind: 'github_pat',
			instructions: 'test',
			allowed_hosts: ['api.github.com'],
		})) as { comment_id: string };

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${reqResult.comment_id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: `ghp_${'a'.repeat(36)}` }),
			},
		);
		expect(res.status).toBe(200);
	});

	it('fulfills a confirmation-style request with confirmed=true', async () => {
		const reqResult = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'CONFIRM_TEST',
			kind: 'other',
			instructions: 'Have you added the public key to GitHub?',
			confirmation_text: 'Yes, the key is added',
		})) as { comment_id: string };

		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${reqResult.comment_id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirmed: true }),
			},
		);
		expect(res.status).toBe(200);
	});
});

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
}

describe('list_connectors rest_auth', () => {
	it('exposes an active OAuth connector REST placeholder scoped to its allowed hosts', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'github',
				providerAccountId: 'acct-1',
				providerAccountLabel: 'octocat',
				accessToken: 'gho_realsecret',
				scopes: ['repo'],
				allowedHosts: ['api.github.com', 'github.com'],
			},
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id, activated_at, install_status)
			 VALUES ('github', 'saas', '{}'::jsonb, $1, now(), 'installed')`,
			[conn.id],
		);

		const rows = (
			(await callTool('list_connectors', { project: projectId })) as {
				items: Array<{
					name: string;
					oauth_status: string;
					rest_auth: { placeholder: string; allowed_hosts: string[]; scopes: string[] } | null;
				}>;
			}
		).items;
		const gh = rows.find((row) => row.name === 'github');
		expect(gh?.oauth_status).toBe('active');
		expect(gh?.rest_auth?.placeholder).toBe(`__HEZO_SECRET_${conn.accessTokenSecretName}__`);
		expect(gh?.rest_auth?.allowed_hosts).toContain('api.github.com');
		expect(gh?.rest_auth?.scopes).toContain('repo');
		// The raw token value is never returned anywhere in the payload.
		expect(JSON.stringify(rows)).not.toContain('gho_realsecret');
	});

	it('surfaces a broker-managed OAuth token via api_auth for an OAuth-backed api connector', async () => {
		// The generic OAuth broker links the fresh access token to an `api`
		// connector; list_connectors must surface its placeholder via api_auth even
		// though api rows report oauth_status="none".
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				provider: 'google-youtube',
				providerAccountId: 'yt-acct',
				providerAccountLabel: 'YouTube',
				accessToken: 'ya29.brokersecret',
				refreshToken: '1//refresh',
				scopes: ['https://www.googleapis.com/auth/youtube'],
				expiresAt: new Date(Date.now() + 3_600_000),
				allowedHosts: ['*.googleapis.com'],
				clientSecret: 'GOCSPX-secret',
				metadata: { token_url: 'https://oauth2.googleapis.com/token', client_id: 'gcid' },
			},
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id, activated_at, install_status)
			 VALUES ('youtube', 'api', $1::jsonb, $2, now(), 'installed')`,
			[
				JSON.stringify({
					base_url: 'https://www.googleapis.com',
					allowed_hosts: ['*.googleapis.com'],
					auth: { placement: 'header', name: 'Authorization', scheme: 'Bearer ' },
					docs_url: 'https://developers.google.com/youtube/v3',
				}),
				conn.id,
			],
		);

		const rows = (
			(await callTool('list_connectors', { project: projectId })) as {
				items: Array<{
					name: string;
					oauth_status: string;
					api_auth: {
						base_url: string | null;
						placeholder: string | null;
						allowed_hosts: string[];
						placement: string | null;
						name: string | null;
					} | null;
				}>;
			}
		).items;
		const yt = rows.find((row) => row.name === 'youtube');
		// api rows report oauth_status="none" (that field is saas-only) …
		expect(yt?.oauth_status).toBe('none');
		// … but the broker-managed OAuth access token surfaces via api_auth.
		expect(yt?.api_auth?.placeholder).toBe(`__HEZO_SECRET_${conn.accessTokenSecretName}__`);
		expect(yt?.api_auth?.base_url).toBe('https://www.googleapis.com');
		expect(yt?.api_auth?.placement).toBe('header');
		expect(yt?.api_auth?.name).toBe('Authorization');
		// Neither the access token nor the host-only client secret ever appears.
		expect(JSON.stringify(rows)).not.toContain('ya29.brokersecret');
		expect(JSON.stringify(rows)).not.toContain('GOCSPX-secret');
	});
});

describe('credential requests in the admin inbox', () => {
	let commentId: string;

	it('raises an unread inbox row for the admin when the request is filed', async () => {
		const result = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'INBOX_ROW_KEY',
			kind: 'api_key',
			instructions: 'Paste the key from the provider dashboard.',
			allowed_hosts: ['api.example.com'],
		})) as { comment_id: string };
		commentId = result.comment_id;

		// Nothing in the comment says "@admin" — it reaches the inbox because
		// request_credential fans it out, the way an @admin mention does.
		const rows = await db.query<{ user_id: string; read_at: string | null }>(
			'SELECT user_id, read_at FROM admin_mentions WHERE comment_id = $1',
			[commentId],
		);
		expect(rows.rows.length).toBeGreaterThanOrEqual(1);
		expect(rows.rows.every((r) => r.read_at === null)).toBe(true);

		const inbox = await app.request(`/api/projects/${projectSlug}/inbox/mentions`, {
			headers: authHeader(token),
		});
		const items = (await inbox.json()).data as Array<{
			comment_id: string;
			content_type: string;
			credential_name: string | null;
			snippet: string;
		}>;
		const row = items.find((i) => i.comment_id === commentId);
		expect(row?.content_type).toBe('credential_request');
		expect(row?.credential_name).toBe('INBOX_ROW_KEY');
		expect(row?.snippet).toContain('Paste the key');
	});

	it('re-asking for the same credential does not duplicate the inbox row', async () => {
		const again = (await callRequestCredential({
			project: projectId,
			task_id: taskId,
			name: 'INBOX_ROW_KEY',
			kind: 'api_key',
			instructions: 'Still waiting on this one.',
			allowed_hosts: ['api.example.com'],
		})) as { comment_id: string; reused: boolean };
		expect(again.reused).toBe(true);
		expect(again.comment_id).toBe(commentId);

		const rows = await db.query<{ count: number }>(
			'SELECT count(*)::int AS count FROM admin_mentions WHERE comment_id = $1',
			[commentId],
		);
		expect(rows.rows[0].count).toBeGreaterThanOrEqual(1);
		const perUser = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM (
			   SELECT user_id FROM admin_mentions WHERE comment_id = $1 GROUP BY user_id HAVING count(*) > 1
			 ) dupes`,
			[commentId],
		);
		expect(perUser.rows[0].count).toBe(0);
	});

	it('providing the value marks the inbox row read for every admin', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'sk-inbox-row' }),
			},
		);
		expect(res.status).toBe(200);

		const rows = await db.query<{ read_at: string | null }>(
			'SELECT read_at FROM admin_mentions WHERE comment_id = $1',
			[commentId],
		);
		expect(rows.rows.length).toBeGreaterThanOrEqual(1);
		expect(rows.rows.every((r) => r.read_at !== null)).toBe(true);

		// Off the dashboard, still in the inbox under Read.
		const needsYou = await app.request(`/api/projects/${projectSlug}/inbox/needs-you`, {
			headers: authHeader(token),
		});
		const items = ((await needsYou.json()).data as { items: unknown[] }).items;
		expect(JSON.stringify(items)).not.toContain('INBOX_ROW_KEY');
	});
});
