import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;
let agentToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Cred Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main', description: 'Main project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Cred Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Need creds', assignee_id: agentId }),
	});
	issueId = (await issueRes.json()).data.id;

	const minted = await mintAgentToken(db, masterKeyManager, agentId, companyId);
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
			company_id: companyId,
			issue_id: issueId,
			name: 'lowercase_name',
			kind: 'api_key',
			instructions: 'test',
		})) as { error?: string };
		expect(result.error).toContain('[A-Z][A-Z0-9_]');
	});

	it('rejects name with hyphens or special chars', async () => {
		const result = (await callRequestCredential({
			company_id: companyId,
			issue_id: issueId,
			name: 'GITHUB-PAT',
			kind: 'api_key',
			instructions: 'test',
		})) as { error?: string };
		expect(result.error).toContain('[A-Z][A-Z0-9_]');
	});

	it('creates a credential_request comment and returns placeholder', async () => {
		const result = (await callRequestCredential({
			company_id: companyId,
			issue_id: issueId,
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
		}>('SELECT content_type, content FROM issue_comments WHERE id = $1', [result.comment_id]);
		expect(row.rows[0].content_type).toBe('credential_request');
		expect(row.rows[0].content.name).toBe('STRIPE_API_KEY');
		expect(row.rows[0].content.kind).toBe('api_key');
		expect(row.rows[0].content.allowed_hosts).toEqual(['api.stripe.com']);
		expect(row.rows[0].content.placeholder).toBe('__HEZO_SECRET_STRIPE_API_KEY__');
	});

	it('returns the existing comment on duplicate request (idempotent)', async () => {
		const first = (await callRequestCredential({
			company_id: companyId,
			issue_id: issueId,
			name: 'DUPLICATE_KEY',
			kind: 'api_key',
			instructions: 'test',
		})) as { comment_id: string; reused: boolean };
		expect(first.reused).toBe(false);

		const second = (await callRequestCredential({
			company_id: companyId,
			issue_id: issueId,
			name: 'DUPLICATE_KEY',
			kind: 'api_key',
			instructions: 'second call',
		})) as { comment_id: string; reused: boolean };
		expect(second.reused).toBe(true);
		expect(second.comment_id).toBe(first.comment_id);
	});

	it('rejects access from a different company', async () => {
		const otherCompanyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Co' }),
		});
		const otherCompanyId = (await otherCompanyRes.json()).data.id;

		const result = (await callRequestCredential({
			company_id: otherCompanyId,
			issue_id: issueId,
			name: 'CROSS_COMPANY',
			kind: 'api_key',
			instructions: 'test',
		})) as { error?: string };
		expect(result.error).toContain('Access denied');
	});
});

describe('fulfill-credential endpoint', () => {
	let credentialCommentId: string;

	it('creates a credential request to fulfill', async () => {
		const result = (await callRequestCredential({
			company_id: companyId,
			issue_id: issueId,
			name: 'FULFILL_TEST_KEY',
			kind: 'api_key',
			instructions: 'fulfill me',
			allowed_hosts: ['api.example.com'],
		})) as { comment_id: string };
		credentialCommentId = result.comment_id;
	});

	it('stores the value encrypted and grants access to the requesting agent', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);
		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${credentialCommentId}/fulfill-credential`,
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

		const grant = await db.query(
			'SELECT id FROM secret_grants WHERE secret_id = $1 AND member_id = $2',
			[body.data.secret_id, agentId],
		);
		expect(grant.rows.length).toBe(1);

		const updatedComment = await db.query<{ chosen_option: Record<string, unknown> }>(
			'SELECT chosen_option FROM issue_comments WHERE id = $1',
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
		expect(last.payload.issue_id).toBe(issueId);
	});

	it('rejects fulfilling the same comment twice', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${credentialCommentId}/fulfill-credential`,
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

	it('rejects fulfill on a non-credential-request comment', async () => {
		const textRes = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'text', content: { text: 'not a creq' } }),
		});
		const textComment = (await textRes.json()).data;

		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${textComment.id}/fulfill-credential`,
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
			company_id: companyId,
			issue_id: issueId,
			name: 'BAD_PAT_TEST',
			kind: 'github_pat',
			instructions: 'test',
		})) as { comment_id: string };

		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${reqResult.comment_id}/fulfill-credential`,
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
			company_id: companyId,
			issue_id: issueId,
			name: 'GOOD_PAT_TEST',
			kind: 'github_pat',
			instructions: 'test',
		})) as { comment_id: string };

		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${reqResult.comment_id}/fulfill-credential`,
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
			company_id: companyId,
			issue_id: issueId,
			name: 'CONFIRM_TEST',
			kind: 'other',
			instructions: 'Have you added the public key to GitHub?',
			confirmation_text: 'Yes, the key is added',
		})) as { comment_id: string };

		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${reqResult.comment_id}/fulfill-credential`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirmed: true }),
			},
		);
		expect(res.status).toBe(200);
	});
});
