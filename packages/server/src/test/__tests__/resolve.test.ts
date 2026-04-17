import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCompanyId, resolveProjectId } from '../../lib/resolve';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let companySlug: string;
let projectId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Resolve Test Co', template_id: typeId, issue_prefix: 'RTC' }),
	});
	const companyData = (await companyRes.json()).data;
	companyId = companyData.id;
	companySlug = companyData.slug;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Resolve Project', description: 'Test project.' }),
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('resolveCompanyId', () => {
	it('returns UUID directly when given a valid UUID', async () => {
		const result = await resolveCompanyId(db, companyId);
		expect(result).toBe(companyId);
	});

	it('resolves slug to UUID', async () => {
		const result = await resolveCompanyId(db, companySlug);
		expect(result).toBe(companyId);
	});

	it('returns null for non-existent slug', async () => {
		const result = await resolveCompanyId(db, 'nonexistent-company');
		expect(result).toBeNull();
	});

	it('returns raw UUID even if company does not exist', async () => {
		const fakeUuid = '00000000-0000-0000-0000-000000000099';
		const result = await resolveCompanyId(db, fakeUuid);
		expect(result).toBe(fakeUuid);
	});
});

describe('resolveProjectId', () => {
	it('returns UUID directly when given a valid UUID', async () => {
		const result = await resolveProjectId(db, companyId, projectId);
		expect(result).toBe(projectId);
	});

	it('resolves slug to UUID', async () => {
		const result = await resolveProjectId(db, companyId, projectSlug);
		expect(result).toBe(projectId);
	});

	it('returns null for non-existent slug', async () => {
		const result = await resolveProjectId(db, companyId, 'nonexistent-project');
		expect(result).toBeNull();
	});

	it('returns null when project slug belongs to different company', async () => {
		const fakeCompany = '00000000-0000-0000-0000-000000000099';
		const result = await resolveProjectId(db, fakeCompany, projectSlug);
		expect(result).toBeNull();
	});

	it('returns raw UUID even if project does not exist', async () => {
		const fakeUuid = '00000000-0000-0000-0000-000000000088';
		const result = await resolveProjectId(db, companyId, fakeUuid);
		expect(result).toBe(fakeUuid);
	});
});
