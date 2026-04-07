import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { signAgentJwt, signBoardJwt } from '../../middleware/auth';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let superuserToken: string;
let masterKeyManager: MasterKeyManager;

// Company A
let companyAId: string;
let agentAId: string;
let agentAToken: string;
let projectAId: string;
let issueAId: string;
let secretAId: string;

// Company B
let companyBId: string;
let agentBId: string;
let agentBToken: string;

// Non-superuser board user (member of Company A only)
let userAToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	superuserToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(superuserToken),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	// Create Company A
	const companyARes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Company Alpha', template_id: typeId, issue_prefix: 'CA' }),
	});
	companyAId = (await companyARes.json()).data.id;

	// Create Company B
	const companyBRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Company Beta', template_id: typeId, issue_prefix: 'CB' }),
	});
	companyBId = (await companyBRes.json()).data.id;

	// Get agents
	const agentsARes = await app.request(`/api/companies/${companyAId}/agents`, {
		headers: authHeader(superuserToken),
	});
	agentAId = (await agentsARes.json()).data[0].id;
	agentAToken = await signAgentJwt(masterKeyManager, agentAId, companyAId);

	const agentsBRes = await app.request(`/api/companies/${companyBId}/agents`, {
		headers: authHeader(superuserToken),
	});
	agentBId = (await agentsBRes.json()).data[0].id;
	agentBToken = await signAgentJwt(masterKeyManager, agentBId, companyBId);

	// Create project in Company A
	const projectRes = await app.request(`/api/companies/${companyAId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Alpha Project' }),
	});
	projectAId = (await projectRes.json()).data.id;

	// Create issue in Company A
	const issueRes = await app.request(`/api/companies/${companyAId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectAId, title: 'Alpha Issue' }),
	});
	issueAId = (await issueRes.json()).data.id;

	// Create secret in Company A
	const secretRes = await app.request(`/api/companies/${companyAId}/secrets`, {
		method: 'POST',
		headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'ALPHA_SECRET', value: 'secret123', category: 'api_token' }),
	});
	secretAId = (await secretRes.json()).data.id;

	// Create a non-superuser who is a member of Company A only
	const userRes = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('User A', false) RETURNING id",
	);
	const userAId = userRes.rows[0].id;
	userAToken = await signBoardJwt(masterKeyManager, userAId);

	// Add User A as a member of Company A
	const memberRes = await db.query<{ id: string }>(
		`INSERT INTO members (company_id, display_name, member_type)
		 VALUES ($1, 'User A', 'user') RETURNING id`,
		[companyAId],
	);
	await db.query('INSERT INTO member_users (id, user_id) VALUES ($1, $2)', [
		memberRes.rows[0].id,
		userAId,
	]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('Agent token cross-company isolation', () => {
	it('agent A cannot access Company B agents', async () => {
		const res = await app.request(`/api/companies/${companyBId}/agents`, {
			headers: authHeader(agentAToken),
		});
		expect(res.status).toBe(403);
	});

	it('agent A cannot access Company B issues', async () => {
		const res = await app.request(`/api/companies/${companyBId}/issues`, {
			headers: authHeader(agentAToken),
		});
		expect(res.status).toBe(403);
	});

	it('agent A cannot access Company B secrets', async () => {
		const res = await app.request(`/api/companies/${companyBId}/secrets`, {
			headers: authHeader(agentAToken),
		});
		expect(res.status).toBe(403);
	});

	it('agent A cannot access Company B projects', async () => {
		const res = await app.request(`/api/companies/${companyBId}/projects`, {
			headers: authHeader(agentAToken),
		});
		expect(res.status).toBe(403);
	});

	it('agent B cannot access Company A agents', async () => {
		const res = await app.request(`/api/companies/${companyAId}/agents`, {
			headers: authHeader(agentBToken),
		});
		expect(res.status).toBe(403);
	});

	it('agent B cannot access Company A secrets', async () => {
		const res = await app.request(`/api/companies/${companyAId}/secrets`, {
			headers: authHeader(agentBToken),
		});
		expect(res.status).toBe(403);
	});

	it('agent B cannot create issues in Company A', async () => {
		const res = await app.request(`/api/companies/${companyAId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(agentBToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectAId, title: 'Unauthorized Issue' }),
		});
		expect(res.status).toBe(403);
	});
});

describe('Board user cross-company isolation', () => {
	it('user A (member of A only) cannot access Company B agents', async () => {
		const res = await app.request(`/api/companies/${companyBId}/agents`, {
			headers: authHeader(userAToken),
		});
		expect(res.status).toBe(403);
	});

	it('user A cannot access Company B issues', async () => {
		const res = await app.request(`/api/companies/${companyBId}/issues`, {
			headers: authHeader(userAToken),
		});
		expect(res.status).toBe(403);
	});

	it('user A cannot access Company B secrets', async () => {
		const res = await app.request(`/api/companies/${companyBId}/secrets`, {
			headers: authHeader(userAToken),
		});
		expect(res.status).toBe(403);
	});

	it('user A cannot access Company B projects', async () => {
		const res = await app.request(`/api/companies/${companyBId}/projects`, {
			headers: authHeader(userAToken),
		});
		expect(res.status).toBe(403);
	});

	it('user A cannot create issues in Company B', async () => {
		const res = await app.request(`/api/companies/${companyBId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(userAToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Unauthorized Issue' }),
		});
		expect(res.status).toBe(403);
	});

	it('user A can access Company A resources', async () => {
		const res = await app.request(`/api/companies/${companyAId}/agents`, {
			headers: authHeader(userAToken),
		});
		expect(res.status).toBe(200);
	});

	it('user A can access Company A issues', async () => {
		const res = await app.request(`/api/companies/${companyAId}/issues`, {
			headers: authHeader(userAToken),
		});
		expect(res.status).toBe(200);
	});
});

describe('Superuser cross-company access', () => {
	it('superuser can access Company A', async () => {
		const res = await app.request(`/api/companies/${companyAId}/agents`, {
			headers: authHeader(superuserToken),
		});
		expect(res.status).toBe(200);
	});

	it('superuser can access Company B', async () => {
		const res = await app.request(`/api/companies/${companyBId}/agents`, {
			headers: authHeader(superuserToken),
		});
		expect(res.status).toBe(200);
	});
});

describe('API key cross-company isolation', () => {
	let apiKeyA: string;
	let apiKeyB: string;

	beforeAll(async () => {
		const resA = await app.request(`/api/companies/${companyAId}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'key-a' }),
		});
		apiKeyA = (await resA.json()).data.key;

		const resB = await app.request(`/api/companies/${companyBId}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(superuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'key-b' }),
		});
		apiKeyB = (await resB.json()).data.key;
	});

	it('API key A cannot access Company B', async () => {
		const res = await app.request(`/api/companies/${companyBId}/agents`, {
			headers: authHeader(apiKeyA),
		});
		expect(res.status).toBe(403);
	});

	it('API key B cannot access Company A', async () => {
		const res = await app.request(`/api/companies/${companyAId}/agents`, {
			headers: authHeader(apiKeyB),
		});
		expect(res.status).toBe(403);
	});

	it('API key A can access Company A', async () => {
		const res = await app.request(`/api/companies/${companyAId}/agents`, {
			headers: authHeader(apiKeyA),
		});
		expect(res.status).toBe(200);
	});

	it('API key B can access Company B', async () => {
		const res = await app.request(`/api/companies/${companyBId}/agents`, {
			headers: authHeader(apiKeyB),
		});
		expect(res.status).toBe(200);
	});
});

describe('Resource ownership isolation', () => {
	it('Company B agent cannot access Company A issue via Company A routes', async () => {
		// Agent B is scoped to Company B, so accessing Company A returns 403
		const res = await app.request(`/api/companies/${companyAId}/issues/${issueAId}`, {
			headers: authHeader(agentBToken),
		});
		expect(res.status).toBe(403);
	});

	it('Company A issue not found under Company B routes', async () => {
		// Even with superuser, issue A doesn't belong to Company B
		const res = await app.request(`/api/companies/${companyBId}/issues/${issueAId}`, {
			headers: authHeader(superuserToken),
		});
		// Returns 404 because WHERE clause filters by company_id
		expect(res.status).toBe(404);
	});

	it('Company A secret not found under Company B routes', async () => {
		const res = await app.request(`/api/companies/${companyBId}/secrets/${secretAId}`, {
			method: 'DELETE',
			headers: authHeader(superuserToken),
		});
		expect(res.status).toBe(404);
	});

	it('Agent A accessing own company issue succeeds', async () => {
		const res = await app.request(`/api/companies/${companyAId}/issues/${issueAId}`, {
			headers: authHeader(agentAToken),
		});
		expect(res.status).toBe(200);
	});
});
