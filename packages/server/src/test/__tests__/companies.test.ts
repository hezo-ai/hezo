import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let builtinTypeId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Get the built-in type ID for company creation
	const res = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const types = (await res.json()).data;
	builtinTypeId = types.find((t: any) => t.name === 'Startup').id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('companies CRUD', () => {
	it('creates a company from built-in template with auto-created agents and KB docs', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'NoteGenius AI',
				description: 'Build the #1 AI note-taking app',
				template_id: builtinTypeId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('NoteGenius AI');
		expect(body.data.slug).toBe('notegenius-ai');
		expect(body.data.issue_prefix).toBe('NA');
		expect(body.data.agent_count).toBe(10);

		const kbRes = await app.request(`/api/companies/${body.data.id}/kb-docs`, {
			headers: authHeader(token),
		});
		const kbBody = await kbRes.json();
		expect(kbBody.data.length).toBe(4);
		const slugs = kbBody.data.map((d: any) => d.slug).sort();
		expect(slugs).toEqual([
			'architecture-guidelines',
			'code-review-standards',
			'company-overview',
			'development-workflow',
		]);
	});

	it('creates a company without a type', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Solo Project',
				issue_prefix: 'SOLO',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.issue_prefix).toBe('SOLO');
		expect(body.data.agent_count).toBe(0);
	});

	it('rejects duplicate issue prefix', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Another Company',
				issue_prefix: 'SOLO',
			}),
		});
		expect(res.status).toBe(409);
	});

	it('lists companies with counts', async () => {
		const res = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data[0]).toHaveProperty('agent_count');
		expect(body.data[0]).toHaveProperty('open_issue_count');
	});

	it('gets a company by id', async () => {
		const listRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		const companies = (await listRes.json()).data;
		const id = companies[0].id;

		const res = await app.request(`/api/companies/${id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(id);
	});

	it('updates a company', async () => {
		const listRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		const company = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${company.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Updated description' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.description).toBe('Updated description');
	});

	it('deletes a company', async () => {
		// Create a throwaway company
		const createRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'To Delete', issue_prefix: 'DEL' }),
		});
		const created = (await createRes.json()).data;

		const res = await app.request(`/api/companies/${created.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const getRes = await app.request(`/api/companies/${created.id}`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('generates unique slugs for same-named companies', async () => {
		const res1 = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Duplicate Name', issue_prefix: 'DN1' }),
		});
		const res2 = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Duplicate Name', issue_prefix: 'DN2' }),
		});
		expect(res1.status).toBe(201);
		expect(res2.status).toBe(201);
		const slug1 = (await res1.json()).data.slug;
		const slug2 = (await res2.json()).data.slug;
		expect(slug1).toBe('duplicate-name');
		expect(slug2).toBe('duplicate-name-2');
	});

	it('auto-derives issue prefix from company name', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Acme Corp Industries' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.issue_prefix).toBe('ACI');
	});
});

describe('template-based company creation', () => {
	it('creates agents from a custom template', async () => {
		const agentTypesRes = await app.request('/api/agent-types', {
			headers: authHeader(token),
		});
		const agentTypes = (await agentTypesRes.json()).data;
		const ceo = agentTypes.find((a: any) => a.slug === 'ceo');
		const researcher = agentTypes.find((a: any) => a.slug === 'researcher');

		const typeRes = await app.request('/api/company-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Research Lab',
				description: 'Research-focused team',
				agent_types: [
					{ agent_type_id: ceo.id, reports_to_slug: 'board', sort_order: 0 },
					{ agent_type_id: researcher.id, reports_to_slug: 'ceo', sort_order: 1 },
				],
			}),
		});
		expect(typeRes.status).toBe(201);
		const templateId = (await typeRes.json()).data.id;

		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Research Co',
				issue_prefix: 'RES',
				template_id: templateId,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(2);
	});

	it('creates no agents without a template', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Blank Co',
				issue_prefix: 'BLK',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.agent_count).toBe(0);
	});

	it('populates company_team_types join table', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Join Table Co',
				issue_prefix: 'JTC',
				template_id: builtinTypeId,
			}),
		});
		expect(res.status).toBe(201);
		const companyId = (await res.json()).data.id;

		const joinRows = await db.query('SELECT * FROM company_team_types WHERE company_id = $1', [
			companyId,
		]);
		expect(joinRows.rows.length).toBe(1);
	});

	it('creates KB docs from template with kb_docs_config', async () => {
		const typeRes = await app.request('/api/company-types', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Docs Template',
				description: 'Template with KB docs',
				kb_docs_config: [
					{
						title: 'Getting Started',
						slug: 'getting-started',
						content: '# Getting Started\n\nWelcome!',
					},
					{ title: 'API Guide', slug: 'api-guide', content: '# API Guide\n\nEndpoints...' },
				],
			}),
		});
		expect(typeRes.status).toBe(201);
		const templateId = (await typeRes.json()).data.id;

		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Docs Co',
				issue_prefix: 'DOC',
				template_id: templateId,
			}),
		});
		expect(res.status).toBe(201);
		const companyId = (await res.json()).data.id;

		const kbRes = await app.request(`/api/companies/${companyId}/kb-docs`, {
			headers: authHeader(token),
		});
		const kbBody = await kbRes.json();
		expect(kbBody.data.length).toBe(2);
		expect(kbBody.data.map((d: any) => d.slug).sort()).toEqual(['api-guide', 'getting-started']);
	});

	it('creates no KB docs when template has empty kb_docs_config', async () => {
		const res = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'No Docs Co',
				issue_prefix: 'NDC',
				template_id: builtinTypeId,
			}),
		});
		expect(res.status).toBe(201);
		const companyId = (await res.json()).data.id;

		const kbRes = await app.request(`/api/companies/${companyId}/kb-docs`, {
			headers: authHeader(token),
		});
		const kbBody = await kbRes.json();
		// Builtin template has KB docs configured in seed
		expect(kbBody.data.length).toBe(4);
	});
});

describe('slug-based access', () => {
	it('gets a company by slug', async () => {
		const listRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		const companies = (await listRes.json()).data;
		const company = companies.find((c: any) => c.slug === 'notegenius-ai');

		const res = await app.request(`/api/companies/${company.slug}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(company.id);
		expect(body.data.slug).toBe('notegenius-ai');
	});

	it('returns 404 for non-existent slug', async () => {
		const res = await app.request('/api/companies/nonexistent-slug', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('accesses company sub-resources via slug', async () => {
		const listRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		const companies = (await listRes.json()).data;
		const company = companies.find((c: any) => c.slug === 'notegenius-ai');

		const agentsRes = await app.request(`/api/companies/${company.slug}/agents`, {
			headers: authHeader(token),
		});
		expect(agentsRes.status).toBe(200);
		const agentsBody = await agentsRes.json();
		expect(agentsBody.data.length).toBe(10);
	});
});
